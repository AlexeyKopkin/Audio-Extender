/* =========================================================
   Audio Extender — popup data layer
   Uses the WebExtension APIs. Browser differences come from
   PLATFORM (platform/<browser>/platform.js). The design preview
   (preview build) swaps this for demo data in popup/preview.js.
   ========================================================= */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const context = params.has('sidebar') ? 'sidebar' : params.has('page') ? 'tab' : 'popup';
  const isExtension = typeof browser !== 'undefined' && !!(browser.runtime && browser.runtime.id);

  // sites where this browser doesn't run extensions (platform layer)
  const RESTRICTED = new Set(PLATFORM.restrictedHosts);

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
    get hasSidebar() { return PLATFORM.sidebar.available; },
    get hasShortcuts() { return !!(browser.commands && browser.commands.getAll); },
    // Firefox for Android can't mute tabs (no `muted` in tabs.update); it also has no windows API.
    get canMute() { return !!browser.windows; },
    // deep mode: the platform can process the tab's whole output (Chrome / Edge tab capture)
    get canCapture() { return !!(PLATFORM.capture && PLATFORM.capture.available); },
    captureStart(tabId) { return PLATFORM.capture.start(tabId); },
    captureStop(tabId) { return PLATFORM.capture.stop(tabId); },
    captureIsOn(tabId) { return PLATFORM.capture.isOn(tabId); },

    /* Output device per tab. Device ids are per origin, so how a tab gets its device differs:
         'deep' — Chrome / Edge: the extension lists devices (needs microphone access once) and the
                  tab plays through deep mode, whose AudioContext.setSinkId takes those ids;
         'page' — Firefox: the page itself selects the device (selectAudioOutput, see content.js);
         null   — not available (Firefox for Android). */
    get outputMode() {
      if (this.canCapture && typeof AudioContext !== 'undefined' && typeof AudioContext.prototype.setSinkId === 'function') return 'deep';
      const md = navigator.mediaDevices;
      if (md && typeof md.selectAudioOutput === 'function' && typeof HTMLMediaElement.prototype.setSinkId === 'function') return 'page';
      return null;
    },
    /** 'deep': output devices visible to the extension; `granted` false = names hidden until microphone access. */
    async listOutputs() {
      let list = [];
      try { list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput'); } catch { /* none */ }
      const granted = list.some((d) => d.deviceId);
      return { granted, devices: list.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => ({ id: d.deviceId, label: d.label })) };
    },
    /** 'deep': ask for microphone access once, only so the device names become visible. Nothing is recorded. */
    async grantOutputs() {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    },
    /** 'page': show the in-page chip that opens the browser's device picker (top frame). */
    askOutput(tabId, text) { return browser.tabs.sendMessage(tabId, { type: 'output-ask', text }, { frameId: 0 }); },

    async load() { return AE.normalize(await browser.storage.local.get(AE.KEYS)); },
    persist(patch) { return browser.runtime.sendMessage({ type: 'persist', patch }).catch(() => browser.storage.local.set(patch)); },
    save(obj) { return browser.storage.local.set(obj); },
    async getRaw(key) { return (await browser.storage.local.get(key))[key]; },
    /** The tabs' own volumes (Mixer): { tabId: { host, gain } }, kept by the background in storage.session. */
    async tabGains() { return (await browser.storage.session.get('tabGain')).tabGain || {}; },
    setTabGain(tabId, gain) { return browser.runtime.sendMessage({ type: 'tab-gain', tabId, gain }); },
    onTabGainsChanged(cb) {
      browser.storage.onChanged.addListener((changes, area) => { if (area === 'session' && changes.tabGain) cb(changes.tabGain.newValue || {}); });
    },
    clearAll() { return browser.storage.local.clear(); },
    onChanged(cb) {
      browser.storage.onChanged.addListener((changes, area) => { if (area === 'local') cb(changes); });
    },

    async activeTab() {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab) return tab;
      // Firefox for Android may open the popup outside the page's window: take the focused web page.
      const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      return tabs.find((t) => /^https?:/.test(t.url || '')) || null;
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
    get canSync() { return !!(browser.storage && browser.storage.sync); },
    syncState() { return browser.runtime.sendMessage({ type: 'sync-state' }); },
    /** mode: 'this' (this device's settings go to the account) or 'synced' (the account's come here) */
    setSync(on, mode) { return browser.runtime.sendMessage({ type: 'sync-set', on, mode }); },

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

      // A tab in deep mode is processed by the platform: its replies (marked `deep`) join the page's.
      let deep = null, closed = false;
      if (this.canCapture) {
        PLATFORM.capture.isOn(tabId).then((on) => {
          if (!on || closed) return;
          try {
            deep = PLATFORM.capture.connect(tabId);
            deep.onMessage.addListener((m) => handlers.forEach((f) => f(m)));
            deep.onDisconnect.addListener(() => { deep = null; });
          } catch { deep = null; }
        }, () => {});
      }
      return {
        post(msg) {
          try { port.postMessage(msg); } catch { /* closed */ }
          if (deep) try { deep.postMessage(msg); } catch { /* closed */ }
        },
        onMessage(f) { handlers.push(f); },
        onClose(f) { closers.push(f); },
        close() {
          closed = true;
          try { port.disconnect(); } catch { /* ignore */ }
          if (deep) try { deep.disconnect(); } catch { /* ignore */ }
        },
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
    activateTab(tabId) { return browser.tabs.update(tabId, { active: true }); },
    commands() { return browser.commands.getAll(); },
    openShortcuts() { return PLATFORM.openShortcuts(); },
    openTab(url) { return browser.tabs.create({ url }); },
    pageUrl(query) { return browser.runtime.getURL('popup/popup.html' + query); },
    version() { return browser.runtime.getManifest().version; },
  };

  // Real extension. In a preview build (popup.html opened as a file) popup/preview.js replaces it with demo data.
  window.API = isExtension ? real : null;
  window.API_CORE = { context, pageKind };
})();
