/* =========================================================
   Audio Extender — audio engine (runs in the page's MAIN world)

   - Routes <audio>/<video> elements through our own AudioContext.
   - Redirects the page's own AudioContexts (games, web players)
     by intercepting connections to `destination`.
   - Every context gets one processing Chain:
       input → AutoEq → EQ → bass → dialogue → night → stereo matrix
             → normalization → boost → limiter → clipper → out → destination
   - Media elements are only hooked when processing is actually needed,
     and never when that would silence them (cross-origin without CORS,
     DRM-protected media, or an AudioContext that is not allowed to start yet).

   Talks to content.js through JSON strings in CustomEvents.
   ========================================================= */
(() => {
  'use strict';

  const NativeAC = window.AudioContext;
  if (!NativeAC || window.__audioExtenderEngine) return;
  Object.defineProperty(window, '__audioExtenderEngine', { value: true });

  const TO_PAGE = 'audio-extender:to-page';
  const TO_CONTENT = 'audio-extender:to-content';
  const PROTOCOL = 1; // keep in sync with AE.PROTOCOL in shared/settings.js

  const origConnect = AudioNode.prototype.connect;
  const origDisconnect = AudioNode.prototype.disconnect;
  const OfflineAC = window.OfflineAudioContext;

  const dbToLin = (db) => Math.pow(10, db / 20);
  const linToDb = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

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

  /* ---------------------------------------------------------
     Processing chain for one AudioContext
     --------------------------------------------------------- */
  class Chain {
    constructor(ctx) {
      this.ctx = ctx;
      const gain = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
      const biquad = (type, f, q = 1) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };

      this.input = gain();
      this.out = gain();

      this.aePre = gain();
      this.aeFilters = [];
      this.eqPre = gain();
      this.eqFilters = [];

      this.bass = biquad('lowshelf', 100);
      this.dlgLow = biquad('peaking', 250, 0.7);
      this.dlgHigh = biquad('peaking', 2800, 0.9);

      this.night = ctx.createDynamicsCompressor();
      this.night.knee.value = 12;
      this.night.attack.value = 0.003;
      this.night.release.value = 0.25;
      this.nightMakeup = gain();

      // Stereo matrix: L' = ll·L + rl·R, R' = rr·R + lr·L  (width, mono, balance)
      this.mxIn = gain();
      this.mxIn.channelCount = 2;
      this.mxIn.channelCountMode = 'explicit';
      this.mxIn.channelInterpretation = 'speakers'; // mono sources are up-mixed to both sides
      this.mxSplit = ctx.createChannelSplitter(2);
      this.mxMerge = ctx.createChannelMerger(2);
      this.ll = gain(); this.rl = gain(0); this.rr = gain(); this.lr = gain(0);
      origConnect.call(this.mxIn, this.mxSplit);
      origConnect.call(this.mxSplit, this.ll, 0); origConnect.call(this.ll, this.mxMerge, 0, 0);
      origConnect.call(this.mxSplit, this.lr, 0); origConnect.call(this.lr, this.mxMerge, 0, 1);
      origConnect.call(this.mxSplit, this.rl, 1); origConnect.call(this.rl, this.mxMerge, 0, 0);
      origConnect.call(this.mxSplit, this.rr, 1); origConnect.call(this.rr, this.mxMerge, 0, 1);

      this.agc = gain();
      this.agcTap = ctx.createAnalyser();
      this.agcTap.fftSize = 2048;
      this.agcDb = null;
      this.agcTimer = 0;

      this.boost = gain();

      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.12;
      this.limiterTrim = gain(); // cancels the compressor's automatic makeup gain
      this.clipper = ctx.createWaveShaper();
      this.clipper.curve = softClipCurve();
      this.clipper.oversample = '2x';

      // Metering (after processing)
      this.meterIn = gain();
      this.meterIn.channelCount = 2;
      this.meterIn.channelCountMode = 'explicit';
      this.meterIn.channelInterpretation = 'speakers';
      this.meterSplit = ctx.createChannelSplitter(2);
      this.anL = ctx.createAnalyser(); this.anL.fftSize = 2048;
      this.anR = ctx.createAnalyser(); this.anR.fftSize = 2048;
      this.spec = ctx.createAnalyser(); this.spec.fftSize = 4096; this.spec.smoothingTimeConstant = 0.7;
      origConnect.call(this.out, ctx.destination);
      origConnect.call(this.out, this.meterIn);
      origConnect.call(this.meterIn, this.meterSplit);
      origConnect.call(this.meterSplit, this.anL, 0);
      origConnect.call(this.meterSplit, this.anR, 1);
      origConnect.call(this.out, this.spec);
      this.tBuf = new Float32Array(2048);
      this.fBuf = new Float32Array(2048);

      this.key = null;
      this.apply();
    }

    /** Rewire when the structure changes, otherwise just update parameters. */
    apply() {
      const key = structureKey();
      if (key !== this.key) { this.rebuild(); this.key = key; }
      this.updateParams();
    }

    rebuild() {
      const ctx = this.ctx;
      const stageNodes = [this.input, this.aePre, ...this.aeFilters, this.eqPre, ...this.eqFilters, this.bass, this.dlgLow, this.dlgHigh,
        this.night, this.nightMakeup, this.mxMerge, this.agc, this.boost, this.limiter, this.limiterTrim, this.clipper];
      for (const n of stageNodes) { try { origDisconnect.call(n); } catch { /* not connected */ } }

      // filters are recreated because their count/types may change
      this.aeFilters = active && S.autoeq.id ? S.autoeq.filters.map(() => ctx.createBiquadFilter()) : [];
      this.eqFilters = active && S.eq.on ? eqFilterSpecs().map(() => ctx.createBiquadFilter()) : [];

      let cur = this.input;
      const link = (n) => { origConnect.call(cur, n); cur = n; };
      if (active) {
        if (this.aeFilters.length) { link(this.aePre); this.aeFilters.forEach(link); }
        if (this.eqFilters.length) { link(this.eqPre); this.eqFilters.forEach(link); }
        if (S.fx.bass.on) link(this.bass);
        if (S.fx.dialog.on) { link(this.dlgLow); link(this.dlgHigh); }
        if (S.fx.night.on) { link(this.night); link(this.nightMakeup); }
        if (matrixOn()) { origConnect.call(cur, this.mxIn); cur = this.mxMerge; }
        if (S.fx.norm.on) { origConnect.call(cur, this.agcTap); link(this.agc); }
        link(this.boost);
        if (S.limiter.on) { link(this.limiter); link(this.limiterTrim); link(this.clipper); }
      }
      origConnect.call(cur, this.out);

      clearInterval(this.agcTimer);
      this.agcDb = null;
      this.agc.gain.value = 1;
      if (active && S.fx.norm.on) this.agcTimer = setInterval(() => this.agcStep(), 200);
    }

    updateParams() {
      const t = this.ctx.currentTime, T = 0.015;
      const set = (param, v) => param.setTargetAtTime(v, t, T);
      set(this.out.gain, duck);
      if (!active) return;

      if (this.aeFilters.length) {
        set(this.aePre.gain, dbToLin(S.autoeq.preamp));
        S.autoeq.filters.forEach((spec, i) => setFilter(this.aeFilters[i], spec, set));
      }
      if (this.eqFilters.length) {
        set(this.eqPre.gain, dbToLin(S.eq.preamp));
        eqFilterSpecs().forEach((spec, i) => setFilter(this.eqFilters[i], spec, set));
      }

      set(this.bass.gain, S.fx.bass.gain);

      const d = S.fx.dialog.amount / 100;
      set(this.dlgLow.gain, -4 * d);
      set(this.dlgHigh.gain, 7 * d);

      // DynamicsCompressorNode adds automatic makeup gain of 0.6 × |level at 0 dBFS| (Web Audio spec).
      const n = S.fx.night.amount / 100;
      const nT = -20 - 30 * n, nR = 2 + 10 * n;
      set(this.night.threshold, nT);
      set(this.night.ratio, nR);
      set(this.nightMakeup.gain, dbToLin(0.3 * nT * (1 - 1 / nR))); // keep half of the automatic makeup

      // stereo matrix: width w (0 = mono … 2 = extra wide), balance b (-1 … 1)
      const w = S.fx.mono.on ? 0 : (S.fx.width.on ? S.fx.width.value / 100 : 1);
      const a = (1 + w) / 2, c = (1 - w) / 2;
      const b = S.fx.balance.value / 100;
      const gl = Math.min(1, 1 - b), gr = Math.min(1, 1 + b);
      set(this.ll.gain, gl * a); set(this.rl.gain, gl * c);
      set(this.rr.gain, gr * a); set(this.lr.gain, gr * c);

      set(this.boost.gain, S.gain / 100);
      set(this.limiter.threshold, S.limiter.threshold);
      set(this.limiterTrim.gain, dbToLin(0.6 * S.limiter.threshold * (1 - 1 / 20))); // remove makeup entirely
    }

    /** Slow automatic gain towards the loudness target. */
    agcStep() {
      if (this.ctx.state !== 'running') return;
      this.agcTap.getFloatTimeDomainData(this.tBuf);
      let sum = 0;
      for (let i = 0; i < this.tBuf.length; i++) sum += this.tBuf[i] * this.tBuf[i];
      const db = linToDb(Math.sqrt(sum / this.tBuf.length));
      if (db < -60) return; // silence: keep current gain
      this.agcDb = this.agcDb === null ? db : this.agcDb * 0.93 + db * 0.07;
      const want = Math.max(-12, Math.min(12, S.fx.norm.target - this.agcDb));
      this.agc.gain.setTargetAtTime(dbToLin(want), this.ctx.currentTime, 1);
    }

    levels() {
      const read = (an) => {
        an.getFloatTimeDomainData(this.tBuf);
        let peak = 0, sum = 0;
        for (let i = 0; i < this.tBuf.length; i++) {
          const v = Math.abs(this.tBuf[i]);
          if (v > peak) peak = v;
          sum += v * v;
        }
        return { peak, rms: Math.sqrt(sum / this.tBuf.length) };
      };
      return {
        l: read(this.anL),
        r: read(this.anR),
        gr: active && S.limiter.on ? this.limiter.reduction : 0,
      };
    }

    /** 72 log-spaced bars in 0…1, 20 Hz – 20 kHz. */
    spectrum(bars = 72) {
      this.spec.getFloatFrequencyData(this.fBuf);
      const binHz = this.ctx.sampleRate / this.spec.fftSize;
      const out = new Array(bars).fill(0);
      for (let i = 0; i < bars; i++) {
        const f0 = 20 * Math.pow(1000, i / bars), f1 = 20 * Math.pow(1000, (i + 1) / bars);
        let b0 = Math.floor(f0 / binHz), b1 = Math.max(b0 + 1, Math.ceil(f1 / binHz));
        let m = -Infinity;
        for (let b = b0; b < b1 && b < this.fBuf.length; b++) if (this.fBuf[b] > m) m = this.fBuf[b];
        out[i] = Math.max(0, Math.min(1, (m + 95) / 75));
      }
      return out;
    }

    close() { clearInterval(this.agcTimer); }
  }

  function setFilter(node, spec, set) {
    if (node.type !== spec.type) node.type = spec.type;
    set(node.frequency, Math.max(10, Math.min(22000, spec.f)));
    set(node.gain, spec.g || 0);
    // Web Audio interprets Q of lowpass/highpass in dB
    const q = spec.type === 'lowpass' || spec.type === 'highpass' ? 20 * Math.log10(Math.max(0.1, spec.q)) : spec.q;
    set(node.Q, q);
  }

  function softClipCurve() {
    // linear up to 0.8, smooth knee to a hard ceiling of 1.0
    const n = 4096, curve = new Float32Array(n), knee = 0.8;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x);
      const y = ax <= knee ? ax : knee + (1 - knee) * Math.tanh((ax - knee) / (1 - knee));
      curve[i] = Math.sign(x) * y;
    }
    return curve;
  }

  function eqFilterSpecs() {
    if (S.eq.mode === 'param') return S.eq.bands;
    const freqs = S.eq.mode === 'g10' ? G10 : G31;
    const q = S.eq.mode === 'g10' ? 1.41 : 4.32;
    return freqs.map((f, i) => ({ type: 'peaking', f, g: S.eq[S.eq.mode][i] || 0, q }));
  }
  const G10 = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const G31 = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];

  function matrixOn() {
    return S.fx.mono.on || (S.fx.width.on && S.fx.width.value !== 100) || S.fx.balance.value !== 0;
  }

  function structureKey() {
    if (!active) return 'bypass';
    return JSON.stringify([
      S.autoeq.id ? S.autoeq.filters.map((f) => f.type) : 0,
      S.eq.on ? eqFilterSpecs().map((f) => f.type) : 0,
      S.fx.bass.on, S.fx.dialog.on, S.fx.night.on, matrixOn(), S.fx.norm.on, S.limiter.on,
    ]);
  }

  function chainFor(ctx) {
    let ch = chains.get(ctx);
    if (!ch) { ch = new Chain(ctx); chains.set(ctx, ch); }
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
    el.addEventListener('loadedmetadata', () => applySpeed(el));
    // Players often start with a cross-origin URL and then switch the same element to blob: (MSE/HLS).
    el.addEventListener('loadstart', () => { if (foreign.delete(el)) report(); });
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
    if (!active || hooked.has(el) || blocked.has(el) || foreign.has(el)) return;
    if (!safeToHook(el)) { (el.mediaKeys ? blocked : foreign).add(el); report(); return; }
    const ctx = getOwnCtx();
    if (ctx.state !== 'running') {
      // Routing into a suspended context would silence the element: leave it untouched for now.
      // 'statechange' hooks it as soon as the context runs; a click may be needed first (autoplay policy).
      ctx.resume().catch(() => {});
      waitForGesture();
      return;
    }
    if (!rendering(ctx)) { whenRendering(hookAll); return; }
    try {
      const src = ctx.createMediaElementSource(el);
      origConnect.call(src, chainFor(ctx).input);
      hooked.set(el, src);
    } catch {
      blocked.add(el); // already captured by the page itself — its context is routed anyway
    }
    report();
  }

  function hookAll() {
    document.querySelectorAll('audio, video').forEach(track);
    if (!active) return;
    media.forEach((el) => { if (!el.paused || el.currentTime > 0) hook(el); });
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
      if (keys) { track(this); if (!hooked.has(this)) blocked.add(this); }
      return origSetMediaKeys.apply(this, arguments);
    };
  }
  document.addEventListener('encrypted', (e) => {
    const el = e.target;
    if (el instanceof HTMLMediaElement && !hooked.has(el)) { track(el); blocked.add(el); report(); }
  }, true);

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    track(this);
    if (active) hook(this);
    return origPlay.apply(this, arguments);
  };
  // 'playing' too: after a source switch the element may resume without a new 'play'
  for (const type of ['play', 'playing']) {
    document.addEventListener(type, (e) => { if (e.target instanceof HTMLMediaElement) { track(e.target); if (active) hook(e.target); } }, true);
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
    } else if (msg.type === 'poll') {
      send({ type: 'reply', ...poll(msg.want || []) });
    }
  });

  send({ type: 'ready', v: PROTOCOL });
})();
