/* =========================================================
   Audio Extender — design preview (not in the store packages)

   Only in the preview build (`npm run build:preview` → dist/preview):
   open dist/preview/popup/popup.html in a browser and the popup runs
   on demo tabs, levels and spectrum; settings are kept in localStorage.
   Tab, theme, language and phone layout can be set in the URL:
     popup.html#eq&theme=cyber&lang=de&mobile
   ========================================================= */
(() => {
  'use strict';
  if (window.API) return; // inside the extension: keep the real API

  const { context, pageKind } = window.API_CORE;
  const mobilePreview = /[#&?]mobile\b/.test(location.href); // phone layout

  /* ---------------------------------------------------------
     Demo data for the design preview
     --------------------------------------------------------- */
  const DEMO_TABS = [
    { id: 1, active: true, audible: true, title: 'Lo-fi beats to relax and study', url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk', mutedInfo: { muted: false } },
    { id: 2, audible: true, title: 'Just Chatting — live stream', url: 'https://www.twitch.tv/somechannel', mutedInfo: { muted: false } },
    { id: 3, audible: true, title: 'Synthwave Mix — Neon Nights', url: 'https://bandcamp.com/', mutedInfo: { muted: false } },
    { id: 4, audible: false, title: 'Deep House Mix 2026', url: 'https://soundcloud.com/mix', mutedInfo: { muted: true } },
    { id: 5, audible: false, title: 'Inbox', url: 'https://mail.example.com/', mutedInfo: { muted: false } },
  ];
  const demoKey = 'ae:mock-storage'; // unchanged, so existing previews keep their state
  const demoListeners = [];
  const demoTabListeners = [];
  const demoRead = () => { try { return JSON.parse(localStorage.getItem(demoKey)) || {}; } catch { return {}; } };

  const preview = {
    isExtension: false,
    context,
    pageKind,
    mobilePreview,
    hasSidebar: !mobilePreview,
    hasShortcuts: !mobilePreview,
    canMute: !mobilePreview,
    canCapture: false,
    // output devices: demo list (a phone has no device choice, like Firefox for Android)
    outputMode: mobilePreview ? null : 'deep',
    async listOutputs() {
      return { granted: true, devices: [
        { id: 'demo-speakers', label: 'Speakers (Realtek High Definition Audio)' },
        { id: 'demo-headphones', label: 'WH-1000XM5 (Bluetooth)' },
        { id: 'demo-hdmi', label: 'LG TV (NVIDIA High Definition Audio)' },
      ] };
    },
    async grantOutputs() {},
    async askOutput() {},
    async captureIsOn() { return false; },

    async load() {
      const d = demoRead();
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
      const d = { ...demoRead(), ...obj };
      try { localStorage.setItem(demoKey, JSON.stringify(d)); } catch { /* ignore */ }
      const changes = {};
      Object.keys(obj).forEach((k) => { changes[k] = { newValue: obj[k] }; });
      demoListeners.forEach((f) => f(changes));
    },
    persist(patch) { return this.save(patch); },
    async getRaw(key) { return demoRead()[key]; },
    async clearAll() { try { localStorage.removeItem(demoKey); } catch { /* ignore */ } demoListeners.forEach((f) => f({ app: {} })); },
    onChanged(cb) { demoListeners.push(cb); },

    async activeTab() { return DEMO_TABS[0]; },
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
          const tab = DEMO_TABS.find((x) => x.id === tabId);
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
            type: 'reply', frame: 'preview', top: true, v: AE.PROTOCOL, sources: playing ? 2 : 0, blocked: 0, active: true,
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

    async listTabs() { return DEMO_TABS.map((t) => ({ ...t })); },
    onTabsChanged(cb) { demoTabListeners.push(cb); },
    async setMuted(tabId, muted) {
      const t = DEMO_TABS.find((x) => x.id === tabId);
      if (t) t.mutedInfo.muted = muted;
      demoTabListeners.forEach((f) => f());
    },
    async reloadTab() {},
    async activateTab() {},
    async commands() {
      return [
        { name: '_execute_action', shortcut: 'Alt+Shift+A' },
        { name: 'gain-up', shortcut: 'Alt+Shift+Up' },
        { name: 'gain-down', shortcut: 'Alt+Shift+Down' },
        { name: 'toggle', shortcut: 'Alt+Shift+B' },
        { name: 'speed-up', shortcut: '' },
        { name: 'speed-down', shortcut: '' },
        { name: 'speed-reset', shortcut: '' },
      ];
    },
    async openTab(url) { window.open(url, '_blank', 'noopener'); },
    pageUrl(query) { return 'popup.html' + query; },
    version() { return 'preview'; },
  };

  window.API = preview;
})();
