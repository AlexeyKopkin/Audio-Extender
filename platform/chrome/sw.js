/* =========================================================
   Audio Extender — Chrome / Edge service worker entry.

   Chrome runs the background as a service worker (no event page),
   so the shared background scripts are loaded here, in the same
   order as the Firefox manifest's background.scripts, plus the
   Chrome-only deep mode (capture.js).
   ========================================================= */
importScripts('/shared/settings.js', '/platform.js', '/background.js', '/capture.js');
