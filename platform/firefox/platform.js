/* =========================================================
   Audio Extender — Firefox platform layer

   Everything that differs between browsers lives here, behind the
   same PLATFORM interface in every build (see platform/chrome/platform.js):
     id, name, storeUrl, restrictedHosts, sidebar, strings
   and optionally capture (deep mode; Firefox has no tab-capture API)
   and audibleSpeed (speeds at which the browser still plays sound).
   Loaded right after shared/settings.js in the background and the popup.
   ========================================================= */
(function (global) {
  'use strict';

  const POPUP = 'popup/popup.html';
  const api = () => global.browser;

  global.PLATFORM = {
    id: 'firefox',
    name: 'Firefox',
    storeUrl: 'https://addons.mozilla.org/firefox/addon/audio-extender/',
    audibleSpeed: [0.125, 8], // outside, Firefox plays media without sound

    // Firefox does not run extensions on these sites (extensions.webextensions.restrictedDomains)
    restrictedHosts: [
      'accounts-static.cdn.mozilla.net', 'accounts.firefox.com', 'addons.cdn.mozilla.net', 'addons.mozilla.org',
      'api.accounts.firefox.com', 'content.cdn.mozilla.net', 'discovery.addons.mozilla.org', 'install.mozilla.org',
      'oauth.accounts.firefox.com', 'profile.accounts.firefox.com', 'support.mozilla.org', 'sync.services.mozilla.com',
    ],

    // Sidebar mode: the toolbar button opens the sidebar instead of the popup.
    // Firefox for Android has no sidebar: there the popup must always stay enabled.
    sidebar: {
      get available() { const b = api(); return !!(b && b.sidebarAction && b.sidebarAction.toggle); },
      apply(enabled) { return api().action.setPopup({ popup: enabled && this.available ? '' : POPUP }); },
      onActionClicked() { if (this.available) api().sidebarAction.toggle(); }, // fires only while the popup is disabled
    },

    // UI texts that name the browser, its pages or its store (merged over popup/i18n.js)
    strings: {
      en: {
        'set.hk.note': 'Change: about:addons → ⚙ → Manage Extension Shortcuts',
        'set.rate': 'Rate on addons.mozilla.org',
        'app.unavailableDesc': 'Firefox doesn’t let extensions work on internal pages (about:, settings, addons.mozilla.org, reader view).',
        'app.restrictedSite': 'Firefox blocks extensions here',
        'app.restrictedSiteDesc': 'This page is protected by Firefox (for example the PDF viewer or a site restricted for security reasons). Its audio plays without processing.',
      },
      ru: {
        'set.hk.note': 'Изменить: about:addons → ⚙ → Управление сочетаниями клавиш',
        'set.rate': 'Оценить на addons.mozilla.org',
        'app.unavailableDesc': 'Firefox не разрешает расширениям работать на служебных страницах (about:, настройки, addons.mozilla.org, режим чтения).',
        'app.restrictedSite': 'Firefox запрещает здесь расширения',
        'app.restrictedSiteDesc': 'Эта страница защищена Firefox (например, просмотр PDF или сайт с ограничениями безопасности). Звук здесь играет без обработки.',
      },
      uk: {
        'set.hk.note': 'Змінити: about:addons → ⚙ → Керування комбінаціями клавіш',
        'set.rate': 'Оцінити на addons.mozilla.org',
        'app.unavailableDesc': 'Firefox не дозволяє розширенням працювати на службових сторінках (about:, налаштування, addons.mozilla.org, режим читання).',
        'app.restrictedSite': 'Firefox забороняє тут розширення',
        'app.restrictedSiteDesc': 'Ця сторінка захищена Firefox (наприклад, перегляд PDF або сайт з обмеженнями безпеки). Звук тут грає без обробки.',
      },
      de: {
        'set.hk.note': 'Ändern: about:addons → ⚙ → Tastenkombinationen für Erweiterungen verwalten',
        'set.rate': 'Auf addons.mozilla.org bewerten',
        'app.unavailableDesc': 'Firefox erlaubt Erweiterungen nicht auf internen Seiten (about:, Einstellungen, addons.mozilla.org, Leseansicht).',
        'app.restrictedSite': 'Firefox sperrt hier Erweiterungen',
        'app.restrictedSiteDesc': 'Diese Seite ist von Firefox geschützt (z. B. der PDF-Betrachter oder eine aus Sicherheitsgründen eingeschränkte Website). Der Ton wird unverarbeitet abgespielt.',
      },
      it: {
        'set.hk.note': 'Modifica: about:addons → ⚙ → Gestisci scorciatoie estensioni',
        'set.rate': 'Valuta su addons.mozilla.org',
        'app.unavailableDesc': 'Firefox non consente alle estensioni di funzionare nelle pagine interne (about:, impostazioni, addons.mozilla.org, vista lettura).',
        'app.restrictedSite': 'Firefox blocca le estensioni qui',
        'app.restrictedSiteDesc': 'Questa pagina è protetta da Firefox (ad esempio il visualizzatore PDF o un sito limitato per motivi di sicurezza). L’audio viene riprodotto senza elaborazione.',
      },
      fr: {
        'set.hk.note': 'Modifier : about:addons → ⚙ → Gérer les raccourcis d’extensions',
        'set.rate': 'Noter sur addons.mozilla.org',
        'app.unavailableDesc': 'Firefox n’autorise pas les extensions sur les pages internes (about:, paramètres, addons.mozilla.org, mode lecture).',
        'app.restrictedSite': 'Firefox bloque les extensions ici',
        'app.restrictedSiteDesc': 'Cette page est protégée par Firefox (par exemple la visionneuse PDF ou un site restreint pour des raisons de sécurité). Le son est lu sans traitement.',
      },
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
