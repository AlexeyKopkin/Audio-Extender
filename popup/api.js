/* =========================================================
   Audio Extender — popup data layer
   Real implementation uses the WebExtension APIs. When the popup
   is opened as a plain file (design preview), a mock with fake
   tabs, levels and spectrum is used instead.
   ========================================================= */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const context = params.has('sidebar') ? 'sidebar' : params.has('page') ? 'tab' : 'popup';
  const isExtension = typeof browser !== 'undefined' && !!(browser.runtime && browser.runtime.id);
  const mobilePreview = !isExtension && /[#&?]mobile\b/.test(location.href); // design preview of the phone layout

  // Firefox does not run extensions on these sites (extensions.webextensions.restrictedDomains)
  const RESTRICTED = new Set([
    'accounts-static.cdn.mozilla.net', 'accounts.firefox.com', 'addons.cdn.mozilla.net', 'addons.mozilla.org',
    'api.accounts.firefox.com', 'content.cdn.mozilla.net', 'discovery.addons.mozilla.org', 'install.mozilla.org',
    'oauth.accounts.firefox.com', 'profile.accounts.firefox.com', 'support.mozilla.org', 'sync.services.mozilla.com',
  ]);

  function originPattern(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'file:' ? 'file:///*' : `${u.protocol}//${u.hostname}/*`;
    } catch {
      return '<all_urls>';
    }
  }

  function pageKind(url) {
    if (!AE.hostOf(url)) return 'internal';
    try { if (RESTRICTED.has(new URL(url).hostname)) return 'internal'; } catch { /* ignore */ }
    return 'web';
  }

  /* ---------------------------------------------------------
     Real extension
     --------------------------------------------------------- */
  const real = {
    isExtension: true,
    context,
    pageKind,
    get hasSidebar() { return !!(browser.sidebarAction && browser.sidebarAction.toggle); },
    get hasShortcuts() { return !!(browser.commands && browser.commands.getAll); },
    // Firefox for Android can't mute tabs (no `muted` in tabs.update); it also has no windows API.
    get canMute() { return !!browser.windows; },

    async load() { return AE.normalize(await browser.storage.local.get(AE.KEYS)); },
    persist(patch) { return browser.runtime.sendMessage({ type: 'persist', patch }).catch(() => browser.storage.local.set(patch)); },
    save(obj) { return browser.storage.local.set(obj); },
    async getRaw(key) { return (await browser.storage.local.get(key))[key]; },
    clearAll() { return browser.storage.local.clear(); },
    onChanged(cb) {
      browser.storage.onChanged.addListener((changes, area) => { if (area === 'local') cb(changes); });
    },

    async activeTab() {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    },
    onActiveTabChanged(cb) {
      browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
        const win = browser.windows && await browser.windows.getCurrent(); // no windows on Android
        if (!win || windowId === win.id) cb(await browser.tabs.get(tabId));
      });
      browser.tabs.onUpdated.addListener((tabId, info, tab) => {
        if (tab.active && info.url) cb(tab);
      });
    },

    // Firefox lets users limit an extension to some sites, so check the tab's own origin.
    hasAccess(url) { return browser.permissions.contains({ origins: [originPattern(url)] }); },
    requestAccess(url) { return browser.permissions.request({ origins: [originPattern(url)] }); },
    inject(tabId) { return browser.runtime.sendMessage({ type: 'inject', tabId }); },

    connect(tabId) {
      let port;
      const handlers = [], closers = [];
      try {
        port = browser.tabs.connect(tabId, { name: 'ae-tab' });
      } catch {
        setTimeout(() => closers.forEach((f) => f()), 0);
        return { post() {}, onMessage() {}, onClose(f) { closers.push(f); }, close() {} };
      }
      port.onMessage.addListener((m) => handlers.forEach((f) => f(m)));
      port.onDisconnect.addListener(() => closers.forEach((f) => f()));
      return {
        post(msg) { try { port.postMessage(msg); } catch { /* closed */ } },
        onMessage(f) { handlers.push(f); },
        onClose(f) { closers.push(f); },
        close() { try { port.disconnect(); } catch { /* ignore */ } },
      };
    },

    listTabs() { return browser.tabs.query({}); },
    onTabsChanged(cb) {
      browser.tabs.onUpdated.addListener((id, info) => {
        if ('audible' in info || 'mutedInfo' in info || 'title' in info || 'favIconUrl' in info || info.url) cb();
      });
      browser.tabs.onRemoved.addListener(() => cb());
      browser.tabs.onActivated.addListener(() => cb());
    },
    setMuted(tabId, muted) { return browser.tabs.update(tabId, { muted }); },
    reloadTab(tabId) { return browser.tabs.reload(tabId); },
    commands() { return browser.commands.getAll(); },
    openTab(url) { return browser.tabs.create({ url }); },
    pageUrl(query) { return browser.runtime.getURL('popup/popup.html' + query); },
    version() { return browser.runtime.getManifest().version; },
  };

  /* ---------------------------------------------------------
     Mock for the design preview (popup.html opened as a file)
     --------------------------------------------------------- */
  const MOCK_TABS = [
    { id: 1, active: true, audible: true, title: 'Lo-fi beats to relax and study', url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk', mutedInfo: { muted: false } },
    { id: 2, audible: true, title: 'Just Chatting — live stream', url: 'https://www.twitch.tv/somechannel', mutedInfo: { muted: false } },
    { id: 3, audible: true, title: 'Synthwave Mix — Neon Nights', url: 'https://bandcamp.com/', mutedInfo: { muted: false } },
    { id: 4, audible: false, title: 'Deep House Mix 2026', url: 'https://soundcloud.com/mix', mutedInfo: { muted: true } },
    { id: 5, audible: false, title: 'Inbox', url: 'https://mail.example.com/', mutedInfo: { muted: false } },
  ];
  const mockKey = 'ae:mock-storage';
  const mockListeners = [];
  const mockTabListeners = [];
  const mockRead = () => { try { return JSON.parse(localStorage.getItem(mockKey)) || {}; } catch { return {}; } };

  const mock = {
    isExtension: false,
    context,
    pageKind,
    mobilePreview,
    hasSidebar: !mobilePreview,
    hasShortcuts: !mobilePreview,
    canMute: !mobilePreview,

    async load() {
      const d = mockRead();
      if (!d.app) {
        d.app = { ...AE.DEFAULT_APP };
        d.sites = {
          'youtube.com': AE.merge(AE.DEFAULT_AUDIO, {
            gain: 250,
            eq: {
              preset: 'custom',
              bands: [
                { type: 'highpass', f: 28, g: 0, q: 0.71 },
                { type: 'lowshelf', f: 95, g: 4.5, q: 0.7 },
                { type: 'peaking', f: 320, g: -2.5, q: 1.2 },
                { type: 'peaking', f: 2400, g: 3, q: 1.4 },
                { type: 'peaking', f: 6500, g: -3.5, q: 3 },
                { type: 'highshelf', f: 11000, g: 2.5, q: 0.7 },
              ],
            },
            fx: { dialog: { on: true }, bass: { on: true }, width: { on: true } },
          }),
        };
      }
      return AE.normalize(d);
    },
    async save(obj) {
      const d = { ...mockRead(), ...obj };
      try { localStorage.setItem(mockKey, JSON.stringify(d)); } catch { /* ignore */ }
      const changes = {};
      Object.keys(obj).forEach((k) => { changes[k] = { newValue: obj[k] }; });
      mockListeners.forEach((f) => f(changes));
    },
    persist(patch) { return this.save(patch); },
    async getRaw(key) { return mockRead()[key]; },
    async clearAll() { try { localStorage.removeItem(mockKey); } catch { /* ignore */ } mockListeners.forEach((f) => f({ app: {} })); },
    onChanged(cb) { mockListeners.push(cb); },

    async activeTab() { return MOCK_TABS[0]; },
    onActiveTabChanged() {},
    async hasAccess() { return true; },
    async requestAccess() { return true; },
    async inject() { return { ok: true }; },

    connect(tabId) {
      const handlers = [];
      let settings = null, timer = 0;
      const spec = new Array(72).fill(0.2);
      const lv = { l: 0, r: 0 };
      const link = {
        post(msg) {
          if (msg.type === 'live') settings = msg.settings;
          if (msg.type !== 'poll') return;
          const t = performance.now();
          const tab = MOCK_TABS.find((x) => x.id === tabId);
          const playing = tab && tab.audible && !tab.mutedInfo.muted;
          const on = !settings || settings.enabled;
          const g = playing ? Math.min(1.25, 0.32 * (on && settings ? settings.gain / 100 : 1)) : 0;
          const beat = Math.max(0, Math.sin(t / 260)) ** 4;
          for (const c of ['l', 'r']) {
            const target = g * (0.75 + 0.25 * beat + (Math.random() - 0.5) * 0.15);
            lv[c] += (target - lv[c]) * 0.4;
          }
          const lim = settings && settings.limiter.on;
          const reply = {
            type: 'reply', frame: 'mock', top: true, v: AE.PROTOCOL, sources: playing ? 2 : 0, blocked: 0, active: true,
            levels: {
              l: { peak: lim ? Math.min(lv.l, 0.97) : lv.l, rms: lv.l * 0.5 },
              r: { peak: lim ? Math.min(lv.r, 0.97) : lv.r, rms: lv.r * 0.5 },
              gr: lim ? Math.min(0, -Math.max(0, (Math.max(lv.l, lv.r) - 0.89) * 30)) : 0,
            },
          };
          if ((msg.want || []).includes('spectrum')) {
            for (let i = 0; i < 72; i++) {
              const k = i / 72;
              const base = playing ? 0.72 - k * 0.42 + 0.12 * Math.sin(t / 900 + i * 0.35) + 0.08 * Math.sin(t / 370 + i * 1.3) + (i < 10 ? 0.25 * beat : 0) : 0;
              const target = Math.max(0, Math.min(1, base + (Math.random() - 0.5) * 0.1));
              spec[i] += (target - spec[i]) * (target > spec[i] ? 0.5 : 0.12);
            }
            reply.spectrum = spec.slice();
          }
          clearTimeout(timer);
          timer = setTimeout(() => handlers.forEach((f) => f(reply)), 5);
        },
        onMessage(f) { handlers.push(f); },
        onClose() {},
        close() {},
      };
      return link;
    },

    async listTabs() { return MOCK_TABS.map((t) => ({ ...t })); },
    onTabsChanged(cb) { mockTabListeners.push(cb); },
    async setMuted(tabId, muted) {
      const t = MOCK_TABS.find((x) => x.id === tabId);
      if (t) t.mutedInfo.muted = muted;
      mockTabListeners.forEach((f) => f());
    },
    async reloadTab() {},
    async commands() {
      return [
        { name: '_execute_action', shortcut: 'Alt+Shift+A' },
        { name: 'gain-up', shortcut: 'Alt+Shift+Up' },
        { name: 'gain-down', shortcut: 'Alt+Shift+Down' },
        { name: 'toggle', shortcut: 'Alt+Shift+B' },
      ];
    },
    async openTab(url) { window.open(url, '_blank', 'noopener'); },
    pageUrl(query) { return 'popup.html' + query; },
    version() { return '0.1.0'; },
  };

  window.API = isExtension ? real : mock;
})();
