/* =========================================================
   Audio Extender — speed keys and speed badge (isolated world)

   Loaded right before content/content.js, which creates it with
   window.__audioExtenderSpeed(env) and tells it about speed changes.

   Keys on the page (by physical key, so any keyboard layout works):
     S / D  slower / faster (step: app.speedStep, 0.1)   R  back to 1×
     G      1× ↔ the last other speed  Z / X  back / forward (app.seekSeconds, 10 s)
   Range 0.1–16×.
   Never while typing or with a modifier, only in frames with media.
   A change is stored as the site's speed, like the popup slider.

   Badge: "1.5×" over the playing video for about a second whenever
   the speed changes — no permanent overlay.
   ========================================================= */
(() => {
  'use strict';

  if (window.__audioExtenderSpeed) return;

  const KEYS = { KeyS: 'slower', KeyD: 'faster', KeyR: 'reset', KeyG: 'toggle', KeyZ: 'back', KeyX: 'forward' };
  const round = (v) => Math.round(v * 100) / 100;
  const clamp = (v) => Math.min(AE.SPEED_MAX, Math.max(AE.SPEED_MIN, round(v)));
  const pick = (v, allowed, def) => (allowed.includes(v) ? v : def);

  /** env: { alive(), settings(), app(), host(), setSpeed(v) } */
  function createSpeed(env) {
    let last = 1.5; // what G goes back to

    const mediaHere = () => document.querySelector('video, audio');

    function typing(e) {
      const path = e.composedPath ? e.composedPath() : [e.target];
      return path.some((n) => n instanceof Element && (
        n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName) || n.getAttribute('role') === 'textbox'));
    }

    /** The media the keys act on: the largest playing one, else one that has played. */
    function target() {
      const all = [...document.querySelectorAll('video, audio')];
      const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
      const playing = all.filter((el) => !el.paused).sort((a, b) => area(b) - area(a));
      return playing[0] || all.find((el) => el.currentTime > 0) || all[0] || null;
    }

    function onKey(e) {
      const action = KEYS[e.code];
      if (!action || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !e.isTrusted || !env.alive()) return;
      const s = env.settings(), app = env.app();
      if (!s || !app || !app.speedKeys || (app.speedKeysOff || {})[env.host()]) return;
      if (typing(e) || !mediaHere()) return;

      const cur = s.fx.speed.value;
      if (action === 'back' || action === 'forward') {
        const el = target();
        if (!el || !isFinite(el.currentTime)) return;
        const seek = pick(app.seekSeconds, AE.SEEK_STEPS, 10);
        const d = action === 'back' ? -seek : seek;
        const end = isFinite(el.duration) ? el.duration : Infinity;
        el.currentTime = Math.max(0, Math.min(end, el.currentTime + d));
      } else {
        const step = pick(app.speedStep, AE.SPEED_STEPS, 0.1);
        let v = cur;
        if (action === 'slower') v = clamp(cur - step);
        else if (action === 'faster') v = clamp(cur + step);
        else if (action === 'reset') v = 1;
        else if (action === 'toggle') v = cur !== 1 ? 1 : last;
        if (cur !== 1 && v === 1) last = cur;
        if (v !== cur) env.setSpeed(v);
        else badge(v); // at a limit: still show where it is
      }
      // ours: the site shouldn't act on the same key too
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    addEventListener('keydown', onKey, true);

    /* ---------- badge ---------- */
    let box = null, timer = 0;

    function anchor() {
      const vids = [...document.querySelectorAll('video')].filter((v) => {
        const r = v.getBoundingClientRect();
        return r.width > 80 && r.height > 60 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      });
      const v = vids.find((x) => !x.paused) || vids[0];
      if (!v) return { x: 12, y: 12 };
      const r = v.getBoundingClientRect();
      return { x: Math.max(8, r.left + 12), y: Math.max(8, r.top + 12) };
    }

    function badge(v) {
      const app = env.app();
      if (!app || !app.speedBadge || document.hidden || !mediaHere()) return;
      const fs = document.fullscreenElement;
      if (fs && fs instanceof HTMLMediaElement) return; // a fullscreen <video> can't hold an overlay
      if (!box) {
        const host = document.createElement('audio-extender-speed');
        const sh = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = `
          :host { all: initial; position: fixed; z-index: 2147483647; pointer-events: none; }
          div { padding: 6px 12px; border-radius: 999px; background: rgba(12, 12, 20, .72); color: #fff;
            font: 700 18px/1.2 system-ui, sans-serif; letter-spacing: .2px; box-shadow: 0 4px 18px rgba(0,0,0,.35);
            transition: opacity .3s; }
          div.out { opacity: 0; }`;
        const d = document.createElement('div');
        sh.append(style, d);
        box = { host, d };
      }
      (fs || document.documentElement).append(box.host);
      const p = anchor();
      box.host.style.left = p.x + 'px';
      box.host.style.top = p.y + 'px';
      box.d.textContent = String(+(+v).toFixed(2)) + '×';
      box.d.classList.remove('out');
      clearTimeout(timer);
      timer = setTimeout(() => {
        box.d.classList.add('out');
        timer = setTimeout(() => box.host.remove(), 350);
      }, 900);
    }

    return {
      /** The site's speed changed (keys, popup, another frame): confirm it on screen. */
      changed(v) { badge(v); },
    };
  }

  Object.defineProperty(window, '__audioExtenderSpeed', { value: createSpeed, configurable: true });
})();
