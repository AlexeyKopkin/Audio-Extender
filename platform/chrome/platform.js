/* =========================================================
   Audio Extender — Chrome / Edge platform layer

   Same PLATFORM interface as platform/firefox/platform.js:
     id, name, storeUrl, restrictedHosts, sidebar, strings
   One package serves Chrome and Edge; texts name the browser it runs in.
   Loaded right after shared/settings.js in the service worker and the popup.
   ========================================================= */
(function (global) {
  'use strict';

  const nav = global.navigator || {};
  const isEdge = !!((nav.userAgentData && nav.userAgentData.brands || []).some((b) => /Edge/.test(b.brand)) || /\bEdg\//.test(nav.userAgent || ''));
  const B = isEdge ? 'Edge' : 'Chrome';
  const SCHEME = isEdge ? 'edge://' : 'chrome://';
  const STORE = isEdge ? 'Edge Add-ons' : 'Chrome Web Store';
  const fill = (s) => s.replace(/\{b\}/g, B).replace(/\{scheme\}/g, SCHEME).replace(/\{store\}/g, STORE);

  const TEXTS = {
    en: {
      'set.hk.note': 'Change: {scheme}extensions/shortcuts',
      'set.rate': 'Rate on {store}',
      'app.unavailableDesc': '{b} doesn’t let extensions work on internal pages ({scheme}, settings, {store}, PDF viewer).',
      'app.restrictedSite': '{b} blocks extensions here',
      'app.restrictedSiteDesc': 'This page is protected by {b} (for example {store} or a site blocked by a policy). Its audio plays without processing.',
    },
    ru: {
      'set.hk.note': 'Изменить: {scheme}extensions/shortcuts',
      'set.rate': 'Оценить в {store}',
      'app.unavailableDesc': '{b} не разрешает расширениям работать на служебных страницах ({scheme}, настройки, {store}, просмотр PDF).',
      'app.restrictedSite': '{b} запрещает здесь расширения',
      'app.restrictedSiteDesc': 'Эта страница защищена {b} (например, {store} или сайт, закрытый политикой). Звук здесь играет без обработки.',
    },
    uk: {
      'set.hk.note': 'Змінити: {scheme}extensions/shortcuts',
      'set.rate': 'Оцінити в {store}',
      'app.unavailableDesc': '{b} не дозволяє розширенням працювати на службових сторінках ({scheme}, налаштування, {store}, перегляд PDF).',
      'app.restrictedSite': '{b} забороняє тут розширення',
      'app.restrictedSiteDesc': 'Ця сторінка захищена {b} (наприклад, {store} або сайт, закритий політикою). Звук тут грає без обробки.',
    },
    de: {
      'set.hk.note': 'Ändern: {scheme}extensions/shortcuts',
      'set.rate': 'Im {store} bewerten',
      'app.unavailableDesc': '{b} erlaubt Erweiterungen nicht auf internen Seiten ({scheme}, Einstellungen, {store}, PDF-Betrachter).',
      'app.restrictedSite': '{b} sperrt hier Erweiterungen',
      'app.restrictedSiteDesc': 'Diese Seite ist von {b} geschützt (z. B. der {store} oder eine per Richtlinie gesperrte Website). Der Ton wird unverarbeitet abgespielt.',
    },
    it: {
      'set.hk.note': 'Modifica: {scheme}extensions/shortcuts',
      'set.rate': 'Valuta su {store}',
      'app.unavailableDesc': '{b} non consente alle estensioni di funzionare nelle pagine interne ({scheme}, impostazioni, {store}, visualizzatore PDF).',
      'app.restrictedSite': '{b} blocca le estensioni qui',
      'app.restrictedSiteDesc': 'Questa pagina è protetta da {b} (ad esempio {store} o un sito bloccato da un criterio). L’audio viene riprodotto senza elaborazione.',
    },
    fr: {
      'set.hk.note': 'Modifier : {scheme}extensions/shortcuts',
      'set.rate': 'Noter sur {store}',
      'app.unavailableDesc': '{b} n’autorise pas les extensions sur les pages internes ({scheme}, paramètres, {store}, visionneuse PDF).',
      'app.restrictedSite': '{b} bloque les extensions ici',
      'app.restrictedSiteDesc': 'Cette page est protégée par {b} (par exemple {store} ou un site bloqué par une stratégie). Le son est lu sans traitement.',
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

    // Side panel mode arrives with chrome.sidePanel; until then the option is hidden.
    sidebar: {
      available: false,
      apply() { return Promise.resolve(); },
      onActionClicked() {},
    },

    strings,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
