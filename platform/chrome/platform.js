/* =========================================================
   Audio Extender — Chrome / Edge platform layer

   Same PLATFORM interface as platform/firefox/platform.js:
     id, name, storeUrl, restrictedHosts, sidebar, strings
   and optionally capture (deep mode — here: tabCapture, see capture.js).
   One package serves Chrome and Edge; texts name the browser it runs in.
   Loaded right after shared/settings.js in the service worker and the popup.
   ========================================================= */
(function (global) {
  'use strict';

  const POPUP = 'popup/popup.html';
  const nav = global.navigator || {};
  const isEdge = !!((nav.userAgentData && nav.userAgentData.brands || []).some((b) => /Edge/.test(b.brand)) || /\bEdg\//.test(nav.userAgent || ''));
  const B = isEdge ? 'Edge' : 'Chrome';
  const SCHEME = isEdge ? 'edge://' : 'chrome://';
  const STORE = isEdge ? 'Edge Add-ons' : 'Chrome Web Store';
  const fill = (s) => s.replace(/\{b\}/g, B).replace(/\{scheme\}/g, SCHEME).replace(/\{store\}/g, STORE);

  const TEXTS = {
    en: {
      'set.sidebar': 'Open in side panel',
      'set.hk.note': 'Change: {scheme}extensions/shortcuts',
      'set.rate': 'Rate on {store}',
      'app.unavailableDesc': '{b} doesn’t let extensions work on internal pages ({scheme}, settings, {store}, PDF viewer).',
      'app.restrictedSite': '{b} blocks extensions here',
      'app.restrictedSiteDesc': 'This page is protected by {b} (for example {store} or a site blocked by a policy). Its audio plays without processing.',
      'dev.grantDesc': 'To show device names to an extension, {b} needs microphone access once. Audio Extender never records or uses the microphone — it only lists the devices.',
    },
    ru: {
      'set.sidebar': 'Открывать в боковой панели',
      'set.hk.note': 'Изменить: {scheme}extensions/shortcuts',
      'set.rate': 'Оценить в {store}',
      'app.unavailableDesc': '{b} не разрешает расширениям работать на служебных страницах ({scheme}, настройки, {store}, просмотр PDF).',
      'app.restrictedSite': '{b} запрещает здесь расширения',
      'app.restrictedSiteDesc': 'Эта страница защищена {b} (например, {store} или сайт, закрытый политикой). Звук здесь играет без обработки.',
      'dev.grantDesc': 'Чтобы показать расширению названия устройств, {b} один раз просит доступ к микрофону. Audio Extender никогда не записывает и не использует микрофон — он только получает список устройств.',
    },
    uk: {
      'set.sidebar': 'Відкривати в бічній панелі',
      'set.hk.note': 'Змінити: {scheme}extensions/shortcuts',
      'set.rate': 'Оцінити в {store}',
      'app.unavailableDesc': '{b} не дозволяє розширенням працювати на службових сторінках ({scheme}, налаштування, {store}, перегляд PDF).',
      'app.restrictedSite': '{b} забороняє тут розширення',
      'app.restrictedSiteDesc': 'Ця сторінка захищена {b} (наприклад, {store} або сайт, закритий політикою). Звук тут грає без обробки.',
      'dev.grantDesc': 'Щоб показати розширенню назви пристроїв, {b} один раз просить доступ до мікрофона. Audio Extender ніколи не записує й не використовує мікрофон — він лише отримує список пристроїв.',
    },
    de: {
      'set.sidebar': 'Im Seitenbereich öffnen',
      'set.hk.note': 'Ändern: {scheme}extensions/shortcuts',
      'set.rate': 'Im {store} bewerten',
      'app.unavailableDesc': '{b} erlaubt Erweiterungen nicht auf internen Seiten ({scheme}, Einstellungen, {store}, PDF-Betrachter).',
      'app.restrictedSite': '{b} sperrt hier Erweiterungen',
      'app.restrictedSiteDesc': 'Diese Seite ist von {b} geschützt (z. B. der {store} oder eine per Richtlinie gesperrte Website). Der Ton wird unverarbeitet abgespielt.',
      'dev.grantDesc': 'Damit eine Erweiterung Gerätenamen sieht, braucht {b} einmalig Mikrofonzugriff. Audio Extender nimmt nie etwas auf und nutzt das Mikrofon nicht — es listet nur die Geräte auf.',
    },
    it: {
      'set.sidebar': 'Apri nel pannello laterale',
      'set.hk.note': 'Modifica: {scheme}extensions/shortcuts',
      'set.rate': 'Valuta su {store}',
      'app.unavailableDesc': '{b} non consente alle estensioni di funzionare nelle pagine interne ({scheme}, impostazioni, {store}, visualizzatore PDF).',
      'app.restrictedSite': '{b} blocca le estensioni qui',
      'app.restrictedSiteDesc': 'Questa pagina è protetta da {b} (ad esempio {store} o un sito bloccato da un criterio). L’audio viene riprodotto senza elaborazione.',
      'dev.grantDesc': 'Per mostrare i nomi dei dispositivi a un’estensione, {b} richiede una volta l’accesso al microfono. Audio Extender non registra né usa mai il microfono: elenca solo i dispositivi.',
    },
    fr: {
      'set.sidebar': 'Ouvrir dans le panneau latéral',
      'set.hk.note': 'Modifier : {scheme}extensions/shortcuts',
      'set.rate': 'Noter sur {store}',
      'app.unavailableDesc': '{b} n’autorise pas les extensions sur les pages internes ({scheme}, paramètres, {store}, visionneuse PDF).',
      'app.restrictedSite': '{b} bloque les extensions ici',
      'app.restrictedSiteDesc': 'Cette page est protégée par {b} (par exemple {store} ou un site bloqué par une stratégie). Le son est lu sans traitement.',
      'dev.grantDesc': 'Pour montrer les noms des appareils à une extension, {b} demande une fois l’accès au micro. Audio Extender n’enregistre ni n’utilise jamais le micro : il liste seulement les appareils.',
    },
  };
  const strings = {};
  for (const [lang, dict] of Object.entries(TEXTS)) {
    strings[lang] = {};
    for (const [k, v] of Object.entries(dict)) strings[lang][k] = fill(v);
  }

  global.PLATFORM = {
    id: 'chrome',
    name: B,
    storeUrl: null, // set once the listings exist; the "Rate" button stays hidden until then

    // extensions can't run on the browsers' own stores
    restrictedHosts: ['chromewebstore.google.com', 'chrome.google.com', 'microsoftedge.microsoft.com'],

    // Side panel mode: without a popup, the toolbar button (and Alt+Shift+A) opens the side panel.
    sidebar: {
      get available() { const c = global.chrome; return !!(c && c.sidePanel && c.sidePanel.setPanelBehavior); },
      async apply(enabled) {
        const on = !!enabled && this.available;
        await global.chrome.action.setPopup({ popup: on ? '' : POPUP });
        if (this.available) await global.chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: on });
      },
      onActionClicked() {}, // Chrome opens the panel itself (openPanelOnActionClick)
    },

    // Deep mode: capture the tab's whole audio output (tabCapture + offscreen document, see capture.js).
    // Optional part of the interface — browsers without it simply don't offer deep mode.
    capture: {
      get available() { const c = global.chrome; return !!(c && c.tabCapture && c.offscreen); },
      start(tabId) { return global.chrome.runtime.sendMessage({ type: 'capture-start', tabId }); },
      stop(tabId) { return global.chrome.runtime.sendMessage({ type: 'capture-stop', tabId }); },
      async isOn(tabId) { return ((await global.chrome.storage.session.get('deep')).deep || {})[tabId] !== undefined; },
      /** Port to the offscreen document for one captured tab: metering polls and live settings. */
      connect(tabId) { return global.chrome.runtime.connect({ name: 'ae-deep:' + tabId }); },
    },

    strings,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
