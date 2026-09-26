# Contributing to Audio Extender

Thanks for helping! Bug reports, ideas and translations are welcome — open an [issue](https://github.com/AlexeyKopkin/Audio-Extender/issues) or a pull request.

## How it works

Firefox has no `tabCapture` API, so the extension processes audio inside the page. It routes the page's `<audio>` / `<video>` elements and the page's own Web Audio graphs through its processing chain:

```
AutoEq → EQ → bass → dialogue → night mode → stereo (width / mono / balance) → normalization → gain → limiter → soft clipper
```

- Nothing is touched while all settings are neutral — media is only routed once processing is actually needed.
- Audio that Web Audio would turn silent is never routed: DRM (EME) media and media from another domain without CORS keep playing untouched, and the popup says so.
- A media element is only routed once its AudioContext is actually rendering, so autoplay rules or a slow audio device can't cause a gap.

## Project structure

```
manifest.json
background.js        badge, keyboard shortcuts, sidebar mode, "lower other tabs", install / update
shared/settings.js   settings model shared by all parts (defaults, per-site logic, schema version)
content/page.js      audio engine (runs in the page)
content/content.js   bridge between the page and the extension
popup/               popup / sidebar UI (popup.js, api.js, i18n.js, popup.css)
_locales/            extension name and description in six languages
icons/
docs/screenshots/    images used in the README
```

## Development

Load the extension: `about:debugging` → *This Firefox* → *Load Temporary Add-on…* → select `manifest.json`.

Or with [web-ext](https://github.com/mozilla/web-ext):

```
npx web-ext run      # start Firefox with the extension
npx web-ext lint     # the same checks addons.mozilla.org runs
```

Design preview without installing: open `popup/popup.html` directly in a browser — it runs on demo data. Tab, theme and language can be set in the URL:

```
popup.html#eq&theme=cyber&lang=de
```

## Translations

UI texts live in `popup/i18n.js` (one block per language), the extension name and description in `_locales/<lang>/messages.json`. To add a language, add a block with the same keys and an entry in `LANGS`.

## Releases and updates

Firefox updates the extension from addons.mozilla.org automatically. To keep updates smooth:

1. **Version** — bump `version` in `manifest.json` ([SemVer](https://semver.org/)) and describe the changes in [CHANGELOG.md](CHANGELOG.md).
2. **Settings format** — new fields with a default in `shared/settings.js` need nothing: missing values are filled in from the defaults. If existing data has to change shape, bump `SCHEMA` and add a step to `MIGRATIONS` (same file); the background script runs it on update.
3. **Page messages** — if the message format between `content/content.js` and `content/page.js` changes, bump `PROTOCOL` in both `shared/settings.js` and `content/page.js`. Tabs still running the old engine then show "Reload the page" instead of misbehaving.
4. **Check and package** — `npx web-ext lint`, then `npx web-ext build` and upload the zip to AMO.

On install and update the extension injects itself into tabs that are already open, so they work without a reload. Settings, profiles and presets are kept.
