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
  let bypass = false;   // the whole tab is processed elsewhere (deep mode): the page engine must not touch the sound
  let lastReply = null;
  let lastStatus = { sources: 0, blocked: 0, playing: 0, active: false };
  let data = null;
  const ports = new Set();
  const frameKey = Math.random().toString(36).slice(2);

  function toPage(msg) {
    document.dispatchEvent(new CustomEvent(TO_PAGE, { detail: JSON.stringify(msg) }));
  }

  function pushSettings() {
    if (!settings) return;
    if (bypass) toPage({ type: 'settings', settings, duck: 1, active: false });
    else toPage({ type: 'settings', settings, duck, active: AE.needsProcessing(settings) || duck < 1 });
  }

  document.addEventListener(TO_CONTENT, (e) => {
    let msg;
    try { msg = JSON.parse(e.detail); } catch { return; }
    if (msg.type === 'ready') pushSettings();
    else if (msg.type === 'reply') lastReply = msg;
    else if (msg.type === 'status') {
      lastStatus = msg;
      ports.forEach((p) => p.postMessage({ type: 'status', frame: frameKey, ...msg, ...outStatus() }));
    } else if (msg.type === 'sink-failed') output.failed();
  });

  async function refresh() {
    if (host === null) return;
    data = await browser.storage.local.get(AE.KEYS);
    settings = AE.effective(data, host);
    pushSettings();
    output.refresh();
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.app || changes.defaults || changes.sites || changes.outputs)) refresh();
  });

  /* ---------------------------------------------------------
     Output device of this tab — Firefox (selectAudioOutput), top frame only.
     A device id only becomes usable in a document after selectAudioOutput() ran in it,
     and that needs a click in the page itself:
       first choice   → the popup asks for the in-page chip → click → Firefox's device picker
       later visits   → re-selected silently on the first click / key press on the page
                        (Firefox remembers the permission per site); default device until then.
     Chrome / Edge have no selectAudioOutput: there the tab plays through deep mode instead.
     --------------------------------------------------------- */
  const output = (() => {
    const md = navigator.mediaDevices;
    const supported = window === window.top && !!md && typeof md.selectAudioOutput === 'function';
    let want = null;      // { id, label } saved for this site
    let state = '';       // '' default | wait (needs a click) | on | lost (device gone) | failed
    let tried = null;     // id already tried silently in this document
    let chip = null;

    const sinkToPage = (id) => toPage({ type: 'sink', id });

    function refresh() {
      if (!supported) return;
      const w = AE.outputFor(data, host);
      if ((w && w.id) === (want && want.id)) { want = w; return; }
      want = w;
      sinkToPage('');
      set(want ? 'wait' : '');
    }

    function set(st) {
      state = st;
      if (st === 'wait') arm(); else disarm();
      ports.forEach((p) => p.postMessage({ type: 'status', frame: frameKey, ...lastStatus, ...outStatus() }));
    }

    // silent re-select on the first trusted click / key press on the page
    const onGesture = (e) => { if (e.isTrusted) reselect(); };
    function arm() { addEventListener('pointerdown', onGesture, true); addEventListener('keydown', onGesture, true); }
    function disarm() { removeEventListener('pointerdown', onGesture, true); removeEventListener('keydown', onGesture, true); }

    async function reselect() {
      disarm();
      if (!want || state !== 'wait' || tried === want.id) return;
      tried = want.id;
      try {
        const d = await md.selectAudioOutput({ deviceId: want.id });
        if (d.deviceId !== want.id) await save(d); // another device was picked in Firefox's dialog
        use(d.deviceId);
      } catch {
        set('failed');
      }
    }

    function use(id) { sinkToPage(id); set('on'); }

    async function save(d) {
      const cur = (await browser.storage.local.get('outputs')).outputs || {};
      want = { id: d.deviceId, label: d.label };
      await browser.storage.local.set({ outputs: { ...cur, [host]: want } });
    }

    // first choice: Firefox's own device picker, opened by a click on our chip
    async function pick() {
      hideChip();
      try {
        const d = await md.selectAudioOutput();
        tried = d.deviceId;
        await save(d);
        use(d.deviceId);
      } catch { /* dismissed: nothing changes */ }
    }

    function showChip(text) {
      hideChip();
      const el = document.createElement('audio-extender-chip');
      const sh = el.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        :host { all: initial; position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 2147483647; }
        .box { display: flex; align-items: center; gap: 4px; padding: 4px; border-radius: 999px; background: #1c1b2e; color: #fff;
          box-shadow: 0 6px 24px rgba(0,0,0,.35), 0 0 0 1px rgba(160,120,255,.55); font: 600 13px/1.2 system-ui, sans-serif; }
        button { all: unset; cursor: pointer; border-radius: 999px; }
        .go { padding: 8px 14px; background: linear-gradient(90deg, #7c4dff, #3d8bff); }
        .go:hover { filter: brightness(1.12); }
        .x { width: 28px; height: 28px; text-align: center; line-height: 28px; font-size: 16px; opacity: .75; }
        .x:hover { opacity: 1; }
        button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }`;
      const box = document.createElement('div');
      box.className = 'box';
      const go = document.createElement('button');
      go.className = 'go';
      go.textContent = '\u{1F50A} ' + text.ask;
      go.addEventListener('click', (e) => { if (e.isTrusted) pick(); });
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '×';
      x.title = text.close;
      x.addEventListener('click', hideChip);
      box.append(go, x);
      sh.append(style, box);
      (document.body || document.documentElement).append(el);
      chip = el;
    }
    function hideChip() { if (chip) chip.remove(); chip = null; }

    // device unplugged / back while chosen: the default device meanwhile
    if (supported) {
      md.addEventListener('devicechange', async () => {
        if (!want || (state !== 'on' && state !== 'lost')) return;
        let present = false;
        try { present = (await md.enumerateDevices()).some((d) => d.kind === 'audiooutput' && d.deviceId === want.id); } catch { /* keep */ }
        if (present && state === 'lost') use(want.id);
        else if (!present && state === 'on') { sinkToPage(''); set('lost'); }
      });
    }

    return {
      supported,
      refresh,
      ask(text) { if (supported) showChip(text); },
      failed() { if (state === 'on') set('failed'); },
      get state() { return state; },
    };
  })();

  const outStatus = () => (output.supported ? { out: output.state } : {});

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
        if (r.sources || r.blocked || r.playing || r.active || window === window.top) {
          port.postMessage({ type: 'reply', frame: frameKey, top: window === window.top, ...r, ...outStatus() });
        }
      }
    });
  });

  // From the background script: "lower other tabs", and bypass while the tab is processed elsewhere
  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'duck') {
      duck = msg.factor;
      pushSettings();
    } else if (msg && msg.type === 'bypass') {
      bypass = !!msg.on;
      pushSettings();
    } else if (msg && msg.type === 'output-ask' && msg.text) {
      output.ask({ ask: String(msg.text.ask), close: String(msg.text.close) });
    }
  });

  browser.runtime.sendMessage({ type: 'hello' }).then((info) => {
    host = info && info.host;
    if (info && typeof info.duck === 'number') duck = info.duck;
    if (info && info.bypass) bypass = true;
    refresh();
  }).catch(() => { /* extension reloaded */ });
})();
