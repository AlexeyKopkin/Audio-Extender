# Contributing to Audio Extender

Thanks for helping! Bug reports, ideas and translations are welcome — open an [issue](https://github.com/AlexeyKopkin/Audio-Extender/issues) or a pull request.

## How it works

The extension processes audio inside the page — no tab capture, so no recording indicator. It routes the page's `<audio>` / `<video>` elements and the page's own Web Audio graphs through its processing chain:

```
AutoEq → EQ → bass → dialogue → night mode → stereo (width / mono / balance) → normalization → gain → limiter → soft clipper
```

- Nothing is touched while all settings are neutral — media is only routed once processing is actually needed (or once the tab plays on another output device).
- Audio that Web Audio would turn silent is never routed: DRM (EME) media and media from another domain without CORS keep playing untouched, and the popup says so.
- A media element is only routed once its AudioContext is actually rendering, so autoplay rules or a slow audio device can't cause a gap.
- Our AudioContext is suspended 10 s after its last routed media stopped (a running context holds the audio device open, which keeps the computer awake) and resumed from `play()` / the `play` event before the element's audio arrives. The page's own AudioContexts are never suspended.
- **Deep mode (Chrome / Edge, on demand):** for sources the page can't hand over, the popup offers to capture the whole tab (`tabCapture`) and play it through the same chain in an offscreen document (`platform/chrome/capture.js`, `offscreen.js`). The page engine of that tab switches to bypass so nothing is processed twice; if the capture can't start, the tab keeps playing as before. Firefox has no tab-capture API, so it doesn't offer this mode.
- **Output device per tab:** device ids are per origin, so each browser gets there differently. Firefox: `content/content.js` calls `selectAudioOutput()` in the page (needs a click in the page: an on-page button the first time, afterwards the first click / key press on the page re-selects silently), and the chain plays through `MediaStreamAudioDestinationNode` → hidden `<audio>` → `setSinkId`. Chrome / Edge: the extension lists the devices in its own origin (one-time microphone permission from an extension tab) and the tab plays through deep mode, whose `AudioContext.setSinkId` takes those ids. The choice is stored per site in `outputs` — not in presets or exported settings, because the ids only mean something in this browser profile. If the device can't be used, the tab plays on the default device.

## Project structure

One shared core and one small folder per browser — the same layout large cross-browser extensions use.

```
src/                     shared by all browsers
  background.js          badge, keyboard shortcuts, sidebar mode, "lower other tabs", install / update
  shared/settings.js     settings model (defaults, per-site logic, schema version)
  content/chain.js       processing chain (one per AudioContext)
  content/page.js        audio engine (runs in the page)
  content/speed.js       speed keys and the speed badge (isolated world, before content.js)
  content/content.js     bridge between the page and the extension
  popup/                 popup / sidebar UI (popup.js, api.js, i18n.js, popup.css)
  popup/preview.js       demo data for the design preview (not in the store packages)
  _locales/              extension name and description in six languages
platform/firefox/        Firefox: manifest.json, platform.js, SVG icon
platform/chrome/         Chrome and Edge: manifest.json, platform.js, service worker entry (sw.js), deep mode (capture.js, offscreen.html/.js), PNG icons
scripts/                 build and package check
dist/                    build output (not in git)
docs/screenshots/        images used in the README
```

Rules that keep the browsers from breaking each other:

- **Everything that differs between browsers lives in `platform/<browser>/platform.js`** behind the same `PLATFORM` interface: browser name, store link, sites where extensions can't run, how the sidebar opens, and the UI texts that name the browser. The core asks `PLATFORM`; it never checks which browser it is running in.
- **The core uses feature detection** for things that differ inside one browser family (for example Firefox for Android has no tab muting or keyboard shortcuts).
- **A platform folder never contains a core file.** The build stops if `platform/<browser>/` has a file with the same path as one in `src/`.
- **Each browser has its own version** in its `manifest.json`. A change only in `platform/chrome/` leaves the Firefox package byte-for-byte the same, so Firefox needs no new release.

## Development

```
npm run build            # all targets
npm run build:firefox    # → dist/firefox/  + web-ext-artifacts/audio_extender-firefox-<version>.zip
npm run build:chrome     # → dist/chrome/   + web-ext-artifacts/audio_extender-chrome-<version>.zip (Chrome and Edge)
npm run build:preview    # → dist/preview/  design preview with demo data
npm run lint:firefox     # build, then the same checks addons.mozilla.org runs
npm run run:firefox      # build, then start Firefox with the extension
```

On Windows the same with a double click: `build-firefox.cmd` (build + lint) and `build-chrome.cmd` in the repository root (`/q` skips the pause at the end).

The build copies `src/` and the platform folder unchanged — no bundler, no minification — and checks the package (every referenced file exists, translations are complete, no Firefox-only keys in the Chrome manifest).

Load a build:

- **Firefox:** `about:debugging` → *This Firefox* → *Load Temporary Add-on…* → `dist/firefox/manifest.json`
- **Chrome / Edge:** `chrome://extensions` (or `edge://extensions`) → *Developer mode* → *Load unpacked* → `dist/chrome`

### Design preview

Without installing: `npm run build:preview`, then open `dist/preview/popup/popup.html` in a browser — it runs on demo data. Tab, theme, language and the phone layout can be set in the URL:

```
popup.html#eq&theme=cyber&lang=de&mobile
```

## Translations

UI texts live in `src/popup/i18n.js` (one block per language); texts that name the browser live in `platform/<browser>/platform.js`; the extension name and description in `src/_locales/<lang>/messages.json`. To add a language, add a block with the same keys and an entry in `LANGS`.

## Releases and updates

Firefox updates the extension from addons.mozilla.org automatically. To keep updates smooth:

1. **Version** — bump `version` in `platform/<browser>/manifest.json` of each browser that gets a release ([SemVer](https://semver.org/)) and describe the changes in [CHANGELOG.md](CHANGELOG.md).
2. **Settings format** — new fields with a default in `src/shared/settings.js` need nothing: missing values are filled in from the defaults. If existing data has to change shape, bump `SCHEMA` and add a step to `MIGRATIONS` (`src/shared/settings.js`); the background script runs it on update.
3. **Page messages** — if the message format between `content/content.js` and `content/page.js` changes, bump `PROTOCOL` in both `src/shared/settings.js` and `src/content/page.js`. Tabs still running the old engine then show "Reload the page" instead of misbehaving.
4. **Check and package** — Firefox: `npm run lint:firefox`, then upload `audio_extender-firefox-<version>.zip` to AMO. Chrome / Edge: `npm run build:chrome` and upload `audio_extender-chrome-<version>.zip` to the Chrome Web Store and Edge Add-ons.

On install and update the extension injects itself into tabs that are already open, so they work without a reload. Settings, profiles and presets are kept.
