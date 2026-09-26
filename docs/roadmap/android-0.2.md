# Slice: Firefox for Android support → 0.2.0

**Goal:** Audio Extender works on Firefox for Android, verified on a real phone, and is published on addons.mozilla.org as Android-compatible.

**Rule:** Android is declared (manifest `gecko_android` + the Android checkbox on AMO) **only after** every item in *Acceptance* passed on a device. In 0.1.0 it was declared too early and AMO locked the Android checkbox — see history below.

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

## Test setup (needed before any Android work)

1. Phone with **Firefox for Android** (release, 142+).
2. On the phone: Android *Developer options* → **USB debugging** on; Firefox → Settings → **Remote debugging via USB** on.
3. On the PC: Android platform tools — `winget install Google.PlatformTools` — then `adb devices` must list the phone.
4. Run the extension on the phone:
   ```
   npx web-ext run -t firefox-android --adb-device <id from adb devices> --firefox-apk org.mozilla.firefox
   ```
   Debug from desktop Firefox: `about:debugging` → the phone appears under USB devices → *Inspect* the extension (console, popup DOM).

## Unknowns to verify on the device (drive the task list)

| # | Question | Where it matters |
|---|---|---|
| U1 | How the popup opens (bottom sheet / full screen) and whether `tabs.query({active: true, currentWindow: true})` returns the web page tab | `api.activeTab()`, whole popup |
| U2 | Does the audio engine run: MAIN-world content script, `AudioContext`, `createMediaElementSource`, autoplay rules on mobile | `content/page.js` |
| U3 | `tabs.connect` / ports between popup and content script | meters, live settings |
| U4 | `scripting.executeScript` (injection into open tabs on install/update/popup) | `background.js` `injectTab` |
| U5 | `tabs.update({muted})`, `tab.audible`, `tab.mutedInfo` | Mixer mute / solo / "mute others" |
| U6 | `action.setBadgeText` visible anywhere on Android | badge setting |
| U7 | `permissions.contains/request` for a single site | "Allow on this site" notice |
| U8 | Export (download via `<a download>`) and Import (file picker, opened in a tab) | Settings → Data |
| U9 | AutoEq search: `fetch` to raw.githubusercontent.com, 850 KB index in `storage.local` | Equalizer |
| U10 | Performance / battery: engine CPU with 31-band EQ, popup polling at ~22 Hz | engine, `popup.js` `frame()` |

## Tasks

1. **Device check** — go through U1–U10, write results into this file (table above: add a *Result* column).
2. **Popup target tab (U1)** — if the popup is not attached to the page tab, resolve the target tab differently (e.g. last focused normal tab via `tabs.query({active: true, lastFocusedWindow: true})` filtered to http/https).
3. **Touch UX** (`popup/popup.js`, `popup/popup.css`, `popup/i18n.js`):
   - EQ curve: dragging works with pointer events already; Q by mouse wheel doesn't exist on touch — the Q slider stays the way; hint text for touch (`eq.hintParam` → touch variant in 6 languages)
   - double-click to reset → long-press or a reset button on touch
   - touch targets ≥ 40 px on `html.mobile` (chips, band chips, mixer buttons, vertical sliders in 31-band mode)
   - gauge wheel → no-op on touch, the slider and ± buttons remain
4. **Mixer (U5)** — feature-detect mute support; hide mute / solo / "mute others" if unsupported instead of failing silently.
5. **Battery (U10)** — on `html.mobile`: poll levels ~10 Hz instead of ~22 Hz, spectrum only while the EQ tab is visible (already), consider disabling the background orb animation.
6. **Data (U8)** — make export / import work or hide them on Android with a hint.
7. **Anything that fails in U2–U4** — fix or document as a known limitation in README → *Where it can't work*.
8. **Declare Android** (only after *Acceptance*):
   - `manifest.json`: add `"gecko_android": { "strict_min_version": "142.0" }`
   - version `0.2.0`, CHANGELOG entry
   - README: mention Android in *Install*; AMO listing texts (`docs/amo/listing/*.md`): add Android to the description in 6 languages
   - optional: phone screenshots for AMO (`docs/amo/screenshots/`)
9. **Release** — `npx web-ext lint`, `npx web-ext build`, upload on AMO with **Firefox for Android checked**.

## Acceptance (all on a real phone)

- [ ] Popup opens, shows the current site, all 5 tabs usable with a finger, nothing cut off (portrait, 360–412 px wide)
- [ ] Gain 200 % audibly louder on a YouTube (m.youtube.com) video; limiter keeps 600 % clean
- [ ] EQ preset and a dragged band audibly change the sound; 10- and 31-band sliders usable
- [ ] At least one effect (clear dialogue or bass boost) audible
- [ ] Settings survive closing Firefox and reopening; theme and language applied
- [ ] Mixer lists playing tabs; volume per tab works; mute works or is hidden
- [ ] A tab opened before installation works without reload (or shows the reload notice)
- [ ] DRM site (e.g. Spotify web) keeps playing, notice shown
- [ ] No errors in the extension console during all of the above
- [ ] Desktop regression: engine and lifecycle end-to-end tests still pass (16/16, 17/17)
