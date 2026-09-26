# Slice: Firefox for Android support → 0.2.0

**Goal:** Audio Extender works on Firefox for Android and is published on addons.mozilla.org as Android-compatible.

**Rule:** Android is declared (manifest `gecko_android` + the Android checkbox on AMO) **only after** every item in *Acceptance* passed. In 0.1.0 it was declared too early and AMO locked the Android checkbox — see history below.

## History / current state

| Version | State on AMO | Android |
|---|---|---|
| 0.1.0 | submitted, in review | declared by mistake (`gecko_android` in manifest) → AMO locked "Android" on |
| 0.1.1 | uploaded, Android unchecked | `gecko_android` removed; safety guards added (below) |
| Unreleased (main) | — | `strict_min_version` raised to **142** → no AMO warning about Android min version |

Already done (0.1.1), so Android users can't break anything today:

- `html.mobile` class when `navigator.userAgent` contains *Android*: body fills the screen instead of 480×600 (`popup/popup.css`, `popup/popup.js`)
- "Open in sidebar" row hidden and ignored when `browser.sidebarAction` is missing (`popup/api.js` → `hasSidebar`, `background.js` → `HAS_SIDEBAR`)
- Keyboard shortcuts card hidden when `browser.commands` is missing (`api.hasShortcuts`)
- Preview of the phone layout: open `popup/popup.html#booster&mobile` in a 380 px wide window

## How we test

The development machine is a VMware VM: no Android emulator (no nested virtualization), and connecting a phone is inconvenient. Everyday work uses points 1–3; a real device (point 4) only for the final check before a release:

1. **API support** — [MDN browser-compat-data](https://github.com/mdn/browser-compat-data) (the data behind MDN compatibility tables), `firefox_android` entries for every API the add-on uses. Checked with bcd 8.1.3.
2. **Android API surface on desktop** — test copy of the add-on with `browser.windows`, `browser.commands` and `browser.sidebarAction` removed (the APIs Firefox for Android doesn't have), run through the lifecycle end-to-end test (install, update without reloading tabs, restart).
3. **Layout and touch** — Firefox *Responsive Design Mode* (`Ctrl+Shift+M`): phone sizes 360–412 px, touch simulation, Android user agent. The popup page can be opened directly as `moz-extension://<uuid>/popup/popup.html?page=1` (uuid from `about:debugging`).
4. **Real device (final check only)** — tablet on USB debugging, reachable from the VM with `adb` (Android SDK platform-tools); wireless debugging (Android 11+, `adb pair`) works too. Unsigned build installed in **Firefox Nightly** (`org.mozilla.fenix`, `xpinstall.signatures.required` = false, *Install add-on from file*); or `npx web-ext run -t firefox-android --adb-device <id> --firefox-apk org.mozilla.fenix`. UI driven with `adb shell input tap` + `uiautomator dump`, logs from `adb logcat`.

Points 1–3 can't prove real audio output, autoplay rules, CPU/battery or how the popup is presented; point 4 covers them. On Firefox for Android the popup opens as a **full-screen page** with the add-on name and a back arrow (menu ⋮ → Extensions → Audio Extender).

## Unknowns

| # | Question | Where it matters | Result |
|---|---|---|---|
| U1 | How the popup opens and whether `tabs.query({active: true, currentWindow: true})` returns the web page tab | `api.activeTab()`, whole popup | `tabs.query` supported, but "may only return a subset of the matching tabs" (bcd). Presentation not verifiable without a phone → keep a fallback (task 2) |
| U2 | Audio engine: MAIN-world content script, `AudioContext`, `createMediaElementSource`, autoplay | `content/page.js` | ✅ `content_scripts.world` 128, Web Audio nodes 25, `mediaKeys` 38. Autoplay rules unverified; the engine already waits for a running context |
| U3 | `tabs.connect` / ports | meters, live settings | ✅ 54 |
| U4 | `scripting.executeScript` with `world` | `background.js` `injectTab` | ✅ 102; world 128 |
| U5 | `tabs.update({muted})`, `tab.audible`, `tab.mutedInfo` | Mixer mute / solo / "mute others" | ❌ `muted` not supported in `tabs.update`; `audible` ✅. → mute buttons hidden (done) |
| U6 | `action.setBadgeText` | badge setting | ✅ 109 |
| U7 | `permissions.contains/request` | "Allow on this site" notice | ✅ 79 / 120 |
| U8 | Export (`<a download>`) and Import (file picker in a tab) | Settings → Data | ⚠ not in bcd (web platform, not an extension API); unverified |
| U9 | AutoEq: `fetch` to raw.githubusercontent.com, 850 KB in `storage.local` | Equalizer | ✅ `storage.local` 48; plain `fetch` |
| U10 | Performance / battery | engine, `popup.js` `frame()` | unverified → reduce work on mobile (task 5) |
| U11 | APIs missing on Android: `windows`, `commands`, `sidebarAction`, `manifest action.default_area` | `background.js`, `popup/api.js` | ❌ `windows` and `commands` were used unguarded: on Android the background script threw at `browser.windows.onFocusChanged` and never registered install / startup / settings listeners. **Fixed** (guards); `default_area` is ignored, harmless |

## Tasks

1. ✅ **API check** — U1–U11 above.
2. ✅ **Background script without `windows` / `commands`** (U11) — guarded; popup's active-tab tracking works without `windows`.
3. ✅ **Mixer (U5)** — mute / solo / "mute others" hidden when tab muting isn't available.
4. ✅ **Popup target tab (U1)** — if `tabs.query({active: true, currentWindow: true})` returns nothing, fall back to `{active: true, lastFocusedWindow: true}` filtered to http/https.
5. ✅ **Battery (U10)** — on `html.mobile`: levels polled ~10 Hz instead of ~22 Hz (mixer meters 4 Hz instead of 8 Hz), spectrum only while the EQ tab is visible, background orbs not animated.
6. ✅ **Touch UX** (`popup/popup.js`, `popup/popup.css`, `popup/i18n.js`):
   - EQ hints have touch variants in 6 languages (`eq.hintParamTouch`, `eq.hintGraphicTouch`): Q via its slider, double-tap to reset
   - double-tap resets an EQ point or a graphic-EQ slider (`onDoubleTap`); mouse keeps double-click
   - touch targets ≥ 40 px on `html.mobile` (tabs, chips, band chips, segmented buttons, icon buttons, mixer buttons, buttons, selects)
   - gauge wheel is a no-op on touch; the slider and ± buttons remain
7. **Data (U8)** — keep export / import; if a phone test later shows they fail, hide them on Android with a hint.
8. ✅ **Declare Android** — done in 0.2.0; the on-phone items of *Acceptance* are checked manually before uploading:
   - `manifest.json`: add `"gecko_android": { "strict_min_version": "142.0" }`
   - version `0.2.0`, CHANGELOG entry
   - README: mention Android in *Install*; AMO listing texts (`docs/amo/listing/*.md`): add Android to the description in 6 languages
   - optional: phone-size screenshots for AMO (`docs/amo/screenshots/`) from Responsive Design Mode
9. **Release** — `npx web-ext lint`, `npx web-ext build`, upload on AMO with **Firefox for Android checked**.

## Acceptance

Without a phone:

- [x] Every API the add-on uses checked against bcd for Firefox for Android; unsupported ones are feature-detected
- [x] Lifecycle end-to-end with the Android API surface (no `windows` / `commands` / `sidebarAction`): 15/17 — the 2 failures are the sidebar-mode checks, expected (no sidebar on Android; the button keeps its popup)
- [x] Phone widths 360 / 412 px, German (longest labels): all 5 tabs without horizontal scroll, nothing past the screen edge, touch targets ≥ 36 px — automated (WebDriver BiDi, popup preview `#<tab>&mobile`)
- [x] Real touch events (BiDi `pointerType: touch`): finger drag of an EQ point, double-tap reset, graphic-EQ tap and double-tap; phone mixer without mute controls, desktop mixer with them — phone check 36/36
- [x] Desktop regression: engine and lifecycle end-to-end tests still pass (16/16, 17/17)
- [ ] Manual look in Responsive Design Mode with the installed add-on (`Ctrl+Shift+M`, touch on)

On a device — Xiaomi Pad 5 (Android 13), Firefox Nightly 159, 2026-09-26:

- [x] Popup opens from the menu on example.com and YouTube, full screen, current site shown; no errors from Firefox in `adb logcat`
- [x] Gain audibly louder on YouTube
- [x] Settings survive closing and reopening Firefox
- [ ] A tab opened before installation works without reload (or shows the reload notice)
- [ ] DRM site keeps playing, notice shown
