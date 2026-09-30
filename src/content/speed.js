/* =========================================================
   Audio Extender — speed keys and speed badge (isolated world)

   Loaded right before content/content.js, which creates it with
   window.__audioExtenderSpeed(env) and tells it about speed changes.

   Keys on the page (by physical key, so any keyboard layout works;
   the user can change them: app.speedKeyMap, see AE.speedKeyMap):
     S / D  slower / faster (step: app.speedStep, 0.1)   R  back to 1×
     G      1× ↔ the last other speed  Z / X  back / forward (app.seekSeconds, 10 s)
   Hold (a key the user assigns): 2× while held (double the speed from 2× up),
   back to the site's speed on release; never stored.
   Loop (assigned by the user): 1st press sets A, 2nd sets B and loops A–B, 3rd clears.
   Frame back / forward (assigned by the user): pause and step 1/30 s.
   Range 0.1–16×.
   Shift + mouse wheel over a video: faster / slower by the same step
   (app.speedWheel, off by default; the listener exists only while it is on,
   because a non-passive wheel listener can slow down scrolling).
   Never while typing or with a modifier, only in frames with media.
   A change is stored as the site's speed, like the popup slider.

   Badge: "1.5×" over the playing video for about a second whenever
   the speed changes — no permanent overlay. For media of a minute or
   longer at a speed other than 1× it adds the time left at that speed
   ("1.5× · −12:30"), without words, so it needs no translation.
   ========================================================= */
(() => {
  'use strict';

  if (window.__audioExtenderSpeed) return;

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
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !e.isTrusted || !env.alive()) return;
      const s = env.settings(), app = env.app();
      if (!s || !app || !app.speedKeys || (app.speedKeysOff || {})[env.host()] || !AE.siteAllowed(app, env.host())) return;
      const action = AE.speedKeyMap(app)[e.code];
      if (!action) return; // not one of ours: the page gets it untouched
      if (typing(e) || !mediaHere()) return;

      const cur = s.fx.speed.value;
      if (action === 'hold') {
        if (!held && !e.repeat) holdStart(e.code, cur);
      } else if (action === 'loop') {
        if (!e.repeat) loopKey();
      } else if (action === 'frameBack' || action === 'frameForward') {
        frameStep(action === 'frameBack' ? -1 : 1);
      } else if (action === 'back' || action === 'forward') {
        const el = target();
        if (!el || !isFinite(el.currentTime)) return;
        const seek = round(pick(app.seekSeconds, AE.SEEK_STEPS, 10) * (app.seekScaled ? cur : 1));
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

    /* ---------- hold for 2× ---------- */
    let held = null; // { code, el } while the hold key is down

    function holdStart(code, cur) {
      const el = target();
      if (!el) return;
      const rate = cur < 2 ? 2 : Math.min(AE.SPEED_MAX, cur * 2);
      held = { code, el };
      try { el.playbackRate = rate; } catch { held = null; return; }
      badge(rate);
    }

    function holdEnd() {
      if (!held) return;
      const { el } = held;
      held = null;
      const s = env.settings();
      const v = s ? s.fx.speed.value : 1;
      try { el.playbackRate = v; } catch { /* locked by the player */ }
      badge(v);
    }

    addEventListener('keyup', (e) => {
      if (!held || e.code !== held.code) return;
      holdEnd();
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
    // released while the page wasn't listening (another window, tab switch): don't stay fast
    addEventListener('blur', holdEnd);
    document.addEventListener('visibilitychange', holdEnd);

    /* ---------- A–B loop and frame steps ---------- */
    let loop = null, loopRaf = 0; // { el, a, b }: b is null while only A is set

    function loopCheck() {
      if (loop && loop.b != null && loop.el.currentTime >= loop.b) loop.el.currentTime = loop.a;
    }
    // timeupdate alone comes ~4× a second: check every frame while the page is visible
    function loopTick() { loopCheck(); loopRaf = loop && loop.b != null ? requestAnimationFrame(loopTick) : 0; }

    function loopClear() {
      if (!loop) return;
      loop.el.removeEventListener('timeupdate', loopCheck);
      loop.el.removeEventListener('loadstart', loopClear); // another video in the same player
      cancelAnimationFrame(loopRaf);
      loop = null;
    }

    function loopKey() {
      const el = target();
      if (!el || !isFinite(el.currentTime)) return;
      if (!loop || loop.el !== el) {
        loopClear();
        loop = { el, a: el.currentTime, b: null };
        el.addEventListener('timeupdate', loopCheck);
        el.addEventListener('loadstart', loopClear);
        show('A ' + clock(loop.a), true);
      } else if (loop.b == null && el.currentTime > loop.a + 0.2) {
        loop.b = el.currentTime;
        el.currentTime = loop.a;
        loopTick();
        show(`A ${clock(loop.a)} → B ${clock(loop.b)} ⟲`, true);
      } else {
        loopClear();
        show('A–B ✕', true);
      }
    }

    function frameStep(dir) {
      const el = target();
      if (!el || !isFinite(el.currentTime)) return;
      if (!el.paused) el.pause();
      // browsers don't tell the frame rate: 1/30 s steps reach every frame of 24–30 fps video
      const end = isFinite(el.duration) ? el.duration : Infinity;
      el.currentTime = Math.max(0, Math.min(end, el.currentTime + dir / 30));
      show((dir < 0 ? '◀ ' : '▶ ') + clock(el.currentTime, true), true);
    }

    /* ---------- Shift + wheel over a video ---------- */
    let wheelOn = false, lastWheel = 0;

    function overVideo(x, y) {
      return [...document.querySelectorAll('video')].some((v) => {
        const r = v.getBoundingClientRect();
        return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
    }

    function onWheel(e) {
      if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || !e.isTrusted || !env.alive()) return;
      const s = env.settings(), app = env.app();
      if (!s || !app || !app.speedWheel || (app.speedKeysOff || {})[env.host()] || !AE.siteAllowed(app, env.host())) return;
      const d = e.deltaY || e.deltaX; // with Shift, some systems turn the wheel into horizontal scrolling
      if (!d || !overVideo(e.clientX, e.clientY)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const now = performance.now();
      if (now - lastWheel < 80) return; // touchpads send a burst of small events: one step per gesture tick
      lastWheel = now;
      const cur = s.fx.speed.value;
      const v = clamp(cur + Math.sign(-d) * pick(app.speedStep, AE.SPEED_STEPS, 0.1));
      if (v !== cur) env.setSpeed(v);
      else badge(v);
    }

    /** Settings changed: add or remove the wheel listener. */
    function sync() {
      const app = env.app();
      const want = !!(app && app.speedWheel);
      if (want === wheelOn) return;
      wheelOn = want;
      if (want) addEventListener('wheel', onWheel, { capture: true, passive: false });
      else removeEventListener('wheel', onWheel, { capture: true });
    }

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

    /** 754 s → "12:34", 3725 s → "1:02:05"; `frac`: hundredths too ("12:34.56"). */
    function clock(sec, frac) {
      const t = frac ? sec : Math.round(sec);
      const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
      const ss = frac ? s.toFixed(2).padStart(5, '0') : String(Math.floor(s)).padStart(2, '0');
      return (h ? `${h}:${String(m).padStart(2, '0')}` : m) + ':' + ss;
    }

    /** " · −12:30": how long the media still plays at speed `v` ('' when it doesn't help). */
    function timeLeft(v) {
      const el = target();
      if (!el || v === 1 || !isFinite(el.duration) || el.duration < 60) return '';
      return ' · −' + clock(Math.max(0, el.duration - el.currentTime) / v);
    }

    function badge(v) { show(String(+(+v).toFixed(2)) + '×' + timeLeft(v)); }

    /** `always`: answers to a key press (loop, frame) show even with the speed badge turned off. */
    function show(text, always) {
      const app = env.app();
      if (!app || (!app.speedBadge && !always) || document.hidden || !mediaHere()) return;
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
      box.d.textContent = text;
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
      sync,
    };
  }

  Object.defineProperty(window, '__audioExtenderSpeed', { value: createSpeed, configurable: true });
})();
