/* =========================================================
   Audio Extender — audio engine (runs in the page's MAIN world)

   - Routes <audio>/<video> elements through our own AudioContext.
   - Redirects the page's own AudioContexts (games, web players)
     by intercepting connections to `destination`.
   - Every context gets one processing Chain (content/chain.js).
   - Media elements are only hooked when processing is actually needed,
     and never when that would silence them (cross-origin without CORS,
     DRM-protected media, or an AudioContext that is not allowed to start yet).

   Talks to content.js through JSON strings in CustomEvents.
   ========================================================= */
(() => {
  'use strict';

  const NativeAC = window.AudioContext;
  const createChainKit = window.__audioExtenderChain; // content/chain.js, loaded just before
  if (!NativeAC || window.__audioExtenderEngine || !createChainKit) return;
  delete window.__audioExtenderChain; // keep it away from page scripts
  Object.defineProperty(window, '__audioExtenderEngine', { value: true });

  const TO_PAGE = 'audio-extender:to-page';
  const TO_CONTENT = 'audio-extender:to-content';
  const PROTOCOL = 2; // keep in sync with AE.PROTOCOL in shared/settings.js

  const origConnect = AudioNode.prototype.connect;
  const origDisconnect = AudioNode.prototype.disconnect;
  const OfflineAC = window.OfflineAudioContext;

  let S = null;          // effective settings from the extension
  let active = false;    // settings actually change the sound
  let duck = 1;          // attenuation requested by "lower other tabs"
  let ownCtx = null;
  const chains = new Map();          // AudioContext -> Chain
  const media = new Set();           // media elements seen on the page
  const hooked = new WeakMap();      // element -> MediaElementAudioSourceNode
  const blocked = new WeakSet();     // elements we must never touch: DRM, or captured by the page itself
  const foreign = new WeakSet();     // current source is cross-origin without CORS — re-checked when the source changes
  let speedApplied = false;
  const started = new WeakMap();     // element -> when its media last (re)started: our speed wins shortly after
  const resets = new WeakMap();      // element -> how often we re-applied the speed since then
  let sink = '';                     // output device for this tab ('' = default), set by content.js once usable here
  const sunk = new WeakSet();        // unhooked elements we moved to `sink` with el.setSinkId
  const unsinking = new WeakSet();   // being moved back to the default device before hooking
  // Media is routed through our chain when the sound must change, or when the tab plays on another device:
  // then the chain carries the device, one place for every source it can take.
  const route = () => active || !!sink;

  const { Chain } = createChainKit({ get S() { return S; }, get active() { return active; }, get duck() { return duck; } });


  function chainFor(ctx) {
    let ch = chains.get(ctx);
    if (!ch) {
      ch = new Chain(ctx);
      chains.set(ctx, ch);
      ch.onSinkLost = () => sinkFailed('lost');
      if (sink) sinkChain(ch);
    }
    return ch;
  }

  /* ---------------------------------------------------------
     Page AudioContexts: redirect `destination` into our chain
     --------------------------------------------------------- */
  const isLiveDestination = (n) =>
    n instanceof AudioDestinationNode && !(OfflineAC && n.context instanceof OfflineAC);

  AudioNode.prototype.connect = function (dest, ...rest) {
    if (isLiveDestination(dest)) {
      try {
        origConnect.call(this, chainFor(dest.context).input, ...rest);
        return dest;
      } catch { /* fall through to the original behaviour */ }
    }
    return origConnect.call(this, dest, ...rest);
  };

  AudioNode.prototype.disconnect = function (dest, ...rest) {
    if (isLiveDestination(dest)) {
      const ch = chains.get(dest.context);
      if (ch) return origDisconnect.call(this, ch.input, ...rest);
    }
    return origDisconnect.apply(this, arguments);
  };

  /* ---------------------------------------------------------
     Media elements
     --------------------------------------------------------- */
  function track(el) {
    if (!(el instanceof HTMLMediaElement) || media.has(el)) return;
    media.add(el);
    applySpeed(el);
    sinkElement(el);
    el.addEventListener('loadedmetadata', () => { started.set(el, performance.now()); applySpeed(el); });
    // Players often start with a cross-origin URL and then switch the same element to blob: (MSE/HLS).
    el.addEventListener('loadstart', () => { started.set(el, performance.now()); resets.delete(el); if (foreign.delete(el)) report(); });
    el.addEventListener('play', () => started.set(el, performance.now()));
    el.addEventListener('ratechange', () => guardRate(el));
  }

  /** createMediaElementSource outputs silence for DRM media and for cross-origin media without CORS — never do that. */
  function safeToHook(el) {
    if (el.mediaKeys) return false;
    if (el.srcObject) return true;
    const src = el.currentSrc || el.src;
    if (!src) return true;
    try {
      const u = new URL(src, location.href);
      if (u.protocol === 'blob:' || u.protocol === 'data:') return true;
      if (u.origin === location.origin) return true;
      return el.crossOrigin !== null; // loaded in CORS mode — the server allowed it
    } catch {
      return false;
    }
  }

  function getOwnCtx() {
    if (!ownCtx) {
      ownCtx = new NativeAC();
      chainFor(ownCtx);
      // A new context starts 'suspended' and switches to 'running' asynchronously (autoplay policy),
      // and even then the audio device may need a moment before it renders anything.
      ownCtx.addEventListener('statechange', () => { if (ownCtx.state === 'running') whenRendering(hookAll); });
    }
    return ownCtx;
  }

  /** True once the context actually produces sound: its clock only advances while the device renders. */
  const rendering = (ctx) => ctx.state === 'running' && ctx.currentTime > 0.05;
  let renderWait = 0;
  function whenRendering(cb) {
    if (rendering(ownCtx)) { cb(); return; }
    if (renderWait) return;
    const started = performance.now();
    const tick = () => {
      if (rendering(ownCtx)) { renderWait = 0; cb(); }
      else if (ownCtx.state === 'running' && performance.now() - started < 10000) renderWait = setTimeout(tick, 40);
      else renderWait = 0;
    };
    renderWait = setTimeout(tick, 40);
  }

  let waitingGesture = false;
  function waitForGesture() {
    if (waitingGesture) return;
    waitingGesture = true;
    const go = () => {
      waitingGesture = false;
      removeEventListener('pointerdown', go, true);
      removeEventListener('keydown', go, true);
      if (ownCtx) ownCtx.resume().finally(hookAll);
    };
    addEventListener('pointerdown', go, true);
    addEventListener('keydown', go, true);
  }

  function hook(el) {
    track(el);
    if (!route() || hooked.has(el) || blocked.has(el) || foreign.has(el)) return;
    if (!safeToHook(el)) { (el.mediaKeys ? blocked : foreign).add(el); sinkElement(el); report(); return; }
    const ctx = getOwnCtx();
    if (ctx.state !== 'running') {
      // Routing into a suspended context would silence the element: leave it untouched for now.
      // 'statechange' hooks it as soon as the context runs; a click may be needed first (autoplay policy).
      ctx.resume().catch(() => {});
      waitForGesture();
      return;
    }
    if (!rendering(ctx)) { whenRendering(hookAll); return; }
    // It had its own device while it couldn't be routed: back to the default first —
    // once hooked, the chain plays it on the chosen device.
    if (sunk.has(el) || unsinking.has(el)) {
      if (!unsinking.has(el)) {
        sunk.delete(el);
        unsinking.add(el);
        el.setSinkId('').catch(() => {}).then(() => { unsinking.delete(el); hook(el); });
      }
      return;
    }
    try {
      const src = ctx.createMediaElementSource(el);
      origConnect.call(src, chainFor(ctx).input);
      hooked.set(el, src);
    } catch {
      blocked.add(el); // already captured by the page itself — its context is routed anyway
      sinkElement(el);
    }
    report();
  }

  function hookAll() {
    document.querySelectorAll('audio, video').forEach(track);
    if (!route()) return;
    media.forEach((el) => { if (!el.paused || el.currentTime > 0) hook(el); });
  }

  /* ---------------------------------------------------------
     Output device (Firefox: selectAudioOutput in content.js makes the id usable in this document).
     Chains play through setSink(); media we can't route (cross-origin without CORS, DRM)
     uses its own setSinkId. A failure there only leaves that element on the default device.
     --------------------------------------------------------- */
  function sinkElement(el) {
    if (typeof el.setSinkId !== 'function' || hooked.has(el) || unsinking.has(el)) return;
    if (sink && (blocked.has(el) || foreign.has(el))) {
      el.setSinkId(sink).then(() => sunk.add(el), () => {});
    } else if (sunk.has(el)) {
      sunk.delete(el);
      el.setSinkId('').catch(() => {});
    }
  }

  function setSink(id) {
    id = typeof id === 'string' ? id : '';
    if (id === sink) return;
    sink = id;
    media.forEach(sinkElement);
    chains.forEach(sinkChain);
    hookAll(); // playing media joins the chain (and the page's own contexts are routed already)
    report();
  }

  function sinkChain(ch) { ch.setSink(sink).catch((e) => sinkFailed(e)); }

  function sinkFailed(e) {
    if (!sink) return;
    setSink(''); // never silent: everything back to the default device
    send({ type: 'sink-failed', error: String((e && e.name) || e) });
  }

  /** Players that set the rate back when a new video starts: re-apply ours right after a (re)start.
   *  A change later on is the viewer's own (the site's speed menu) and stays. */
  function guardRate(el) {
    if (!S || !speedApplied) return;
    const want = S.fx.speed.value;
    if (el.playbackRate === want) return;
    const t = started.get(el);
    if (t === undefined || performance.now() - t > 3000) return;
    const n = (resets.get(el) || 0) + 1;
    resets.set(el, n);
    if (n > 5) return; // the site insists: don't fight it
    try { el.playbackRate = want; } catch { /* locked */ }
  }

  function applySpeed(el) {
    if (!S) return;
    const v = S.fx.speed.value;
    if (v === 1 && !speedApplied) return;
    try {
      if (el.playbackRate !== v) el.playbackRate = v;
      el.preservesPitch = S.fx.speed.pitch;
    } catch { /* some players lock the rate */ }
  }

  // DRM (EME) media cannot be processed: remember it before it can ever be hooked
  const origSetMediaKeys = HTMLMediaElement.prototype.setMediaKeys;
  if (origSetMediaKeys) {
    HTMLMediaElement.prototype.setMediaKeys = function (keys) {
      if (keys) { track(this); if (!hooked.has(this)) { blocked.add(this); sinkElement(this); } }
      return origSetMediaKeys.apply(this, arguments);
    };
  }
  document.addEventListener('encrypted', (e) => {
    const el = e.target;
    if (el instanceof HTMLMediaElement && !hooked.has(el)) { track(el); blocked.add(el); sinkElement(el); report(); }
  }, true);

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    track(this);
    if (route()) hook(this);
    return origPlay.apply(this, arguments);
  };
  // 'playing' too: after a source switch the element may resume without a new 'play'
  for (const type of ['play', 'playing']) {
    document.addEventListener(type, (e) => { if (e.target instanceof HTMLMediaElement) { track(e.target); if (route()) hook(e.target); } }, true);
  }

  /* ---------------------------------------------------------
     Messaging with content.js
     --------------------------------------------------------- */
  function send(msg) {
    document.dispatchEvent(new CustomEvent(TO_CONTENT, { detail: JSON.stringify(msg) }));
  }

  function status() {
    // sources: processed; blocked: can't be processed; playing: audible but untouched (neutral settings, not hooked yet)
    let sources = 0, blockedCount = 0, playing = 0;
    media.forEach((el) => {
      if (el.paused || el.muted) return;
      if (hooked.has(el)) sources++;
      else if (blocked.has(el) || foreign.has(el)) blockedCount++;
      else playing++;
    });
    chains.forEach((ch, ctx) => { if (ctx !== ownCtx && ctx.state === 'running') sources++; });
    return { v: PROTOCOL, sources, blocked: blockedCount, playing, active };
  }

  function report() { send({ type: 'status', ...status() }); }

  function poll(want) {
    const out = status();
    if (want.includes('levels')) {
      const lv = { l: { peak: 0, rms: 0 }, r: { peak: 0, rms: 0 }, gr: 0 };
      chains.forEach((ch, ctx) => {
        if (ctx.state !== 'running') return;
        const x = ch.levels();
        for (const c of ['l', 'r']) {
          lv[c].peak = Math.max(lv[c].peak, x[c].peak);
          lv[c].rms = Math.max(lv[c].rms, x[c].rms);
        }
        lv.gr = Math.min(lv.gr, x.gr);
      });
      out.levels = lv;
    }
    if (want.includes('spectrum')) {
      let spec = null;
      chains.forEach((ch, ctx) => {
        if (ctx.state !== 'running') return;
        const s = ch.spectrum();
        spec = spec ? spec.map((v, i) => Math.max(v, s[i])) : s;
      });
      out.spectrum = spec;
    }
    return out;
  }

  document.addEventListener(TO_PAGE, (e) => {
    let msg;
    try { msg = JSON.parse(e.detail); } catch { return; }
    if (msg.type === 'settings') {
      const wasActive = active, prevSpeed = S && S.fx.speed.value;
      S = msg.settings;
      duck = msg.duck ?? 1;
      active = !!msg.active;
      chains.forEach((ch) => ch.apply());
      if (S.fx.speed.value !== prevSpeed) {
        speedApplied = speedApplied || S.fx.speed.value !== 1;
        media.forEach(applySpeed);
      }
      if (active && !wasActive) hookAll();
      report();
    } else if (msg.type === 'sink') {
      setSink(msg.id);
    } else if (msg.type === 'poll') {
      send({ type: 'reply', ...poll(msg.want || []) });
    }
  });

  send({ type: 'ready', v: PROTOCOL });
})();
