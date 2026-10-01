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
  let tabGain = null;   // this tab's own volume from the Mixer (null: the site's), see AE.withTabGain
  let base = null;      // the site's settings before the tab's own volume
  let bypass = false;   // the whole tab is processed elsewhere (deep mode): the page engine must not touch the sound
  let greeted = false;  // the background answered 'hello' (duck, deep mode, the tab's own volume are known)
  let lastReply = null;
  let lastStatus = { sources: 0, blocked: 0, playing: 0, active: false };
  let data = null;
  const ports = new Set();
  const frameKey = Math.random().toString(36).slice(2);

  function toPage(msg) {
    document.dispatchEvent(new CustomEvent(TO_PAGE, { detail: JSON.stringify(msg) }));
  }

  /** New settings for this frame (the site's; the tab's own volume goes on top); the speed badge confirms a speed change. */
  function setSettings(next) {
    const prev = settings && settings.fx.speed.value;
    base = next;
    settings = next && AE.withTabGain(next, tabGain, data && AE.normalize(data).app);
    pushSettings();
    if (prev != null && next && next.fx.speed.value !== prev) speed.changed(next.fx.speed.value);
  }

  function pushSettings() {
    if (!settings) return;
    // Until the background has answered, the engine gets the settings (speed applies, keys work) but doesn't
    // process the sound yet: the tab may be in deep mode, and processing it twice would make it louder.
    if (bypass || !greeted) toPage({ type: 'settings', settings, duck: 1, active: false });
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
    setSettings(AE.effective(data, host));
    output.refresh();
    speed.sync();
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.app || changes.defaults || changes.sites || changes.outputs)) refresh();
  });

  /* ---------------------------------------------------------
     Output device of this tab — Firefox (selectAudioOutput): the top frame, and frames of the
     same site (a player in a same-site iframe). Frames of other sites can't: Firefox's
     permissions policy blocks selectAudioOutput / setSinkId there unless the page allows it.
     A device id only becomes usable in a document after selectAudioOutput() ran in it,
     and that needs a click in the page itself:
       first choice   → the popup asks for the in-page chip → click → Firefox's device picker
       later visits   → re-selected silently on the first click / key press on the page
                        (Firefox remembers the permission per site); default device until then.
     A same-site frame needs its own selectAudioOutput too (ids are exposed per document), which
     is silent because Firefox remembers the site's permission: it re-selects on the first click
     inside the frame. Only the top frame shows the chip and reports the state to the popup.
     Chrome / Edge have no selectAudioOutput: there the tab plays through deep mode instead.
     --------------------------------------------------------- */
  const output = (() => {
    const md = navigator.mediaDevices;
    const isTop = window === window.top;
    let sameSite = isTop;
    try { sameSite = isTop || window.top.location.origin === location.origin; } catch { /* another site's frame */ }
    const supported = sameSite && !!md && typeof md.selectAudioOutput === 'function';
    let want = null;      // { id, label } saved for this site
    let state = '';       // '' default | wait (needs a click) | on | lost (device gone) | failed
    let tried = null;     // id already tried silently in this document
    let chip = null;

    const sinkToPage = (id) => toPage({ type: 'sink', id });

    function refresh() {
      if (!supported) return;
      const w = AE.outputFor(data, host);
      if ((w && w.id) === (want && want.id)) { want = w; fillLabel(); return; }
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
        fillLabel();
      } catch {
        set('failed');
      }
    }

    function use(id) { sinkToPage(id); set('on'); }

    /** The device's name, as this document sees it once the device was selected here ('' if not). */
    async function labelOf(id) {
      try { return ((await md.enumerateDevices()).find((x) => x.kind === 'audiooutput' && x.deviceId === id) || {}).label || ''; } catch { return ''; }
    }

    /** Remember the device for the site. Only the top frame writes it (frames just use it), and never without
     *  a name: a silent re-select can return an empty label — then the name is looked up or the old one kept. */
    async function save(d) {
      if (!isTop) return;
      const label = d.label || (want && want.id === d.deviceId && want.label) || await labelOf(d.deviceId);
      const cur = (await browser.storage.local.get('outputs')).outputs || {};
      want = { id: d.deviceId, label };
      await browser.storage.local.set({ outputs: { ...cur, [host]: want } });
    }

    /** A device remembered without a name (older builds, or an empty label from Firefox): fill it in once it plays here. */
    let filling = false;
    async function fillLabel() {
      if (!isTop || filling || !want || want.label || state !== 'on') return;
      filling = true;
      const label = await labelOf(want.id);
      if (label && want && !want.label) await save({ deviceId: want.id, label });
      filling = false;
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
      reports: supported && isTop, // one state per tab: the top frame's
      refresh,
      ask(text) { if (supported && isTop) showChip(text); },
      failed() { if (state === 'on') set('failed'); },
      get state() { return state; },
    };
  })();

  const outStatus = () => (output.reports ? { out: output.state } : {});

  /* ---------------------------------------------------------
     Speed keys and badge (content/speed.js). A key press is stored as the
     site's speed, exactly like the popup slider.
     --------------------------------------------------------- */
  const speed = window.__audioExtenderSpeed({
    alive: () => !!(browser.runtime && browser.runtime.id), // false in a script left behind by an update
    settings: () => settings,
    app: () => (data ? AE.normalize(data).app : null),
    host: () => host,
    async setSpeed(v) {
      if (!base) return;
      setSettings({ ...base, fx: { ...base.fx, speed: { ...base.fx.speed, value: v } } });
      const cur = await browser.storage.local.get(AE.KEYS);
      const s = AE.effective(cur, host);
      s.fx.speed.value = v;
      await browser.storage.local.set(AE.storeFor(cur, host, s));
    },
  });

  // Popup / sidebar: live settings while dragging, and metering polls
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'ae-tab') return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    port.onMessage.addListener((msg) => {
      if (msg.type === 'live') {
        setSettings(msg.settings);
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
    } else if (msg && msg.type === 'tab-gain') {
      tabGain = typeof msg.gain === 'number' ? msg.gain : null;
      if (base) setSettings(base);
    } else if (msg && msg.type === 'bypass') {
      bypass = !!msg.on;
      pushSettings();
    } else if (msg && msg.type === 'output-ask' && msg.text) {
      output.ask({ ask: String(msg.text.ask), close: String(msg.text.close) });
    }
  });

  /* Settings come from storage directly, so the page is ready at once — also while the background is still
     starting (browser start, restored tabs: that can take seconds, and speed keys pressed meanwhile were lost).
     The site is the tab's top page: known here in the top frame and in frames that can see it (Firefox has no
     location.ancestorOrigins); other frames wait for 'hello', which also brings duck, deep mode and the
     tab's own volume. */
  function topHost() {
    if (window === window.top) return AE.hostOf(location.href);
    try { return AE.hostOf(window.top.location.href); } catch { /* another site's frame */ }
    const anc = location.ancestorOrigins;
    return anc && anc.length ? AE.hostOf(anc[anc.length - 1]) : null;
  }
  host = topHost();
  refresh();

  function hello(attempt = 0) {
    browser.runtime.sendMessage({ type: 'hello' }).then((info) => {
      host = info ? info.host : host;
      if (info && typeof info.duck === 'number') duck = info.duck;
      if (info && typeof info.tabGain === 'number') tabGain = info.tabGain;
      if (info && info.bypass) bypass = true;
      greeted = true;
      refresh();
    }).catch(() => {
      // the background is restarting: ask again (a script left behind by an update stops here)
      if (attempt < 5 && browser.runtime && browser.runtime.id) setTimeout(() => hello(attempt + 1), 500 * 2 ** attempt);
    });
  }
  hello();
})();
