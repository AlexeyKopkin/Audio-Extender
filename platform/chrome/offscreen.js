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

  const captures = new Map(); // tabId -> { ctx, stream, src, chain, env }

  const isActive = (settings, duck) => !!settings && (AE.needsProcessing(settings) || duck < 1);

  async function start({ tabId, streamId, settings, duck }) {
    if (captures.has(tabId)) { update({ tabId, settings, duck }); return { ok: true }; }
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
      const env = { S: settings, duck, active: isActive(settings, duck) };
      const { Chain } = createChainKit(env);
      const chain = new Chain(ctx);           // chain.out → ctx.destination
      const src = ctx.createMediaStreamSource(stream);
      src.connect(chain.input);
      const track = stream.getAudioTracks()[0];
      if (track) track.addEventListener('ended', () => { stop(tabId); chrome.runtime.sendMessage({ type: 'capture-ended', tabId }).catch(() => {}); });
      captures.set(tabId, { ctx, stream, src, chain, env });
      return { ok: true };
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
      return { ok: false, error: 'chain: ' + ((e && e.message) || e) };
    }
  }

  function update({ tabId, settings, duck }) {
    const c = captures.get(tabId);
    if (!c) return;
    if (settings) c.env.S = settings;
    if (typeof duck === 'number') c.env.duck = duck;
    c.env.active = isActive(c.env.S, c.env.duck);
    c.chain.apply();
  }

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
    const out = { type: 'reply', frame: 'deep', top: false, deep: true, v: AE.PROTOCOL, sources: 1, blocked: 0, playing: 0, active: c.env.active };
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
