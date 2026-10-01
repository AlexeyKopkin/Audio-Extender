/* =========================================================
   Audio Extender — deep mode, offscreen document (Chrome / Edge)

   Receives a tab-capture stream id from the service worker (capture.js),
   captures the tab's audio and plays it through the same processing
   chain as the in-page engine (content/chain.js).

   While a tab is captured Chrome no longer plays its audio itself, so
   this document must always play it back: if anything fails, the
   capture is stopped and the tab's own audio returns.
   ========================================================= */
(() => {
  'use strict';

  const createChainKit = window.__audioExtenderChain;
  delete window.__audioExtenderChain;

  const captures = new Map(); // tabId -> { ctx, stream, src, chain, env, base, tabGain, out, outState }

  const isActive = (settings, duck) => !!settings && (AE.needsProcessing(settings) || duck < 1);

  async function start({ tabId, streamId, settings, tabGain, duck, output }) {
    if (captures.has(tabId)) { update({ tabId, settings, tabGain, duck, output }); return { ok: true }; }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
        video: false,
      });
    } catch (e) {
      return { ok: false, error: 'capture: ' + ((e && e.message) || e) };
    }
    // From here on the tab is silent unless we play it.
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    try { await ctx.resume(); } catch { /* checked below */ }
    if (ctx.state !== 'running') {
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
      return { ok: false, error: 'audio output did not start' };
    }
    try {
      const own = typeof tabGain === 'number' ? tabGain : null;
      const S = AE.withTabGain(settings, own);
      const env = { S, duck, active: isActive(S, duck) };
      const { Chain } = createChainKit(env);
      const chain = new Chain(ctx);           // chain.out → ctx.destination
      const src = ctx.createMediaStreamSource(stream);
      src.connect(chain.input);
      const track = stream.getAudioTracks()[0];
      if (track) track.addEventListener('ended', () => { stop(tabId); chrome.runtime.sendMessage({ type: 'capture-ended', tabId }).catch(() => {}); });
      const c = { ctx, stream, src, chain, env, base: settings, tabGain: own, out: '', outState: '' };
      captures.set(tabId, c);
      setOutput(c, output);
      return { ok: true };
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
      return { ok: false, error: 'chain: ' + ((e && e.message) || e) };
    }
  }

  /** `settings`: the site's; `tabGain` (from the service worker only): the tab's own volume, null = none. */
  function update({ tabId, settings, tabGain, duck, output }) {
    const c = captures.get(tabId);
    if (!c) return;
    if (tabGain !== undefined) c.tabGain = typeof tabGain === 'number' ? tabGain : null;
    if (settings) c.base = settings;
    c.env.S = AE.withTabGain(c.base, c.tabGain);
    if (typeof duck === 'number') c.env.duck = duck;
    c.env.active = isActive(c.env.S, c.env.duck);
    c.chain.apply();
    if (typeof output === 'string') setOutput(c, output);
  }

  /** Output device of a captured tab ('' = default). Ids come from this (extension) origin;
   *  if the device can't be used the chain stays on the default device. */
  async function setOutput(c, id) {
    id = id || '';
    if (id === c.out && c.outState !== 'lost') return;
    c.out = id;
    try {
      await c.chain.setSink(id);
      if (c.out === id) c.outState = id ? 'on' : '';
    } catch {
      if (c.out === id) c.outState = 'failed';
    }
  }

  // headphones unplugged / plugged back while chosen
  navigator.mediaDevices.addEventListener('devicechange', async () => {
    let ids = null;
    try { ids = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput').map((d) => d.deviceId); } catch { return; }
    for (const c of captures.values()) {
      if (!c.out) continue;
      const present = ids.includes(c.out);
      if (!present && c.outState === 'on') { c.chain.setSink('').catch(() => {}); c.outState = 'lost'; }
      else if (present && c.outState === 'lost') setOutput(c, c.out);
    }
  });

  function stop(tabId) {
    const c = captures.get(tabId);
    if (!c) return;
    captures.delete(tabId);
    c.stream.getTracks().forEach((t) => t.stop());
    try { c.src.disconnect(); } catch { /* ignore */ }
    c.chain.close();
    c.ctx.close();
  }

  /** Same shape as a reply from the in-page engine (content/page.js), marked `deep`. */
  function poll(tabId, want) {
    const c = captures.get(tabId);
    if (!c) return null;
    const out = { type: 'reply', frame: 'deep', top: false, deep: true, v: AE.PROTOCOL, sources: 1, blocked: 0, playing: 0, active: c.env.active, out: c.outState };
    if (want.includes('levels')) out.levels = c.chain.levels();
    if (want.includes('spectrum')) out.spectrum = c.chain.spectrum();
    return out;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('offscreen-')) return false;
    if (msg.type === 'offscreen-start') { start(msg).then(sendResponse); return true; }
    if (msg.type === 'offscreen-update') update(msg);
    else if (msg.type === 'offscreen-stop') stop(msg.tabId);
    else if (msg.type === 'offscreen-list') { sendResponse([...captures.keys()]); return false; }
    sendResponse({ ok: true });
    return false;
  });

  // The popup of a captured tab: metering polls and live settings while dragging.
  chrome.runtime.onConnect.addListener((port) => {
    const m = /^ae-deep:(\d+)$/.exec(port.name);
    if (!m) return;
    const tabId = +m[1];
    port.onMessage.addListener((msg) => {
      if (msg.type === 'poll') { const r = poll(tabId, msg.want || []); if (r) port.postMessage(r); }
      else if (msg.type === 'live') update({ tabId, settings: msg.settings });
    });
  });
})();
