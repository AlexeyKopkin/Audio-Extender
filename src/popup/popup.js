/* =========================================================
   Audio Extender — popup / sidebar UI
   ========================================================= */
(async () => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = document.documentElement;
  const cssVar = (n) => getComputedStyle(root).getPropertyValue(n).trim();
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const tr = (key, vars) => I18N.t(key, vars);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Markup is built from constants and esc()-escaped values; DOMParser never runs scripts.
  const parser = new DOMParser();
  function setHTML(el, markup) {
    el.replaceChildren(...parser.parseFromString(`<body>${markup}</body>`, 'text/html').body.childNodes);
  }
  function setSVG(el, markup) {
    const doc = parser.parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, 'image/svg+xml');
    el.replaceChildren(...[...doc.documentElement.childNodes].map((n) => document.importNode(n, true)));
  }

  // double-click with a mouse, double-tap with a finger (Firefox for Android fires no dblclick).
  // Items are matched by data-i: the EQ graph re-renders its nodes between the taps.
  function onDoubleTap(box, selector, fn) {
    box.addEventListener('dblclick', (e) => {
      const el = e.target.closest(selector);
      if (el) fn(el);
    });
    let last = { i: null, t: 0 };
    box.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      const el = e.target.closest(selector);
      if (!el) return;
      const now = performance.now();
      if (last.i === el.dataset.i && now - last.t < 350) {
        last = { i: null, t: 0 };
        e.stopPropagation(); // no drag / slider jump to the finger on the second tap
        fn(el);
      } else last = { i: el.dataset.i, t: now };
    }, { capture: true });
  }

  // per-viewer UI conveniences (last open tab)
  const ui = {
    get(k, d) { try { const v = localStorage.getItem('ae:ui:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('ae:ui:' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  const minus = (s) => String(s).replace('-', '−');
  const fmt = {
    num: (v) => String(v),
    pct: (v) => Math.round(v) + '%',
    db: (v) => minus((v > 0 ? '+' : '') + (+v).toFixed(1) + ' dB'),
    lufs: (v) => minus(v + ' LUFS'),
    speed: (v) => (+v).toFixed(2) + '×',
    bal: (v) => (+v === 0 ? tr('fx.center') : (v < 0 ? 'L ' : 'R ') + Math.abs(v) + '%'),
    hz: (f) => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2) + ' kHz' : Math.round(f) + ' Hz'),
  };

  const AUTOEQ_BASE = 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/';

  /* ---------------------------------------------------------
     State
     --------------------------------------------------------- */
  let data = await API.load();
  let tab = null;          // target browser tab
  let host = null;         // its site key
  let kind = 'internal';   // web | internal
  let audio = AE.effective(data, host);
  let lastEdit = 0;

  if (!API.isExtension) root.classList.add('preview');
  // Firefox for Android opens the popup as a full-screen page: fit the screen instead of 480×600.
  const MOBILE = /Android/i.test(navigator.userAgent) || API.mobilePreview;
  if (MOBILE) root.classList.add('mobile');
  // finger instead of mouse: no wheel, no hover; hints and double-tap adapt
  const TOUCH = MOBILE || matchMedia('(pointer: coarse)').matches;
  // hide what this Firefox doesn't have (Android: no sidebar, no keyboard shortcuts, no tab muting)
  $('#row-sidebar').classList.toggle('hidden', !API.hasSidebar);
  $('#card-hotkeys').classList.toggle('hidden', !API.hasShortcuts);
  $('#mute-others').classList.toggle('hidden', !API.canMute);
  // output device per tab: 'deep' (Chrome / Edge), 'page' (Firefox) or null (not available, e.g. Firefox for Android)
  const OUT_MODE = API.outputMode;
  // Chrome / Edge: the extension page opened to allow listing the audio devices
  const GRANT_PAGE = API.context === 'tab' && new URLSearchParams(location.search).get('grant') === 'devices';
  if (API.context === 'sidebar') root.classList.add('sidebar');
  if (API.context === 'tab') root.classList.add('page');

  /* ---------------------------------------------------------
     Saving
     --------------------------------------------------------- */
  let pendingPatch = null, saveTimer = 0;
  function persistSoon(patch) {
    pendingPatch = { ...(pendingPatch || {}), ...patch };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 200);
  }
  function flush() {
    clearTimeout(saveTimer);
    if (!pendingPatch) return;
    const p = pendingPatch;
    pendingPatch = null;
    API.persist(p);
  }
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  /** Called after every edit of `audio` for the current site. */
  function commit() {
    lastEdit = Date.now();
    if (link) link.post({ type: 'live', settings: audio });
    const patch = AE.storeFor(data, host, audio);
    Object.assign(data, patch);
    persistSoon(patch);
    renderDerived();
  }

  /** Edit settings of another site (mixer). */
  function commitHost(h, s) {
    if (h === host) { audio = s; renderBindings(); commit(); return; }
    const patch = AE.storeFor(data, h, s);
    Object.assign(data, patch);
    lastEdit = Date.now();
    persistSoon(patch);
  }

  function saveApp() {
    lastEdit = Date.now();
    API.save({ app: data.app });
  }

  /* ---------------------------------------------------------
     Ranges and bindings
     --------------------------------------------------------- */
  function paintRange(r) {
    const min = +r.min || 0, max = +r.max || 100, v = +r.value;
    const p = ((v - min) / (max - min)) * 100;
    r.style.setProperty('--p', p + '%');
    if (r.classList.contains('range-center')) {
      const c = ((0 - min) / (max - min)) * 100;
      r.style.setProperty('--lo', Math.min(p, c) + '%');
      r.style.setProperty('--hi', Math.max(p, c) + '%');
    }
    const out = r.dataset.out && document.getElementById(r.dataset.out);
    if (out) out.textContent = fmt[r.dataset.fmt || 'num'](v);
  }
  $$('input[type=range]').forEach((r) => r.addEventListener('input', () => paintRange(r)));

  /** Click (or Enter on) a shown value to type an exact one: Enter or leaving the field applies, Esc cancels. */
  function typeable(el, { get, set, min, max, decimals = 0 }) {
    el.classList.add('typeable');
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    const open = () => {
      if (el.hidden) return;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.inputMode = 'decimal';
      inp.className = 'inline-num';
      inp.value = String(get());
      inp.setAttribute('aria-label', el.title);
      el.hidden = true;
      el.after(inp);
      inp.focus();
      inp.select();
      let done = false;
      const close = (apply) => {
        if (done) return;
        done = true;
        const v = parseFloat(inp.value.replace(',', '.'));
        inp.remove();
        el.hidden = false;
        if (apply && isFinite(v)) set(clamp(+v.toFixed(decimals), min(), max()));
        el.focus();
      };
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); close(true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
      });
      inp.addEventListener('blur', () => close(true));
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  }

  const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
  function setPath(o, p, v) {
    const ks = p.split('.'), last = ks.pop();
    ks.reduce((x, k) => x[k], o)[last] = v;
  }

  $$('[data-bind]').forEach((el) => {
    el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
      setPath(audio, el.dataset.bind, el.type === 'checkbox' ? el.checked : +el.value);
      commit();
    });
  });

  function renderBindings() {
    $$('[data-bind]').forEach((el) => {
      const v = getPath(audio, el.dataset.bind);
      if (el.type === 'checkbox') el.checked = !!v;
      else { el.value = v; paintRange(el); }
    });
    renderDerived();
  }

  /** Everything that depends on `audio` but is not a bound control. */
  function renderDerived() {
    $$('.fx').forEach((card) => {
      const sw = card.querySelector('.fx-head .switch input, .card-head .switch input');
      if (sw) card.classList.toggle('on', sw.checked);
    });
    updateGauge();
    renderUnheard();
    renderSpeed();
    const pw = $('#btn-power');
    pw.classList.toggle('on', audio.enabled);
    pw.setAttribute('aria-pressed', audio.enabled);
    $('#app').classList.toggle('off', !audio.enabled);
    $('#eq-graph').classList.toggle('bypass', !audio.eq.on);
    renderSiteChip();
  }

  /* ---------------------------------------------------------
     Tabs
     --------------------------------------------------------- */
  const tabs = $$('.tab');
  const indicator = $('.tab-indicator');
  let currentPanel = 'booster';
  function showTab(name) {
    currentPanel = name;
    tabs.forEach((t, i) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on);
      if (on) indicator.style.transform = `translateX(${i * 100}%)`;
    });
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
    $('#content').scrollTop = 0;
    ui.set('tab', name);
    if (name === 'eq') eq.render();
    if (name === 'mixer') refreshMixer();
    if (name === 'settings') { renderProfiles(); renderHotkeys(); }
  }
  tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  /* ---------------------------------------------------------
     App preferences: theme, language, behaviour
     --------------------------------------------------------- */
  let palette = {};
  function readPalette() { palette = { a1: cssVar('--a1'), a2: cssVar('--a2') }; }

  function applyTheme(name) {
    root.dataset.theme = name;
    $$('.theme-swatch').forEach((s) => s.classList.toggle('active', s.dataset.theme === name));
    readPalette();
    eq.render();
  }
  $$('.theme-swatch').forEach((s) => s.addEventListener('click', () => {
    data.app.theme = s.dataset.theme;
    saveApp();
    applyTheme(data.app.theme);
  }));

  const langWrap = $('#langs');
  setHTML(langWrap, Object.entries(I18N.LANGS)
    .map(([code, name]) => `<button class="lang" data-lang="${code}"><b>${code.toUpperCase()}</b>${name}</button>`)
    .join(''));
  langWrap.addEventListener('click', (e) => {
    const b = e.target.closest('.lang');
    if (!b) return;
    data.app.lang = b.dataset.lang;
    saveApp();
    applyLang(data.app.lang);
  });
  function applyLang(code) {
    const lang = I18N.apply(code);
    $$('.lang', langWrap).forEach((b) => b.classList.toggle('active', b.dataset.lang === lang));
    renderAll();
  }

  $$('[data-app]').forEach((el) => el.addEventListener('change', () => {
    const key = el.dataset.app;
    data.app[key] = el.checked;
    saveApp();
    if (key === 'speedKeys') renderSpeedKeys();
    if (key === 'perSite' || key === 'autoEnable') {
      audio = AE.effective(data, host);
      if (link) link.post({ type: 'live', settings: audio });
      renderAll();
    }
    if (key === 'animations') root.classList.toggle('no-anim', !el.checked);
    if (key === 'showSilent') refreshMixer();
  }));

  function renderAppControls() {
    $$('[data-app]').forEach((el) => { el.checked = !!data.app[el.dataset.app]; });
    root.classList.toggle('no-anim', !data.app.animations);
    renderSpeedKeys();
    renderMaxGain();
  }

  /* Speed keys on pages (content/speed.js): global switch, per-site switch, key hint.
     Phones have no keyboard: only the badge switch stays. */
  const KEY_HINT = [['slower', 'faster', 'fx.keySlowerFaster'], ['reset', null, 'fx.keyReset'], ['toggle', null, 'fx.keyToggle'], ['back', 'forward', 'fx.keySeek']];
  const KEY_NAMES = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Backquote: '`', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=' };
  const keyLabel = (code) => (code.startsWith('Key') ? code.slice(3) : code.startsWith('Digit') ? code.slice(5)
    : code.startsWith('Numpad') ? 'Num ' + code.slice(6) : KEY_NAMES[code] || code);
  /** action → key code ('' when off) */
  function actionKeys() {
    const out = Object.fromEntries(Object.keys(AE.SPEED_KEYS).map((a) => [a, '']));
    for (const [code, a] of Object.entries(AE.speedKeyMap(data.app))) out[a] = code;
    return out;
  }
  const keyStep = () => (AE.SPEED_STEPS.includes(data.app.speedStep) ? data.app.speedStep : 0.1);
  const keySeek = () => (AE.SEEK_STEPS.includes(data.app.seekSeconds) ? data.app.seekSeconds : 10);
  function renderSpeedKeys() {
    $('#speed-keys').classList.toggle('hidden', !!MOBILE);
    const siteRow = $('#row-speed-site');
    siteRow.classList.toggle('hidden', !host || kind !== 'web' || !data.app.speedKeys);
    $('#speed-site-label').textContent = tr('fx.speedKeysSite', { site: host || '' });
    $('#speed-site').checked = !(data.app.speedKeysOff || {})[host];
    $('#speed-opts').classList.toggle('hidden', !data.app.speedKeys);
    setHTML($('#speed-step'), AE.SPEED_STEPS.map((v) => `<option value="${v}">±${v}×</option>`).join(''));
    setHTML($('#seek-step'), AE.SEEK_STEPS.map((v) => `<option value="${v}">${esc(tr('fx.seconds', { s: v }))}</option>`).join(''));
    $('#speed-step').value = keyStep();
    $('#seek-step').value = keySeek();
    const text = (k) => (k === 'fx.keySlowerFaster' ? `${tr(k)} ±${keyStep()}` : tr(k, { s: keySeek() }));
    const keys = actionKeys();
    setHTML($('#speed-keys-hint'), KEY_HINT.map(([a, b, k]) => {
      const on = [a, b].filter((x) => x && keys[x]);
      if (!on.length) return '';
      const kbd = on.map((x) => `<kbd>${esc(keyLabel(keys[x]))}</kbd>`).join(' ');
      // one key of a pair left: name that action alone
      const label = b && on.length === 1
        ? `${tr('fx.act.' + on[0])} ${k === 'fx.keySlowerFaster' ? '±' + keyStep() : tr('fx.seconds', { s: keySeek() })}`
        : text(k);
      return `<span>${kbd} ${esc(label)}</span>`;
    }).filter(Boolean).join(' · '));
    $('#keymap-toggle').classList.toggle('hidden', !data.app.speedKeys);
    if (!data.app.speedKeys) $('#keymap').classList.add('hidden');
    renderKeymap();
  }

  /* Key editor: click an action, press the new key (Backspace = off, Esc = cancel). */
  let keyWait = null; // action waiting for a key
  function renderKeymap(msg) {
    const keys = actionKeys();
    setHTML($('#keymap-rows'), Object.keys(AE.SPEED_KEYS).map((a) => {
      const wait = keyWait === a, off = !keys[a];
      const label = wait ? tr('fx.keysPress') : off ? tr('fx.keysOff') : keyLabel(keys[a]);
      return `<div class="key-row"><span>${esc(tr('fx.act.' + a))}</span><button class="key-btn${wait ? ' wait' : ''}${off && !wait ? ' off' : ''}" data-act="${a}">${esc(label)}</button></div>`;
    }).join(''));
    $('#keymap-msg').textContent = msg || tr('fx.keysHelp');
  }
  $('#keymap-toggle').addEventListener('click', (e) => {
    const box = $('#keymap');
    box.classList.toggle('hidden');
    e.currentTarget.setAttribute('aria-expanded', !box.classList.contains('hidden'));
    keyWait = null;
    renderKeymap();
  });
  $('#keymap-rows').addEventListener('click', (e) => {
    const b = e.target.closest('.key-btn');
    if (!b) return;
    keyWait = keyWait === b.dataset.act ? null : b.dataset.act;
    renderKeymap();
    if (keyWait) $(`.key-btn[data-act="${keyWait}"]`).focus();
  });
  document.addEventListener('keydown', (e) => {
    if (!keyWait) return;
    e.preventDefault();
    e.stopPropagation();
    const act = keyWait;
    if (e.key === 'Escape') { keyWait = null; renderKeymap(); return; }
    const map = actionKeys();
    let msg = '';
    if (e.key === 'Backspace' || e.key === 'Delete') map[act] = '';
    else if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !AE.speedKeyOk(e.code)) { renderKeymap(tr('fx.keysBad')); return; }
    else {
      const other = Object.keys(map).find((a) => a !== act && map[a] === e.code);
      if (other) { map[other] = ''; msg = tr('fx.keysMoved', { key: keyLabel(e.code), action: tr('fx.act.' + other) }); }
      map[act] = e.code;
    }
    keyWait = null;
    data.app.speedKeyMap = map;
    saveApp();
    renderSpeedKeys();
    if (msg) renderKeymap(msg);
  }, true);
  $('#keymap-reset').addEventListener('click', () => {
    keyWait = null;
    data.app.speedKeyMap = { ...AE.SPEED_KEYS };
    saveApp();
    renderSpeedKeys();
  });
  function renderMaxGain() {
    setHTML($('#max-gain'), AE.GAIN_CAPS.map((v) => `<option value="${v}">${v}%</option>`).join(''));
    $('#max-gain').value = AE.gainCap(data.app);
  }
  $('#max-gain').addEventListener('change', (e) => {
    data.app.maxGain = +e.target.value;
    saveApp();
    audio = AE.effective(data, host); // a louder site plays at the new maximum right away
    if (link) link.post({ type: 'live', settings: audio });
    renderAll();
  });
  $('#speed-step').addEventListener('change', (e) => { data.app.speedStep = +e.target.value; saveApp(); renderSpeedKeys(); });
  $('#seek-step').addEventListener('change', (e) => { data.app.seekSeconds = +e.target.value; saveApp(); renderSpeedKeys(); });
  $('#speed-site').addEventListener('change', (e) => {
    const off = { ...(data.app.speedKeysOff || {}) };
    if (e.target.checked) delete off[host]; else off[host] = true;
    data.app.speedKeysOff = off;
    saveApp();
  });

  /* ---------------------------------------------------------
     Header: site chip, power, reset
     --------------------------------------------------------- */
  let status = { sources: 0, blocked: 0, playing: 0, drm: 0, foreign: 0, deep: false, out: '' };
  function renderSiteChip() {
    let label = host || '';
    if (!host && tab) { try { label = new URL(tab.url).protocol.replace(':', ''); } catch { label = ''; } }
    if (API.context === 'tab') label = 'Audio Extender';
    $('#site-host').textContent = label;
    let st = '';
    if (kind === 'web') {
      if (!audio.enabled) st = tr('app.processingOff');
      else if (status.deep) st = tr('deep.chip');
      else if (status.sources) st = tr('app.sources', { n: status.sources });
      else st = tr(status.playing || status.blocked ? 'app.playing' : 'app.noAudio'); // heard, but untouched (nothing to change yet, or can't be processed)
    }
    $('#site-status').textContent = st ? '· ' + st : '';
    $('#site-chip .dot').classList.toggle('live', kind === 'web' && audio.enabled && (status.deep || status.sources + status.playing > 0));
  }

  $('#btn-power').addEventListener('click', () => {
    audio.enabled = !audio.enabled;
    commit();
  });
  $('#btn-reset').addEventListener('click', () => {
    if (data.app.perSite && host) {
      const sites = { ...data.sites };
      delete sites[host];
      data.sites = sites;
      API.persist({ sites });
    } else {
      data.defaults = AE.clone(AE.DEFAULT_AUDIO);
      API.persist({ defaults: data.defaults });
    }
    lastEdit = Date.now();
    audio = AE.effective(data, host);
    if (link) link.post({ type: 'live', settings: audio });
    renderAll();
  });

  /* ---------------------------------------------------------
     Notices (page state)
     --------------------------------------------------------- */
  // Page state: connecting | ok | noAccess | restricted | reload | outdated
  let pageState = 'connecting';
  let noticeKey = '';
  function renderNotice() {
    let n = null, na = false;
    const reload = { b: tr('app.reload'), act: reloadTab };
    if (GRANT_PAGE) {
      n = grantResult
        ? { t: tr('dev.grantTitle'), d: tr(grantResult === 'granted' ? 'dev.granted' : 'dev.denied') }
        : { t: tr('dev.grantTitle'), d: tr('dev.grantDesc'), b: tr('dev.grant'), act: grantDevices };
      na = true;
    } else if (API.context === 'tab') na = true;
    else if (kind !== 'web') { n = { t: tr('app.unavailable'), d: tr('app.unavailableDesc') }; na = true; }
    else if (pageState === 'noAccess') { n = { t: tr('app.noAccess'), d: tr('app.noAccessDesc'), b: tr('app.allowSite'), act: grantAccess }; na = true; }
    else if (pageState === 'restricted') { n = { t: tr('app.restrictedSite'), d: tr('app.restrictedSiteDesc') }; na = true; }
    else if (pageState === 'reload') { n = { t: tr('app.reloadNeeded'), d: tr('app.reloadNeededDesc'), ...reload }; na = true; }
    else if (pageState === 'outdated') { n = { t: tr('app.reloadNeeded'), d: tr('app.updatedDesc'), ...reload }; na = true; }
    else if (deepError) n = { t: tr('deep.failed'), d: tr('deep.failedDesc') };
    else if (status.deep) n = { t: tr('deep.on'), d: tr('deep.onDesc'), b: tr('deep.stop'), act: stopDeep };
    else if (status.blocked > 0) {
      n = { t: tr('app.blocked', { n: status.blocked }), d: tr(blockedReason('app.blockedDesc')) };
      if (API.canCapture) Object.assign(n, { b: tr('deep.enable'), act: startDeep }); // the platform can process it anyway
    }

    $('#app').classList.toggle('na', na);
    const key = n ? n.t + n.d + (n.b || '') : '';
    if (key === noticeKey) return;
    noticeKey = key;
    const box = $('#notice');
    box.classList.toggle('hidden', !n);
    if (!n) return;
    $('#notice-title').textContent = n.t;
    $('#notice-text').textContent = n.d;
    const btn = $('#notice-btn');
    btn.classList.toggle('hidden', !n.b);
    btn.textContent = n.b || '';
    btn.onclick = n.act || null;
  }
  /** Text key for why audio can't be processed: copy protection, another domain, or both / unknown. */
  function blockedReason(base) {
    if (status.drm && !status.foreign) return base + 'Drm';
    if (status.foreign && !status.drm) return base + 'Foreign';
    return base;
  }

  /** Booster: when none of the page's audio can be processed, the gauge says so instead of moving silently. */
  function renderUnheard() {
    const on = kind === 'web' && audio.enabled && !status.deep && status.blocked > 0 && status.sources === 0;
    $('.gauge-card').classList.toggle('unheard', on);
    const line = $('#boost-state');
    line.classList.toggle('hidden', !on);
    if (!on) return;
    $('#boost-state-text').textContent = tr(blockedReason('why.short'));
    $('#boost-state-btn').classList.toggle('hidden', !API.canCapture);
  }
  $('#boost-state-btn').addEventListener('click', () => startDeep());

  // Deep mode (where the platform supports it): process the tab's whole output instead of single sources
  let deepError = false;
  // quiet: started for a remembered output device — a failure only shows up as the device hint
  async function startDeep(quiet) {
    if (!tab) return;
    let res;
    try { res = await API.captureStart(tab.id); } catch (e) { res = { ok: false, error: String(e) }; }
    if (!(res && res.ok)) {
      if (quiet === true) { autoDeep = 'failed'; renderOutput(); } else { deepError = true; renderNotice(); }
      return;
    }
    autoDeep = null;
    connect();
  }
  let grantResult = null;
  async function grantDevices() {
    try { await API.grantOutputs(); grantResult = 'granted'; } catch { grantResult = 'denied'; }
    renderNotice();
  }
  async function stopDeep() {
    if (!tab) return;
    try { await API.captureStop(tab.id); } catch { /* the tab is gone */ }
    connect();
  }
  async function grantAccess() {
    let ok = false;
    try { ok = await API.requestAccess(tab.url); } catch { /* popup closed by the prompt */ }
    if (!ok) return;
    pageState = 'connecting';
    injected = false;
    renderNotice();
    connect(); // the background injects the scripts when the permission is added
  }
  async function reloadTab() {
    if (!tab) return;
    await API.reloadTab(tab.id);
    pageState = 'connecting';
    injected = false;
    renderNotice();
    setTimeout(connect, 800);
  }

  /* ---------------------------------------------------------
     Connection to the target tab
     --------------------------------------------------------- */
  let link = null;
  const frames = new Map(); // frame key -> { r, t }
  let gotReply = false;
  let injected = false;     // scripts were (re)injected for this tab already

  function connect() {
    if (link) link.close();
    link = null;
    frames.clear();
    gotReply = false;
    deepError = false;
    status = { sources: 0, blocked: 0, playing: 0, drm: 0, foreign: 0, deep: false, out: '' };
    if (kind !== 'web' || !tab || pageState === 'noAccess' || pageState === 'restricted') { renderNotice(); return; }
    autoDeepStart();
    const l = API.connect(tab.id);
    link = l;
    l.onMessage((m) => {
      if (m.type !== 'reply' && m.type !== 'status') return;
      gotReply = true;
      // an engine from an older version of the extension is still running in this page
      const st = m.v === AE.PROTOCOL ? 'ok' : 'outdated';
      if (st !== pageState && (st === 'ok' || m.top)) { pageState = st; renderNotice(); }
      const prev = frames.get(m.frame);
      frames.set(m.frame, { r: { ...(prev ? prev.r : {}), ...m }, t: performance.now() });
    });
    l.onClose(() => {
      if (link !== l) return;
      link = null;
      if (!gotReply) recover();
    });
    setTimeout(() => {
      if (link !== l || gotReply) return;
      l.close();
      link = null;
      recover();
    }, 700);
  }

  /** No content script answered: inject it (tab opened before install), or explain why that is impossible. */
  async function recover() {
    if (injected) { pageState = 'reload'; renderNotice(); return; }
    injected = true;
    let res;
    try { res = await API.inject(tab.id); } catch (e) { res = { ok: false, error: String(e) }; }
    if (res && res.ok) { setTimeout(connect, 150); return; }
    // Firefox reports protected pages (PDF viewer, quarantined domains) as a permission error too,
    // so decide by the actual permission instead of the error text.
    let access = true;
    try { access = await API.hasAccess(tab.url); } catch { /* assume access */ }
    pageState = access ? 'restricted' : 'noAccess';
    renderNotice();
  }

  function aggregate() {
    const now = performance.now();
    const out = { sources: 0, blocked: 0, playing: 0, drm: 0, foreign: 0, deep: false, out: '', l: 0, r: 0, gr: 0, spectrum: null, fresh: false };
    frames.forEach((f, k) => {
      const age = now - f.t;
      if (age > 2000) { frames.delete(k); return; }
      out.sources += f.r.sources || 0;
      out.blocked += f.r.blocked || 0;
      out.playing += f.r.playing || 0;
      out.drm += f.r.drm || 0;
      out.foreign += f.r.foreign || 0;
      if (f.r.deep) out.deep = true;
      if (typeof f.r.out === 'string' && (f.r.deep || !out.out)) out.out = f.r.out; // output device state (deep mode wins)
      if (age > 400) return;
      const lv = f.r.levels;
      if (lv) {
        out.fresh = true;
        out.l = Math.max(out.l, lv.l.peak);
        out.r = Math.max(out.r, lv.r.peak);
        out.gr = Math.min(out.gr, lv.gr);
      }
      if (f.r.spectrum) out.spectrum = out.spectrum ? out.spectrum.map((v, i) => Math.max(v, f.r.spectrum[i])) : f.r.spectrum;
    });
    // the whole tab is processed (deep mode): nothing is left unprocessed or untouched
    if (out.deep) { out.blocked = 0; out.playing = 0; out.drm = 0; out.foreign = 0; }
    return out;
  }

  /* ---------------------------------------------------------
     Output device per tab (Booster row + a select in every Mixer row)
     --------------------------------------------------------- */
  let outDevices = { granted: false, devices: [] }; // 'deep': the devices the extension can see
  let autoDeep = null;                              // 'deep': pending | failed — deep mode for a remembered device
  let autoDeepTab = null;

  async function loadOutputs() {
    if (OUT_MODE === 'deep') outDevices = await API.listOutputs();
  }
  if (OUT_MODE && navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      await loadOutputs();
      renderOutput();
      if (currentPanel === 'mixer') refreshMixer();
    });
  }

  function outOptions(h) {
    const saved = AE.outputFor(data, h);
    const opts = [{ v: '', t: tr('dev.default') }];
    if (OUT_MODE === 'deep' && outDevices.granted) opts.push(...outDevices.devices.map((d) => ({ v: d.id, t: d.label || d.id.slice(0, 8) })));
    if (saved && !opts.some((o) => o.v === saved.id)) opts.push({ v: saved.id, t: saved.label || '…' });
    if (OUT_MODE === 'deep' && !outDevices.granted) opts.push({ v: '#show', t: tr('dev.show') });
    if (OUT_MODE === 'page') opts.push({ v: '#choose', t: tr('dev.choose') });
    const cur = saved ? saved.id : '';
    return opts.map((o) => ({ ...o, sel: o.v === cur }));
  }
  const optionsHTML = (h) => outOptions(h).map((o) => `<option value="${esc(o.v)}"${o.sel ? ' selected' : ''}>${esc(o.t)}</option>`).join('');

  /** Why the tab doesn't (yet) play on its chosen device; '' when it does or nothing is chosen. */
  function outHint(h, current) {
    if (!AE.outputFor(data, h)) return '';
    const out = current ? status.out : '';
    if (out === 'lost') return tr('dev.lost');
    if (out === 'failed') return tr('dev.failed');
    if (OUT_MODE === 'page') return current && out === 'wait' ? tr('dev.wait') : '';
    if (!current) return tr('dev.otherTab');
    if (status.deep) return tr('dev.deep');
    return autoDeep === 'failed' ? tr('deep.failedDesc') : '';
  }

  function renderOutput() {
    const on = !!OUT_MODE && kind === 'web' && API.context !== 'tab' && pageState !== 'noAccess' && pageState !== 'restricted';
    $('#dev-row').classList.toggle('hidden', !on);
    const hint = on ? outHint(host, true) : '';
    $('#dev-hint').classList.toggle('hidden', !hint);
    $('#dev-hint').textContent = hint;
    if (!on) return;
    const sel = $('#dev-select');
    if (document.activeElement === sel) return; // don't rebuild an open list
    sel.replaceChildren(...outOptions(host).map((o) => new Option(o.t, o.v, o.sel, o.sel)));
    sel.title = sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : '';
  }

  async function chooseOutput(t, h, value, sel) {
    const saved = AE.outputFor(data, h);
    if (value === '#show' || value === '#choose') {
      sel.value = saved ? saved.id : '';
      if (value === '#show') API.openTab(API.pageUrl('?page=1&grant=devices'));
      else {
        // Firefox: the device picker can only open from a click in the page itself
        try { await API.askOutput(t.id, { ask: tr('dev.ask'), close: tr('dev.close') }); } catch { /* no content script */ }
        if (!tab || t.id !== tab.id) API.activateTab(t.id);
      }
      if (API.context === 'popup') window.close(); // the page / the new tab needs the focus
      return;
    }
    const outputs = { ...data.outputs };
    if (value) outputs[h] = { id: value, label: ((outDevices.devices.find((d) => d.id === value)) || saved || {}).label || '' };
    else delete outputs[h];
    data.outputs = outputs;
    lastEdit = Date.now();
    API.persist({ outputs });
    // Chrome / Edge: the chosen device needs deep mode (allowed now: the extension was opened on this tab)
    if (OUT_MODE === 'deep' && value && API.canCapture && tab && t.id === tab.id) {
      const id = tab.id;
      API.captureIsOn(id).then((on) => { if (!on && tab && tab.id === id) startDeep(true); }, () => {});
    }
    renderOutput();
  }
  $('#dev-select').addEventListener('change', (e) => { if (tab) chooseOutput(tab, host, e.target.value, e.target); });

  /** Chrome / Edge: a remembered device for this site → start deep mode as soon as the extension is opened here. */
  function autoDeepStart() {
    if (OUT_MODE !== 'deep' || !API.canCapture || API.context === 'tab' || !tab || !AE.outputFor(data, host)) return;
    if (autoDeepTab === tab.id) return;
    autoDeepTab = tab.id;
    autoDeep = 'pending';
    const id = tab.id;
    API.captureIsOn(id).then((on) => { if (on) autoDeep = null; else if (tab && tab.id === id) startDeep(true); }, () => {});
  }

  /* =========================================================
     BOOSTER
     ========================================================= */
  const boost = $('#boost');
  const G = { cx: 100, cy: 100, r: 84, start: 135, sweep: 270, max: 0 };
  const angleOf = (v) => ((G.start + (v / G.max) * G.sweep) * Math.PI) / 180;

  /** Gauge ticks, slider, scale and chips follow the user's maximum volume (Settings). */
  function buildGainScale() {
    const cap = AE.gainCap(data.app);
    if (cap === G.max) return;
    G.max = cap;
    boost.max = cap;
    const n = cap % 20 === 0 ? 4 : 2; // labels on round numbers: 0/75/150, 0/50/…/200, 0/150/…/600
    setHTML($('#boost-scale'), Array.from({ length: n + 1 }, (_, i) => `<span>${(cap / n) * i}%</span>`).join(''));
    $$('#boost-presets .chip').forEach((c) => c.classList.toggle('hidden', +c.dataset.v > cap));
    let s = '';
    const major = cap <= 300 ? 50 : 100; // labelled ticks: enough numbers on a short scale too
    for (let v = 0; v <= G.max; v += major / 2) {
      const a = angleOf(v), isMajor = v % major === 0, unity = v === 100;
      const r1 = 70, r2 = isMajor ? 76 : 74;
      const cls = 'g-tick' + (isMajor ? ' major' : '') + (unity ? ' unity' : '');
      s += `<line class="${cls}" x1="${G.cx + r1 * Math.cos(a)}" y1="${G.cy + r1 * Math.sin(a)}" x2="${G.cx + r2 * Math.cos(a)}" y2="${G.cy + r2 * Math.sin(a)}"/>`;
      if (isMajor && v !== 0 && v !== G.max) {
        const rl = 62;
        s += `<text class="g-tick-label${unity ? ' unity' : ''}" x="${G.cx + rl * Math.cos(a)}" y="${G.cy + rl * Math.sin(a)}">${v}</text>`;
      }
    }
    setSVG($('#gauge-ticks'), s);
  }

  function updateGauge() {
    const v = audio.gain;
    const dash = `${(v / G.max) * 100} 100`;
    $('#gauge-arc').style.strokeDasharray = dash;
    $('#gauge-glow').style.strokeDasharray = dash;
    const a = angleOf(v), knob = $('#gauge-knob');
    knob.setAttribute('cx', G.cx + G.r * Math.cos(a));
    knob.setAttribute('cy', G.cy + G.r * Math.sin(a));
    $('#gauge-value').textContent = v;
    $('#gauge-db').textContent = v === 0 ? '−∞ dB' : fmt.db(20 * Math.log10(v / 100));
    $$('#boost-presets .chip').forEach((c) => c.classList.toggle('active', +c.dataset.v === v));
  }
  /** `exact`: typed values and Shift+wheel keep 1% steps; everything else snaps to 5%. */
  function setGain(v, exact) {
    audio.gain = clamp(exact ? Math.round(v) : Math.round(v / 5) * 5, 0, G.max);
    boost.value = audio.gain;
    paintRange(boost);
    commit();
  }
  $$('#boost-presets .chip').forEach((c) => c.addEventListener('click', () => setGain(+c.dataset.v)));
  $('#boost-dec').addEventListener('click', () => setGain(audio.gain - 10));
  $('#boost-inc').addEventListener('click', () => setGain(audio.gain + 10));
  $('.gauge').addEventListener('wheel', (e) => {
    e.preventDefault();
    const d = e.deltaY || e.deltaX; // with Shift, some systems turn the wheel into horizontal scrolling
    if (!d) return;
    setGain(audio.gain + Math.sign(-d) * (e.shiftKey ? 1 : 5), e.shiftKey);
  }, { passive: false });
  typeable($('#gauge-value'), { get: () => audio.gain, set: (v) => setGain(v, true), min: () => 0, max: () => G.max });

  // meters: dB → position matching the −48/−24/−12/−6/0 scale labels
  const MPTS = [[-48, 0], [-24, 25], [-12, 50], [-6, 75], [0, 100]];
  function dbPos(db) {
    if (!(db > -48)) return 0;
    if (db >= 0) return 100;
    for (let i = 1; i < MPTS.length; i++) {
      if (db <= MPTS[i][0]) {
        const [d0, p0] = MPTS[i - 1], [d1, p1] = MPTS[i];
        return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
      }
    }
    return 100;
  }
  const meter = { l: 0, r: 0, hold: -Infinity, holdT: 0, gr: 0 };
  function renderMeters(agg, t) {
    const toDb = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
    for (const ch of ['l', 'r']) {
      const pos = dbPos(toDb(agg[ch]));
      meter[ch] = pos > meter[ch] ? pos : Math.max(pos, meter[ch] - 2.2);
      $('#meter-' + ch).style.setProperty('--lvl', meter[ch].toFixed(1) + '%');
    }
    const peakDb = toDb(Math.max(agg.l, agg.r));
    if (peakDb > meter.hold || t - meter.holdT > 1500) { meter.hold = peakDb; meter.holdT = t; }
    meter.gr += (agg.gr - meter.gr) * 0.3;
    $('#gr-fill').style.width = clamp((-meter.gr / 12) * 100, 0, 100) + '%';
    if (Math.floor(t / 150) % 2 === 0) {
      $('#peak-out').textContent = meter.hold > -90 ? fmt.db(meter.hold) : '−∞ dB';
      $('#gr-out').textContent = fmt.db(Math.min(0, meter.gr));
      const badge = $('#out-badge');
      let cls = 'ok', txt = 'OK';
      if (!audio.enabled || kind !== 'web') { cls = 'idle'; txt = 'OFF'; }
      else if (!agg.fresh || peakDb < -90) { cls = 'idle'; txt = '—'; }
      else if (meter.gr < -0.5) { cls = 'lim'; txt = 'LIMIT'; }
      badge.className = 'badge ' + cls;
      badge.textContent = txt;
    }
  }

  /* =========================================================
     EFFECTS
     ========================================================= */
  /* Speed slider: logarithmic 0.1–16×, so 1× sits near the middle and the fine steps stay where they matter. */
  const speed = $('#speed');
  const SPEED_SPAN = Math.log(AE.SPEED_MAX / AE.SPEED_MIN);
  const AUDIBLE = PLATFORM.audibleSpeed || [0, Infinity];
  const speedToPos = (v) => Math.round((Math.log(Math.min(AE.SPEED_MAX, Math.max(AE.SPEED_MIN, v)) / AE.SPEED_MIN) / SPEED_SPAN) * 1000);
  function posToSpeed(p) {
    const v = AE.SPEED_MIN * Math.exp((p / 1000) * SPEED_SPAN);
    const q = v < 4 ? 0.05 : v < 8 ? 0.25 : 0.5;
    return Math.min(AE.SPEED_MAX, Math.max(AE.SPEED_MIN, +(Math.round(v / q) * q).toFixed(2)));
  }
  setHTML($('#speed-scale'), [0.1, 0.25, 0.5, 1, 2, 4, 8, 16].map((v) => `<span style="left:${speedToPos(v) / 10}%">${v}</span>`).join(''));

  /** Pill, chips and the "no sound" note from `v`; the thumb too unless the user is dragging it. */
  function renderSpeed(v = audio.fx.speed.value, moveThumb = true) {
    if (moveThumb) speed.value = speedToPos(v);
    paintRange(speed);
    $('#fx-speed').textContent = fmt.speed(v);
    $$('#speed-presets .chip').forEach((c) => c.classList.toggle('active', +c.dataset.v === v));
    $('#speed-muted').classList.toggle('hidden', v >= AUDIBLE[0] && v <= AUDIBLE[1]);
  }
  speed.addEventListener('input', () => {
    audio.fx.speed.value = posToSpeed(+speed.value);
    renderSpeed(audio.fx.speed.value, false);
    commit();
  });
  // arrow keys: 0.05× per press (one slider position would be far less than a visible step)
  speed.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    audio.fx.speed.value = Math.min(AE.SPEED_MAX, Math.max(AE.SPEED_MIN, +(audio.fx.speed.value + d * 0.05).toFixed(2)));
    renderSpeed();
    commit();
  });
  $$('#speed-presets .chip').forEach((c) => c.addEventListener('click', () => {
    audio.fx.speed.value = +c.dataset.v;
    renderSpeed();
    commit();
  }));
  typeable($('#fx-speed'), {
    get: () => audio.fx.speed.value,
    set: (v) => { audio.fx.speed.value = v; renderSpeed(); commit(); },
    min: () => AE.SPEED_MIN, max: () => AE.SPEED_MAX, decimals: 2,
  });

  /* =========================================================
     EQUALIZER
     ========================================================= */
  const PRESETS = {
    flat: AE.DEFAULT_BANDS,
    bass: [{ type: 'lowshelf', f: 110, g: 7, q: 0.7 }, { type: 'peaking', f: 60, g: 2, q: 1.2 }, { type: 'peaking', f: 400, g: -1.5, q: 1 }],
    vocal: [{ type: 'highpass', f: 90, g: 0, q: 0.71 }, { type: 'peaking', f: 300, g: -2, q: 1 }, { type: 'peaking', f: 2500, g: 4, q: 1.2 }, { type: 'peaking', f: 5000, g: 2, q: 1.5 }],
    treble: [{ type: 'highshelf', f: 4000, g: 6, q: 0.7 }, { type: 'peaking', f: 10000, g: 2, q: 1 }],
    loudness: [{ type: 'lowshelf', f: 100, g: 6, q: 0.7 }, { type: 'peaking', f: 1000, g: -2, q: 0.8 }, { type: 'highshelf', f: 8000, g: 5, q: 0.7 }],
    podcast: [{ type: 'highpass', f: 80, g: 0, q: 0.71 }, { type: 'peaking', f: 200, g: -2.5, q: 1 }, { type: 'peaking', f: 3000, g: 3.5, q: 1 }, { type: 'lowpass', f: 14000, g: 0, q: 0.71 }],
    rock: [{ type: 'lowshelf', f: 90, g: 5, q: 0.7 }, { type: 'peaking', f: 800, g: -2, q: 1 }, { type: 'peaking', f: 3500, g: 3, q: 1 }, { type: 'highshelf', f: 9000, g: 4, q: 0.7 }],
    electronic: [{ type: 'peaking', f: 50, g: 6, q: 1 }, { type: 'peaking', f: 250, g: -2, q: 1.2 }, { type: 'peaking', f: 2000, g: -1, q: 1 }, { type: 'highshelf', f: 8000, g: 5, q: 0.7 }],
    classical: [{ type: 'lowshelf', f: 120, g: 2, q: 0.7 }, { type: 'peaking', f: 1500, g: -1, q: 0.7 }, { type: 'highshelf', f: 7000, g: 3, q: 0.7 }],
  };

  const eq = (() => {
    const FS = 48000, FMIN = 20, FMAX = 20000, GMAX = 15, PAD = 16, MAX_BANDS = 8;
    const COLORS = ['#f472b6', '#a78bfa', '#60a5fa', '#22d3ee', '#34d399', '#fbbf24', '#fb923c', '#e879f9'];
    const NO_GAIN = new Set(['highpass', 'lowpass', 'notch']);
    const NO_Q = new Set(['lowshelf', 'highshelf']);

    let sel = 0, W = 0, H = 0, drag = null;
    const box = $('#eq-graph'), svg = $('#eq-svg'), cv = $('#eq-canvas');
    const ctx = cv.getContext('2d');
    const E = () => audio.eq;

    const LOGR = Math.log(FMAX / FMIN);
    const f2x = (f) => (W * Math.log(f / FMIN)) / LOGR;
    const x2f = (x) => FMIN * Math.exp((x / W) * LOGR);
    const g2y = (g) => H / 2 - (g / GMAX) * (H / 2 - PAD);
    const y2g = (y) => ((H / 2 - y) / (H / 2 - PAD)) * GMAX;

    /* RBJ cookbook biquads — same formulas as Web Audio's BiquadFilterNode */
    function coeffs({ type, f, g, q }) {
      const A = Math.pow(10, g / 40), w0 = (2 * Math.PI * f) / FS;
      const cs = Math.cos(w0), sn = Math.sin(w0);
      const alpha = sn / (2 * q);
      const sA = 2 * Math.sqrt(A) * (sn / 2) * Math.SQRT2; // shelf slope S = 1
      switch (type) {
        case 'peaking': return [1 + alpha * A, -2 * cs, 1 - alpha * A, 1 + alpha / A, -2 * cs, 1 - alpha / A];
        case 'lowshelf': return [A * ((A + 1) - (A - 1) * cs + sA), 2 * A * ((A - 1) - (A + 1) * cs), A * ((A + 1) - (A - 1) * cs - sA), (A + 1) + (A - 1) * cs + sA, -2 * ((A - 1) + (A + 1) * cs), (A + 1) + (A - 1) * cs - sA];
        case 'highshelf': return [A * ((A + 1) + (A - 1) * cs + sA), -2 * A * ((A - 1) + (A + 1) * cs), A * ((A + 1) + (A - 1) * cs - sA), (A + 1) - (A - 1) * cs + sA, 2 * ((A - 1) - (A + 1) * cs), (A + 1) - (A - 1) * cs - sA];
        case 'lowpass': return [(1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + alpha, -2 * cs, 1 - alpha];
        case 'highpass': return [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + alpha, -2 * cs, 1 - alpha];
        case 'notch': return [1, -2 * cs, 1, 1 + alpha, -2 * cs, 1 - alpha];
      }
      return [1, 0, 0, 1, 0, 0];
    }
    function magDb(c, f) {
      const w = (2 * Math.PI * f) / FS;
      const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
      const nr = c[0] + c[1] * c1 + c[2] * c2, ni = -(c[1] * s1 + c[2] * s2);
      const dr = c[3] + c[4] * c1 + c[5] * c2, di = -(c[4] * s1 + c[5] * s2);
      return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di) + 1e-12);
    }

    function activeFilters() {
      const e = E();
      if (e.mode === 'param') return e.bands;
      const freqs = e.mode === 'g10' ? AE.G10 : AE.G31;
      const q = e.mode === 'g10' ? 1.41 : 4.32;
      return freqs.map((f, i) => ({ type: 'peaking', f, g: e[e.mode][i] || 0, q }));
    }

    function curvePath(filters, offset = 0) {
      const cs = filters.map(coeffs);
      let d = '';
      for (let x = 0; x <= W; x += 2) {
        const f = x2f(x);
        let db = offset;
        for (const c of cs) db += magDb(c, f);
        d += (x ? 'L' : 'M') + x + ' ' + clamp(g2y(db), -20, H + 20).toFixed(1);
      }
      return d;
    }

    function render() {
      if (!box.offsetParent) return;
      W = box.clientWidth; H = box.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      const e = E();

      let s = `<defs>
        <linearGradient id="eqStroke" x1="0" x2="1"><stop offset="0" style="stop-color:var(--a1)"/><stop offset="1" style="stop-color:var(--a2)"/></linearGradient>
        <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--a1);stop-opacity:.28"/><stop offset="1" style="stop-color:var(--a2);stop-opacity:0"/></linearGradient>
      </defs>`;
      [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach((f) => {
        const x = f2x(f).toFixed(1);
        s += `<line class="eq-svg-grid" x1="${x}" x2="${x}" y1="0" y2="${H}"/>`;
        s += `<text class="eq-svg-label" x="${+x + 3}" y="${H - 5}">${f >= 1000 ? f / 1000 + 'k' : f}</text>`;
      });
      [-12, -6, 6, 12].forEach((g) => {
        const y = g2y(g).toFixed(1);
        s += `<line class="eq-svg-grid" x1="0" x2="${W}" y1="${y}" y2="${y}"/>`;
        s += `<text class="eq-svg-label" x="4" y="${+y - 3}">${g > 0 ? '+' : '−'}${Math.abs(g)}</text>`;
      });
      s += `<line class="eq-svg-zero" x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}"/>`;

      if (audio.autoeq.id) {
        s += `<path class="ae-curve" d="${curvePath(audio.autoeq.filters, audio.autoeq.preamp)}"/>`;
      }
      if (e.mode === 'param' && e.bands[sel]) {
        const col = COLORS[sel % COLORS.length];
        const d = curvePath([e.bands[sel]]);
        s += `<path class="area band-area" d="${d}L${W} ${H / 2}L0 ${H / 2}Z" style="fill:${col};fill-opacity:.12;stroke:${col};stroke-opacity:.6"/>`;
      }
      const d = curvePath(activeFilters(), e.preamp);
      s += `<path class="area" d="${d}L${W} ${H}L0 ${H}Z" fill="url(#eqFill)"/>`;
      s += `<path class="curve" d="${d}"/>`;

      if (e.mode === 'param') {
        e.bands.forEach((b, i) => {
          const x = f2x(b.f), y = g2y(NO_GAIN.has(b.type) ? 0 : b.g), col = COLORS[i % COLORS.length];
          const on = i === sel;
          s += `<g class="node" data-i="${i}">
            ${on ? `<circle class="halo" cx="${x}" cy="${y}" r="15" fill="${col}"/>` : ''}
            <circle cx="${x}" cy="${y}" r="${on ? 9 : 8}" fill="${col}" stroke="${on ? '#fff' : 'rgba(0,0,0,.35)'}" stroke-width="${on ? 2 : 1}"/>
            <text x="${x}" y="${y}">${i + 1}</text>
          </g>`;
        });
        if (drag !== null && e.bands[sel]) {
          const b = e.bands[sel], x = clamp(f2x(b.f), 40, W - 40), y = g2y(NO_GAIN.has(b.type) ? 0 : b.g);
          const label = fmt.hz(b.f) + (NO_GAIN.has(b.type) ? '' : ' · ' + fmt.db(b.g));
          s += `<text class="node-tip" x="${x}" y="${y < 40 ? y + 30 : y - 18}">${label}</text>`;
        }
      } else {
        const freqs = e.mode === 'g10' ? AE.G10 : AE.G31;
        freqs.forEach((f, i) => {
          s += `<circle cx="${f2x(Math.min(f, 19500))}" cy="${g2y(e[e.mode][i])}" r="${e.mode === 'g10' ? 3.5 : 2.2}" fill="#fff" opacity=".85"/>`;
        });
      }
      setSVG(svg, s);
    }

    function edited() {
      E().preset = 'custom';
      presetSel.value = 'custom';
      $('#preset-del-btn').classList.add('hidden');
      commit();
    }

    /* ----- dragging nodes ----- */
    function pointerPos(e) {
      const r = svg.getBoundingClientRect();
      return { x: clamp(e.clientX - r.left, 0, W), y: clamp(e.clientY - r.top, PAD, H - PAD) };
    }
    svg.addEventListener('pointerdown', (e) => {
      const node = e.target.closest('.node');
      if (!node) return;
      sel = +node.dataset.i;
      drag = sel;
      svg.setPointerCapture(e.pointerId);
      syncEditor();
      render();
    });
    svg.addEventListener('pointermove', (e) => {
      if (drag === null) return;
      const { x, y } = pointerPos(e), b = E().bands[drag];
      b.f = Math.round(clamp(x2f(x), FMIN, FMAX));
      if (!NO_GAIN.has(b.type)) b.g = Math.round(y2g(y) * 10) / 10;
      syncEditor();
      render();
      edited();
    });
    const endDrag = () => { if (drag !== null) { drag = null; render(); } };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);
    onDoubleTap(svg, '.node', (node) => {
      E().bands[+node.dataset.i].g = 0;
      syncEditor(); render(); edited();
    });
    box.addEventListener('wheel', (e) => {
      const b = E().bands[sel];
      if (E().mode !== 'param' || !b || NO_Q.has(b.type)) return;
      e.preventDefault();
      b.q = clamp(+(b.q * (e.deltaY < 0 ? 1.1 : 1 / 1.1)).toFixed(2), 0.1, 12);
      syncEditor(); render(); edited();
    }, { passive: false });

    /* ----- band editor ----- */
    const typeSel = $('#band-type'), fR = $('#band-f'), gR = $('#band-g'), qR = $('#band-q');
    const sliderToF = (v) => FMIN * Math.exp((v / 1000) * LOGR);
    const fToSlider = (f) => (1000 * Math.log(f / FMIN)) / LOGR;

    function buildChips() {
      const bands = E().bands;
      setHTML($('#band-chips'), bands.map((b, i) =>
        `<button class="band-chip${i === sel ? ' active' : ''}" data-i="${i}" style="--c:${COLORS[i % COLORS.length]}"><i>${i + 1}</i>${fmt.hz(b.f)}</button>`
      ).join('') + (bands.length < MAX_BANDS ? `<button class="band-chip add" id="band-add"><svg class="ic"><use href="#i-plus"/></svg>${esc(tr('eq.addBand'))}</button>` : ''));
    }
    $('#band-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.band-chip');
      if (!chip) return;
      if (chip.id === 'band-add') {
        E().bands.push({ type: 'peaking', f: 1000, g: 0, q: 1 });
        sel = E().bands.length - 1;
        edited();
      } else sel = +chip.dataset.i;
      syncEditor(); render();
    });
    $('#band-del').addEventListener('click', () => {
      const bands = E().bands;
      if (bands.length <= 1) return;
      bands.splice(sel, 1);
      sel = Math.min(sel, bands.length - 1);
      syncEditor(); render(); edited();
    });

    function syncEditor() {
      const bands = E().bands;
      sel = clamp(sel, 0, bands.length - 1);
      buildChips();
      const b = bands[sel];
      if (!b) return;
      typeSel.value = b.type;
      fR.value = fToSlider(b.f); paintRange(fR); $('#bf-out').textContent = fmt.hz(b.f);
      gR.value = b.g; paintRange(gR); $('#bg-out').textContent = fmt.db(b.g);
      qR.value = b.q; paintRange(qR); $('#bq-out').textContent = (+b.q).toFixed(2);
      gR.closest('.param').classList.toggle('disabled', NO_GAIN.has(b.type));
      qR.closest('.param').classList.toggle('disabled', NO_Q.has(b.type));
    }
    typeSel.addEventListener('change', () => { E().bands[sel].type = typeSel.value; syncEditor(); render(); edited(); });
    fR.addEventListener('input', () => { E().bands[sel].f = Math.round(sliderToF(+fR.value)); syncEditor(); render(); edited(); });
    gR.addEventListener('input', () => { E().bands[sel].g = +gR.value; syncEditor(); render(); edited(); });
    qR.addEventListener('input', () => { E().bands[sel].q = +qR.value; syncEditor(); render(); edited(); });

    /* ----- presets ----- */
    const presetSel = $('#eq-preset');
    const BUILTIN = ['flat', 'bass', 'vocal', 'treble', 'loudness', 'podcast', 'rock', 'electronic', 'classical'];
    function renderPresets() {
      const user = data.presets.map((p) => `<option value="user:${esc(p.id)}">${esc(p.name)}</option>`).join('');
      setHTML(presetSel,
        `<option value="custom">${esc(tr('eq.p.custom'))}</option>` +
        `<optgroup label="${esc(tr('eq.builtin'))}">${BUILTIN.map((k) => `<option value="${k}">${esc(tr('eq.p.' + k))}</option>`).join('')}</optgroup>` +
        (user ? `<optgroup label="${esc(tr('eq.myPresets'))}">${user}</optgroup>` : ''));
      const v = E().preset;
      presetSel.value = [...presetSel.options].some((o) => o.value === v) ? v : 'custom';
      $('#preset-del-btn').classList.toggle('hidden', !presetSel.value.startsWith('user:'));
    }
    presetSel.addEventListener('change', () => {
      const v = presetSel.value, e = E();
      if (BUILTIN.includes(v)) {
        e.mode = 'param';
        e.bands = AE.clone(PRESETS[v]);
      } else if (v.startsWith('user:')) {
        const p = data.presets.find((x) => 'user:' + x.id === v);
        if (p) Object.assign(e, AE.clone(p.eq));
      }
      e.preset = v;
      sel = 0;
      setMode(e.mode, true);
      $('#preset-del-btn').classList.toggle('hidden', !v.startsWith('user:'));
      commit();
    });
    $('#preset-save-btn').addEventListener('click', () => {
      const row = $('#preset-save-row');
      row.classList.toggle('hidden');
      if (!row.classList.contains('hidden')) $('#preset-name').focus();
    });
    function savePreset() {
      const e = E();
      const name = $('#preset-name').value.trim() || `${tr('eq.preset')} ${data.presets.length + 1}`;
      const id = Date.now().toString(36);
      data.presets = [...data.presets, { id, name, eq: { mode: e.mode, bands: e.bands, g10: e.g10, g31: e.g31, preamp: e.preamp } }];
      API.persist({ presets: data.presets });
      e.preset = 'user:' + id;
      $('#preset-name').value = '';
      $('#preset-save-row').classList.add('hidden');
      renderPresets();
      commit();
    }
    $('#preset-save-ok').addEventListener('click', savePreset);
    $('#preset-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') savePreset(); });
    $('#preset-del-btn').addEventListener('click', () => {
      const v = presetSel.value;
      data.presets = data.presets.filter((p) => 'user:' + p.id !== v);
      API.persist({ presets: data.presets });
      E().preset = 'custom';
      renderPresets();
      commit();
    });

    /* ----- graphic EQ (vertical sliders) ----- */
    const GEQ_MAX = 12;
    function buildGraphic() {
      const e = E();
      const freqs = e.mode === 'g10' ? AE.G10 : AE.G31;
      const wrap = $('#geq');
      wrap.classList.toggle('dense', e.mode === 'g31');
      setHTML(wrap, freqs.map((f, i) => {
        const showLabel = e.mode === 'g10' || i % 3 === 0;
        const lbl = f >= 1000 ? (f / 1000) + 'k' : Math.round(f);
        return `<div class="vs" data-i="${i}">
          <span class="vs-val"></span>
          <div class="vs-track"><div class="vs-fill"></div><div class="vs-thumb"></div></div>
          <span class="vs-label">${showLabel ? lbl : ''}</span>
        </div>`;
      }).join(''));
      $$('.vs', wrap).forEach((el, i) => paintVs(el, e[e.mode][i]));
    }
    function paintVs(el, v) {
      const pos = 50 - (v / GEQ_MAX) * 50;
      const thumb = el.querySelector('.vs-thumb'), fill = el.querySelector('.vs-fill');
      thumb.style.top = pos + '%';
      fill.style.top = Math.min(pos, 50) + '%';
      fill.style.bottom = (100 - Math.max(pos, 50)) + '%';
      el.querySelector('.vs-val').textContent = (v > 0 ? '+' : '') + (+v).toFixed(1);
    }
    let vsDrag = null;
    $('#geq').addEventListener('pointerdown', (e) => {
      const el = e.target.closest('.vs');
      if (!el) return;
      vsDrag = el;
      el.setPointerCapture(e.pointerId);
      moveVs(e);
    });
    $('#geq').addEventListener('pointermove', (e) => { if (vsDrag) moveVs(e); });
    $('#geq').addEventListener('pointerup', () => { vsDrag = null; });
    onDoubleTap($('#geq'), '.vs', (el) => {
      E()[E().mode][+el.dataset.i] = 0;
      paintVs(el, 0); render(); edited();
    });
    function moveVs(e) {
      const rect = vsDrag.querySelector('.vs-track').getBoundingClientRect();
      const t = clamp((e.clientY - rect.top) / rect.height, 0, 1);
      const v = Math.round((1 - 2 * t) * GEQ_MAX * 2) / 2;
      E()[E().mode][+vsDrag.dataset.i] = v;
      paintVs(vsDrag, v);
      render();
      edited();
    }

    /* ----- mode switch ----- */
    function setMode(m, silent) {
      E().mode = m;
      $$('#eq-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
      $('#eq-param').classList.toggle('hidden', m !== 'param');
      $('#eq-graphic').classList.toggle('hidden', m === 'param');
      updateHint();
      if (m !== 'param') buildGraphic();
      else syncEditor();
      render();
      if (!silent) commit();
    }
    function updateHint() {
      $('#graph-hint').textContent = tr((E().mode === 'param' ? 'eq.hintParam' : 'eq.hintGraphic') + (TOUCH ? 'Touch' : ''));
    }
    $$('#eq-mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

    /* ----- spectrum ----- */
    const BARS = 72;
    const disp = new Float32Array(BARS);
    function drawSpectrum(spec) {
      if (!W) return;
      ctx.clearRect(0, 0, W, H);
      if (!data.app.animations) return;
      const grad = ctx.createLinearGradient(0, H, 0, 0);
      grad.addColorStop(0, hexA(palette.a2, 0.05));
      grad.addColorStop(1, hexA(palette.a1, 0.45));
      ctx.fillStyle = grad;
      const bw = W / BARS;
      for (let i = 0; i < BARS; i++) {
        const target = spec ? spec[i] : 0;
        disp[i] += (target - disp[i]) * (target > disp[i] ? 0.5 : 0.12);
        const h = disp[i] * H * 0.85;
        if (h < 0.5) continue;
        ctx.beginPath();
        ctx.roundRect(i * bw + 1, H - h, bw - 2, h, [2, 2, 0, 0]);
        ctx.fill();
      }
    }

    function refresh() {
      renderPresets();
      setMode(E().mode, true);
    }

    return { render, refresh, syncEditor, updateHint, drawSpectrum, get visible() { return !!box.offsetParent; } };
  })();

  function hexA(color, a) {
    const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color || '');
    if (!m) return `rgba(139,92,246,${a})`;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
  }

  /* ---------------------------------------------------------
     AutoEq headphone correction
     --------------------------------------------------------- */
  let aeIndex = null;
  const aeSearch = $('#ae-search'), aeQ = $('#ae-q'), aeResults = $('#ae-results');

  function renderAutoEq() {
    const set = !!audio.autoeq.id;
    $('#ae-name').textContent = set ? audio.autoeq.name : tr('eq.off');
    $('#ae-pick').classList.toggle('set', set);
    $('#ae-pick').title = set && audio.autoeq.src ? `AutoEq · ${audio.autoeq.src}` : '';
    $('#ae-clear').classList.toggle('hidden', !set);
  }

  async function loadAutoEqIndex() {
    if (aeIndex) return aeIndex;
    const cached = await API.getRaw('autoeqIndex');
    if (cached && Array.isArray(cached.items) && Date.now() - cached.t < 30 * 864e5) return (aeIndex = cached.items);
    const res = await fetch(AUTOEQ_BASE + 'INDEX.md');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const items = [];
    for (const line of (await res.text()).split('\n')) {
      const m = /^- \[(.+?)\]\(\.\/(.+?)\) by (.+)$/.exec(line.trim());
      if (m) items.push([m[1], m[2], m[3]]);
    }
    if (!items.length) throw new Error('empty index');
    API.save({ autoeqIndex: { t: Date.now(), items } });
    return (aeIndex = items);
  }

  $('#ae-pick').addEventListener('click', async () => {
    const open = aeSearch.classList.toggle('hidden') === false;
    if (!open) return;
    aeQ.value = '';
    aeQ.focus();
    setHTML(aeResults, `<div class="ae-msg">${esc(tr('eq.loading'))}</div>`);
    try {
      await loadAutoEqIndex();
      setHTML(aeResults, '');
    } catch {
      setHTML(aeResults, `<div class="ae-msg">${esc(tr('eq.loadError'))}</div>`);
    }
  });

  let aeTimer = 0;
  aeQ.addEventListener('input', () => {
    clearTimeout(aeTimer);
    aeTimer = setTimeout(() => {
      if (!aeIndex) return;
      const tokens = aeQ.value.toLowerCase().split(/\s+/).filter(Boolean);
      if (!tokens.length) { setHTML(aeResults, ''); return; }
      const found = [];
      for (let i = 0; i < aeIndex.length && found.length < 40; i++) {
        const name = aeIndex[i][0].toLowerCase();
        if (tokens.every((t) => name.includes(t))) found.push(i);
      }
      setHTML(aeResults, found.length
        ? found.map((i) => `<button class="ae-item" data-i="${i}"><b>${esc(aeIndex[i][0])}</b><small>${esc(aeIndex[i][2])}</small></button>`).join('')
        : `<div class="ae-msg">${esc(tr('eq.noResults'))}</div>`);
    }, 120);
  });

  aeResults.addEventListener('click', async (e) => {
    const btn = e.target.closest('.ae-item');
    if (!btn) return;
    const [name, path, src] = aeIndex[+btn.dataset.i];
    const file = path.split('/').pop() + '%20ParametricEQ.txt';
    setHTML(aeResults, `<div class="ae-msg">${esc(tr('eq.loading'))}</div>`);
    try {
      const res = await fetch(AUTOEQ_BASE + path + '/' + file);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const parsed = AE.parseAutoEq(await res.text());
      if (!parsed.filters.length) throw new Error('no filters');
      audio.autoeq = { id: path, name, src, preamp: parsed.preamp, filters: parsed.filters };
      aeSearch.classList.add('hidden');
      renderAutoEq();
      eq.render();
      commit();
    } catch {
      setHTML(aeResults, `<div class="ae-msg">${esc(tr('eq.loadError'))}</div>`);
    }
  });

  $('#ae-clear').addEventListener('click', () => {
    audio.autoeq = AE.clone(AE.DEFAULT_AUDIO.autoeq);
    aeSearch.classList.add('hidden');
    renderAutoEq();
    eq.render();
    commit();
  });

  /* =========================================================
     MIXER
     ========================================================= */
  const mixLinks = new Map();   // tabId -> { link, lv, t, pollT }
  let mixTabs = [];
  let soloMuted = [];           // tabs muted by "solo"

  function letterBadge(name, cls = '') {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `<div class="fav ${cls}" style="--c1:hsl(${h} 70% 55%);--c2:hsl(${h} 70% 38%)">${esc((name[0] || '?').toUpperCase())}</div>`;
  }
  function favicon(t, h) {
    const url = t.favIconUrl || '';
    if (/^(https?:|data:image)/.test(url)) return `<div class="fav img"><img src="${esc(url)}" alt=""></div>`;
    return letterBadge(h);
  }

  async function refreshMixer() {
    const all = await API.listTabs();
    const current = tab && tab.id;
    mixTabs = all
      .filter((t) => AE.hostOf(t.url) && (t.audible || t.id === current || data.app.showSilent))
      .sort((a, b) => (b.id === current) - (a.id === current) || (b.audible - a.audible) || String(a.title).localeCompare(b.title));
    const playing = all.filter((t) => t.audible).length;
    $('#mixer-count').textContent = tr('mixer.count', { n: playing });

    const list = $('#mix-list');
    if (!mixTabs.length) {
      setHTML(list, `<div class="empty">${esc(tr('mixer.empty'))}</div>`);
    } else {
      setHTML(list, mixTabs.map((t) => {
        const h = AE.hostOf(t.url);
        const s = t.id === current ? audio : AE.effective(data, h);
        const muted = t.mutedInfo && t.mutedInfo.muted;
        const meta = [h, s.enabled ? s.gain + '%' : tr('app.processingOff'), muted ? tr('mixer.muted') : ''].filter(Boolean).join(' · ');
        return `<div class="mix-item${t.id === current ? ' current' : ''}${muted ? ' muted' : ''}" data-id="${t.id}" data-host="${esc(h)}">
          ${favicon(t, h)}
          <div class="mix-body">
            <div class="mix-title"><span>${esc(t.title || h)}</span>${t.id === current ? `<em class="tag">${esc(tr('mixer.thisTab'))}</em>` : ''}</div>
            <div class="mix-meta">${esc(meta)}</div>
            <div class="mix-controls"><input type="range" min="0" max="${AE.gainCap(data.app)}" step="5" value="${s.gain}"><output>${s.gain}%</output></div>
            <div class="mini-meter"><i></i></div>
            ${OUT_MODE ? `<select class="mix-dev" aria-label="${esc(tr('dev.title'))}" title="${esc(outHint(h, t.id === current) || tr('dev.title'))}">${optionsHTML(h)}</select>` : ''}
          </div>
          ${API.canMute ? `<div class="mix-btns">
            <button class="mb mute" title="${esc(tr(muted ? 'mixer.unmute' : 'mixer.mute'))}"><svg class="ic"><use href="#i-volume${muted ? '-x' : ''}"/></svg></button>
            <button class="mb solo${soloMuted.length && !muted && t.audible ? ' active' : ''}" title="${esc(tr('mixer.solo'))}">S</button>
          </div>` : ''}
        </div>`;
      }).join(''));
      $$('.mix-item input[type=range]', list).forEach(paintRange);
    }

    // meters for other tabs
    const want = new Set(mixTabs.filter((t) => t.id !== current && t.audible).map((t) => t.id));
    mixLinks.forEach((v, id) => { if (!want.has(id)) { v.link.close(); mixLinks.delete(id); } });
    want.forEach((id) => {
      if (mixLinks.has(id)) return;
      const entry = { link: API.connect(id), lv: 0, t: 0, pollT: 0 };
      entry.link.onMessage((m) => {
        if (m.levels) { entry.lv = Math.max(m.levels.l.peak, m.levels.r.peak); entry.t = performance.now(); }
      });
      entry.link.onClose(() => mixLinks.delete(id));
      mixLinks.set(id, entry);
    });
  }

  let mixTimer = 0;
  API.onTabsChanged(() => {
    clearTimeout(mixTimer);
    mixTimer = setTimeout(() => { if (currentPanel === 'mixer') refreshMixer(); }, 150);
  });

  $('#mix-list').addEventListener('input', (e) => {
    if (e.target.type !== 'range') return;
    const item = e.target.closest('.mix-item');
    const h = item.dataset.host, v = +e.target.value;
    paintRange(e.target);
    e.target.nextElementSibling.textContent = v + '%';
    const s = +item.dataset.id === (tab && tab.id) ? audio : AE.effective(data, h);
    s.gain = v;
    s.enabled = true;
    commitHost(h, s);
  });
  $('#mix-list').addEventListener('click', async (e) => {
    const item = e.target.closest('.mix-item');
    if (!item) return;
    const id = +item.dataset.id;
    const t = mixTabs.find((x) => x.id === id);
    if (!t) return;
    if (e.target.closest('.mb.mute')) {
      await API.setMuted(id, !(t.mutedInfo && t.mutedInfo.muted));
    } else if (e.target.closest('.mb.solo')) {
      if (soloMuted.length) {
        await Promise.all(soloMuted.map((x) => API.setMuted(x, false)));
        soloMuted = [];
      } else {
        const others = mixTabs.filter((x) => x.id !== id && x.audible && !(x.mutedInfo && x.mutedInfo.muted));
        await API.setMuted(id, false);
        await Promise.all(others.map((x) => API.setMuted(x.id, true)));
        soloMuted = others.map((x) => x.id);
      }
    } else return;
    refreshMixer();
  });
  $('#mix-list').addEventListener('change', (e) => {
    if (!e.target.classList.contains('mix-dev')) return;
    const item = e.target.closest('.mix-item');
    const t = mixTabs.find((x) => x.id === +item.dataset.id);
    if (t) chooseOutput(t, item.dataset.host, e.target.value, e.target);
  });
  $('#mute-others').addEventListener('click', async () => {
    const current = tab && tab.id;
    const all = await API.listTabs();
    await Promise.all(all.filter((t) => t.id !== current && t.audible && !(t.mutedInfo && t.mutedInfo.muted)).map((t) => API.setMuted(t.id, true)));
    refreshMixer();
  });

  function renderMixerMeters(agg, t) {
    const current = tab && tab.id;
    $$('.mix-item').forEach((item) => {
      const id = +item.dataset.id;
      let lv = 0;
      if (id === current) lv = Math.max(agg.l, agg.r);
      else {
        const e = mixLinks.get(id);
        if (e) {
          if (t - e.pollT > (MOBILE ? 250 : 120)) { e.pollT = t; e.link.post({ type: 'poll', want: ['levels'] }); }
          if (t - e.t < 500) lv = e.lv;
        }
      }
      const bar = item.querySelector('.mini-meter i');
      const pos = dbPos(lv > 0 ? 20 * Math.log10(lv) : -Infinity);
      const prev = +(bar.dataset.v || 0);
      const next = pos > prev ? pos : Math.max(pos, prev - 2.5);
      bar.dataset.v = next;
      bar.style.width = next.toFixed(1) + '%';
    });
  }

  /* =========================================================
     SETTINGS
     ========================================================= */
  function renderProfiles() {
    const hosts = Object.keys(data.sites).sort();
    $('#profiles-count').textContent = hosts.length;
    const box = $('#profiles');
    if (!hosts.length) { setHTML(box, `<div class="empty">${esc(tr('set.noProfiles'))}</div>`); return; }
    setHTML(box, hosts.map((h) => {
      const s = AE.effective({ ...data, app: { ...data.app, perSite: true } }, h);
      const tags = [];
      tags.push(s.enabled ? s.gain + '%' : tr('app.processingOff'));
      if (AE.eqActive(s)) tags.push(tr('tab.eq'));
      if (s.autoeq.id) tags.push(s.autoeq.name);
      for (const [k, key] of [['dialog', 'fx.dialog'], ['night', 'fx.night'], ['bass', 'fx.bass'], ['width', 'fx.width'], ['norm', 'fx.norm'], ['mono', 'fx.mono']]) {
        if (s.fx[k].on) tags.push(tr(key));
      }
      if (s.fx.speed.value !== 1) tags.push(fmt.speed(s.fx.speed.value));
      return `<div class="site-row" data-host="${esc(h)}">${letterBadge(h, 'sm')}<div class="grow"><b>${esc(h)}</b><div class="tags">${tags.map((x) => `<span>${esc(x)}</span>`).join('')}</div></div><button class="icon-btn sm danger" data-del><svg class="ic"><use href="#i-trash"/></svg></button></div>`;
    }).join(''));
  }
  $('#profiles').addEventListener('click', (e) => {
    if (!e.target.closest('[data-del]')) return;
    const h = e.target.closest('.site-row').dataset.host;
    const sites = { ...data.sites };
    delete sites[h];
    data.sites = sites;
    lastEdit = Date.now();
    API.persist({ sites });
    if (h === host) {
      audio = AE.effective(data, host);
      if (link) link.post({ type: 'live', settings: audio });
      renderAll();
    } else renderProfiles();
  });

  async function renderHotkeys() {
    const names = {
      _execute_action: 'set.hk.open', 'gain-up': 'set.hk.up', 'gain-down': 'set.hk.down', toggle: 'set.hk.toggle',
      'speed-up': 'set.hk.speedUp', 'speed-down': 'set.hk.speedDown', 'speed-reset': 'set.hk.speedReset',
    };
    const arrows = { Up: '↑', Down: '↓', Left: '←', Right: '→' };
    let cmds = [];
    try { cmds = await API.commands(); } catch { /* ignore */ }
    setHTML($('#hotkeys'), cmds.filter((c) => names[c.name]).map((c) => {
      const keys = c.shortcut
        ? c.shortcut.split('+').map((k) => `<kbd>${esc(arrows[k] || k)}</kbd>`).join('')
        : `<span class="sub">${esc(tr('set.hk.none'))}</span>`;
      return `<div class="key-row"><span>${esc(tr(names[c.name]))}</span><span>${keys}</span></div>`;
    }).join(''));
  }

  // export / import / reset
  function dataMsg(text) {
    const m = $('#data-msg');
    m.textContent = text;
    m.classList.remove('hidden');
    setTimeout(() => m.classList.add('hidden'), 4000);
  }
  $('#btn-export').addEventListener('click', () => {
    flush();
    const payload = { format: 'audio-extender', version: 1, app: data.app, defaults: data.defaults, sites: data.sites, presets: data.presets };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'audio-extender-settings.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
  $('#btn-import').addEventListener('click', () => {
    // a file dialog closes the popup in Firefox, so import from a full tab
    if (API.isExtension && API.context === 'popup') {
      API.openTab(API.pageUrl('?page=1#settings'));
      window.close();
      return;
    }
    $('#import-file').click();
  });
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const obj = JSON.parse(await file.text());
      if (obj.format !== 'audio-extender') throw new Error('format');
      const d = AE.normalize(obj);
      await API.save({ app: d.app, defaults: d.defaults, sites: d.sites, presets: d.presets });
      await reloadData(true);
      dataMsg(tr('set.imported'));
    } catch {
      dataMsg(tr('set.importError'));
    }
  });
  let resetArmed = 0;
  $('#btn-reset-all').addEventListener('click', async (e) => {
    const label = e.currentTarget.querySelector('span');
    if (Date.now() - resetArmed > 3000) {
      resetArmed = Date.now();
      label.textContent = tr('set.confirm');
      setTimeout(() => { label.textContent = tr('set.resetAll'); }, 3000);
      return;
    }
    resetArmed = 0;
    label.textContent = tr('set.resetAll');
    await API.clearAll();
    await API.save({ app: AE.clone(AE.DEFAULT_APP) });
    await reloadData(true);
  });

  $('#version').textContent = API.version();
  // the add-on's page in this browser's store (hidden until the listing exists)
  if (PLATFORM.storeUrl) $('#rate-link').href = PLATFORM.storeUrl;
  else $('#rate-link').classList.add('hidden');

  /* ---------------------------------------------------------
     Render everything / reload from storage
     --------------------------------------------------------- */
  function renderAll() {
    buildGainScale();
    renderAppControls();
    renderBindings();
    renderAutoEq();
    eq.refresh();
    renderNotice();
    renderOutput();
    if (currentPanel === 'settings') { renderProfiles(); renderHotkeys(); }
    if (currentPanel === 'mixer') refreshMixer();
  }

  async function reloadData(force) {
    data = await API.load();
    if (!force && Date.now() - lastEdit < 1000) return; // our own write echoing back
    audio = AE.effective(data, host);
    applyTheme(data.app.theme);
    applyLang(data.app.lang);
  }
  API.onChanged((changes) => {
    if (AE.KEYS.some((k) => k in changes)) reloadData(false);
  });

  async function switchTab(t) {
    tab = t;
    host = t ? AE.hostOf(t.url) : null;
    kind = API.context === 'tab' ? 'internal' : t ? API.pageKind(t.url) : 'internal';
    audio = AE.effective(data, host);
    pageState = 'connecting';
    injected = false;
    if (kind === 'web') {
      try { if (!(await API.hasAccess(t.url))) pageState = 'noAccess'; } catch { /* assume access */ }
    }
    renderAll();
    connect();
  }
  API.onActiveTabChanged((t) => { if (API.context === 'sidebar') switchTab(t); });

  /* ---------------------------------------------------------
     Animation loop: polling, meters, spectrum
     --------------------------------------------------------- */
  let lastPoll = 0, lastNotice = 0;
  function frame(t) {
    const eqVisible = currentPanel === 'eq';
    const fast = currentPanel === 'booster' || eqVisible || currentPanel === 'mixer';
    // phones: ~10 polls per second instead of ~22 to save battery
    if (link && t - lastPoll > (fast ? (MOBILE ? 100 : 45) : 400)) {
      lastPoll = t;
      link.post({ type: 'poll', want: eqVisible && data.app.animations ? ['levels', 'spectrum'] : ['levels'] });
    }
    const agg = aggregate();
    if (agg.sources !== status.sources || agg.blocked !== status.blocked || agg.playing !== status.playing || agg.drm !== status.drm || agg.deep !== status.deep || agg.out !== status.out) {
      const outChanged = agg.out !== status.out || agg.deep !== status.deep;
      status = { sources: agg.sources, blocked: agg.blocked, playing: agg.playing, drm: agg.drm, foreign: agg.foreign, deep: agg.deep, out: agg.out };
      renderSiteChip();
      renderUnheard();
      if (outChanged) renderOutput();
    }
    if (t - lastNotice > 500) { lastNotice = t; renderNotice(); }
    if (currentPanel === 'booster') renderMeters(agg, t);
    if (eqVisible) eq.drawSpectrum(agg.spectrum);
    if (currentPanel === 'mixer') renderMixerMeters(agg, t);
    requestAnimationFrame(frame);
  }

  /* ---------------------------------------------------------
     Init
     --------------------------------------------------------- */
  // preview helpers: popup.html#eq&theme=cyber&lang=de
  const [hashTab, ...hashParams] = location.hash.slice(1).split('&');
  const params = new URLSearchParams(location.search + '&' + hashParams.join('&'));
  if (params.get('theme')) data.app.theme = params.get('theme');
  if (params.get('lang')) data.app.lang = params.get('lang');

  root.dataset.theme = data.app.theme;
  readPalette();
  applyTheme(data.app.theme);
  I18N.apply(data.app.lang);
  $$('.lang', langWrap).forEach((b) => b.classList.toggle('active', b.dataset.lang === I18N.lang));
  showTab(tabs.some((t) => t.dataset.tab === hashTab) ? hashTab : ui.get('tab', 'booster'));
  await loadOutputs();
  await switchTab(await API.activeTab());
  addEventListener('resize', () => eq.render());
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('preload')));
  requestAnimationFrame(frame);
})();
