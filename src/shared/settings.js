/* =========================================================
   Audio Extender — settings model shared by background,
   content scripts and the popup.
   ========================================================= */

// Chrome / Edge expose the same promise-based API as `chrome` only.
// Loaded first in every extension context, so the rest of the code can use `browser`.
if (typeof globalThis.browser === 'undefined' && typeof globalThis.chrome !== 'undefined' && globalThis.chrome.runtime && globalThis.chrome.runtime.id) {
  globalThis.browser = globalThis.chrome;
}

(function (global) {
  'use strict';

  const G10 = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const G31 = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];
  const MAX_GAIN = 600;
  const GAIN_CAPS = [150, 200, 300, 400, 600]; // app.maxGain: the user's own ceiling (speakers, hearing)
  const SPEED_MIN = 0.1, SPEED_MAX = 16;  // Firefox plays sound only between 0.125× and 8× (PLATFORM.audibleSpeed)
  const SPEED_STEPS = [0.05, 0.1, 0.25];  // S / D
  const SEEK_STEPS = [5, 10, 15, 30];     // Z / X, seconds

  const DEFAULT_BANDS = [
    { type: 'peaking', f: 60, g: 0, q: 1 },
    { type: 'peaking', f: 250, g: 0, q: 1 },
    { type: 'peaking', f: 1000, g: 0, q: 1 },
    { type: 'peaking', f: 4000, g: 0, q: 1 },
    { type: 'peaking', f: 12000, g: 0, q: 1 },
  ];

  /** Audio settings of one site (or the global defaults). */
  const DEFAULT_AUDIO = {
    enabled: true,
    gain: 100,
    limiter: { on: true, threshold: -1 },
    eq: {
      on: true,
      mode: 'param',          // param | g10 | g31
      preamp: 0,
      preset: 'flat',
      bands: DEFAULT_BANDS,
      g10: G10.map(() => 0),
      g31: G31.map(() => 0),
    },
    autoeq: { id: null, name: null, preamp: 0, filters: [] },
    fx: {
      dialog: { on: false, amount: 60 },
      night: { on: false, amount: 50 },
      bass: { on: false, gain: 6 },
      width: { on: false, value: 130 },
      norm: { on: false, target: -14 },
      mono: { on: false },
      balance: { value: 0 },
      speed: { value: 1, pitch: true },
    },
  };

  /** Extension-wide preferences. */
  // Speed keys on pages (content/speed.js): KeyboardEvent.code per action ('' = off), so any layout works
  // hold, loop, frameBack / frameForward: no key by default (users pick one, so no site loses a key)
  const SPEED_KEYS = {
    slower: 'KeyS', faster: 'KeyD', reset: 'KeyR', toggle: 'KeyG', back: 'KeyZ', forward: 'KeyX',
    hold: '', loop: '', frameBack: '', frameForward: '',
  };
  // keys that can be assigned: letters, digits, punctuation, F1–F12 — never Tab / Enter / Esc / Space / arrows
  const KEY_CODE_OK = /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|F([1-9]|1[0-2])|Comma|Period|Slash|Semicolon|Quote|Backquote|BracketLeft|BracketRight|Backslash|Minus|Equal)$/;

  const DEFAULT_APP = {
    theme: 'neon',
    lang: 'en',
    perSite: true,
    autoEnable: true,
    badge: true,
    animations: true,
    sidebar: false,
    duck: false,
    showSilent: false,
    speedKeys: true,        // S / D / R / G / Z / X on pages (content/speed.js)
    speedKeysOff: {},       // sites where those keys stay the site's own: { host: true }
    speedBadge: true,       // show "1.5×" briefly when the speed changes
    speedStep: 0.1,         // S / D step (one of SPEED_STEPS)
    seekSeconds: 10,        // Z / X jump (one of SEEK_STEPS)
    seekScaled: false,      // the jump grows with the speed (2× → twice as far)
    speedWheel: false,      // Shift + mouse wheel over a video changes the speed
    speedKeyMap: { ...SPEED_KEYS }, // action → key code ('' = off)
    maxGain: MAX_GAIN,      // highest gain anywhere (one of GAIN_CAPS)
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  /** Deep merge: values from `over` win, arrays are replaced as a whole. */
  function merge(base, over) {
    const out = clone(base);
    if (!isObj(over)) return out;
    for (const k of Object.keys(over)) {
      if (isObj(out[k]) && isObj(over[k])) out[k] = merge(out[k], over[k]);
      else if (over[k] !== undefined) out[k] = clone(over[k]);
    }
    return out;
  }

  /** Site key: hostname without a leading "www.". Null for pages we cannot process. */
  function hostOf(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') return null;
      if (u.protocol === 'file:') return 'file://';
      return u.hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  function normalize(data) {
    data = data || {};
    return {
      app: merge(DEFAULT_APP, data.app),
      defaults: merge(DEFAULT_AUDIO, data.defaults),
      sites: isObj(data.sites) ? data.sites : {},
      presets: Array.isArray(data.presets) ? data.presets : [],
      outputs: isObj(data.outputs) ? data.outputs : {},
    };
  }

  /** Output device chosen for `host`: { id, label } or null (the default device).
   *  Kept apart from the audio settings: device ids belong to this browser profile
   *  (per origin), so they are not part of presets, profiles or exported files. */
  function outputFor(data, host) {
    const o = host && data && isObj(data.outputs) ? data.outputs[host] : null;
    return o && typeof o.id === 'string' && o.id ? { id: o.id, label: String(o.label || '') } : null;
  }

  /** Speed keys in use: { code: action }. Unusable codes and a second use of the same key are dropped. */
  function speedKeyMap(app) {
    const m = { ...SPEED_KEYS, ...(app && isObj(app.speedKeyMap) ? app.speedKeyMap : {}) };
    const out = {};
    for (const a of Object.keys(SPEED_KEYS)) {
      const c = m[a];
      if (typeof c === 'string' && KEY_CODE_OK.test(c) && !out[c]) out[c] = a;
    }
    return out;
  }
  const speedKeyOk = (code) => KEY_CODE_OK.test(code);

  /** The highest gain the user allows (Settings → Maximum volume). */
  const gainCap = (app) => (app && GAIN_CAPS.includes(app.maxGain) ? app.maxGain : MAX_GAIN);

  /** Settings that apply to `host`, taking per-site and auto-enable prefs into account.
   *  The gain is capped here, so no stored or imported value can play louder than the maximum. */
  function effective(data, host) {
    const d = normalize(data);
    const site = d.app.perSite && host ? d.sites[host] : null;
    const s = merge(d.defaults, site);
    if (d.app.perSite && !site && !d.app.autoEnable) s.enabled = false;
    s.gain = Math.min(s.gain, gainCap(d.app));
    return s;
  }

  /** Where edits for `host` are stored: its own profile or the global defaults. */
  function storeFor(data, host, audio) {
    const d = normalize(data);
    if (d.app.perSite && host) return { sites: { ...d.sites, [host]: clone(audio) } };
    return { defaults: clone(audio) };
  }

  function eqActive(s) {
    if (!s.eq.on) return false;
    if (s.eq.preamp !== 0) return true;
    if (s.eq.mode === 'param') return s.eq.bands.some((b) => b.g !== 0 || !['peaking', 'lowshelf', 'highshelf'].includes(b.type));
    return (s.eq[s.eq.mode] || []).some((g) => g !== 0);
  }

  function matrixActive(s) {
    return s.fx.mono.on || (s.fx.width.on && s.fx.width.value !== 100) || s.fx.balance.value !== 0;
  }

  /** True when the audio graph must actually change the sound. At neutral settings the page's audio
   *  is left untouched: routing it anyway is where audio extensions break sites and cost CPU. */
  function needsProcessing(s) {
    if (!s.enabled) return false;
    return s.gain !== 100 || eqActive(s) || !!s.autoeq.id ||
      s.fx.dialog.on || s.fx.night.on || s.fx.bass.on || s.fx.norm.on || matrixActive(s);
  }

  /** Parse an AutoEq "ParametricEQ.txt" file. */
  function parseAutoEq(text) {
    const res = { preamp: 0, filters: [] };
    const types = { PK: 'peaking', LSC: 'lowshelf', HSC: 'highshelf', LS: 'lowshelf', HS: 'highshelf', LP: 'lowpass', HP: 'highpass', NO: 'notch' };
    for (const line of String(text).split(/\r?\n/)) {
      const pre = /^Preamp:\s*(-?[\d.]+)\s*dB/i.exec(line);
      if (pre) { res.preamp = +pre[1]; continue; }
      const m = /^Filter\s*\d+:\s*ON\s+(\w+)\s+Fc\s+([\d.]+)\s*Hz(?:\s+Gain\s+(-?[\d.]+)\s*dB)?(?:\s+Q\s+([\d.]+))?/i.exec(line);
      if (m && types[m[1].toUpperCase()]) {
        res.filters.push({ type: types[m[1].toUpperCase()], f: +m[2], g: m[3] ? +m[3] : 0, q: m[4] ? +m[4] : 0.71 });
      }
    }
    return res;
  }

  /** Storage keys that hold settings (the AutoEq index cache is stored separately). */
  const KEYS = ['app', 'defaults', 'sites', 'presets', 'outputs'];

  /* ---------------------------------------------------------
     Versioning
     SCHEMA   — format of the stored settings. When it changes, bump it and
                add a step to MIGRATIONS that converts data from SCHEMA-1.
     PROTOCOL — message format between content.js and page.js. Bump it when
                that format changes: tabs running an older engine are then
                asked to reload instead of misbehaving.
     New fields with defaults need no migration: normalize()/merge() fill them in.
     --------------------------------------------------------- */
  const SCHEMA = 1;
  const PROTOCOL = 2; // 2: output device messages
  const MIGRATIONS = {
    // 2: (d) => { /* convert schema 1 → 2 */ return d; },
  };

  /** Bring stored data up to SCHEMA. Returns the data and whether it has to be written back. */
  function migrate(raw) {
    const from = (raw.meta && raw.meta.schema) || 1;
    let d = { ...raw };
    for (let v = from + 1; v <= SCHEMA; v++) if (MIGRATIONS[v]) d = MIGRATIONS[v](d);
    return { data: d, from, changed: from < SCHEMA };
  }

  global.AE = {
    KEYS, SCHEMA, PROTOCOL, migrate,
    G10, G31, MAX_GAIN, GAIN_CAPS, gainCap, SPEED_MIN, SPEED_MAX, SPEED_STEPS, SEEK_STEPS, SPEED_KEYS, speedKeyMap, speedKeyOk, DEFAULT_AUDIO, DEFAULT_APP, DEFAULT_BANDS,
    clone, merge, hostOf, normalize, effective, storeFor, outputFor,
    eqActive, matrixActive, needsProcessing, parseAutoEq,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
