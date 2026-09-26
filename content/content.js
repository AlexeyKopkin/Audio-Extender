/* =========================================================
   Audio Extender — content script (isolated world)
   Bridge between the extension (storage, popup, background)
   and the audio engine in content/page.js.
   ========================================================= */
(() => {
  'use strict';

  // May be injected again into already open tabs (install / update / popup) — run once per extension instance.
  if (window.__audioExtenderContent) return;
  window.__audioExtenderContent = true;

  const TO_PAGE = 'audio-extender:to-page';
  const TO_CONTENT = 'audio-extender:to-content';

  let host = null;
  let settings = null;
  let duck = 1;
  let lastReply = null;
  let lastStatus = { sources: 0, blocked: 0, active: false };
  const ports = new Set();
  const frameKey = Math.random().toString(36).slice(2);

  function toPage(msg) {
    document.dispatchEvent(new CustomEvent(TO_PAGE, { detail: JSON.stringify(msg) }));
  }

  function pushSettings() {
    if (!settings) return;
    toPage({ type: 'settings', settings, duck, active: AE.needsProcessing(settings) || duck < 1 });
  }

  document.addEventListener(TO_CONTENT, (e) => {
    let msg;
    try { msg = JSON.parse(e.detail); } catch { return; }
    if (msg.type === 'ready') pushSettings();
    else if (msg.type === 'reply') lastReply = msg;
    else if (msg.type === 'status') {
      lastStatus = msg;
      ports.forEach((p) => p.postMessage({ type: 'status', frame: frameKey, ...msg }));
    }
  });

  async function refresh() {
    if (host === null) return;
    const data = await browser.storage.local.get(AE.KEYS);
    settings = AE.effective(data, host);
    pushSettings();
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.app || changes.defaults || changes.sites)) refresh();
  });

  // Popup / sidebar: live settings while dragging, and metering polls
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'ae-tab') return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    port.onMessage.addListener((msg) => {
      if (msg.type === 'live') {
        settings = msg.settings;
        pushSettings();
      } else if (msg.type === 'poll') {
        lastReply = null;
        toPage({ type: 'poll', want: msg.want || [] });   // answered synchronously
        const r = lastReply || lastStatus;
        if (r.sources || r.blocked || r.active || window === window.top) {
          port.postMessage({ type: 'reply', frame: frameKey, top: window === window.top, ...r });
        }
      }
    });
  });

  // "Lower other tabs" from the background script
  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'duck') {
      duck = msg.factor;
      pushSettings();
    }
  });

  browser.runtime.sendMessage({ type: 'hello' }).then((info) => {
    host = info && info.host;
    if (info && typeof info.duck === 'number') duck = info.duck;
    refresh();
  }).catch(() => { /* extension reloaded */ });
})();
