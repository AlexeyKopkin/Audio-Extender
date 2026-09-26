# Audio Extender

A Firefox extension that makes any browser tab sound better: volume booster up to 600%, a full parametric equalizer and audio effects — with a modern, themeable UI.

> **Status:** early development (v0.1). Requires Firefox 140 or later.

## Features

- **Booster** — up to 600% gain with a built-in limiter, so loud never means distorted
- **Equalizer** — parametric EQ with draggable bands on a live frequency-response curve, plus 10- and 31-band graphic modes, presets and headphone correction (AutoEq)
- **Effects** — clear dialogue, night mode, bass boost, stereo width, loudness normalization, mono, L/R balance, playback speed with pitch preservation
- **Mixer** — every tab playing audio in one place: per-tab volume, mute and solo
- **Per-site profiles** — settings are remembered for each site
- **Themes** — Neon (default), Cyber, Sunset, Aurora, Light
- **Languages** — English, Русский, Українська, Deutsch, Italiano, Français

## How it works

Firefox has no `tabCapture` API, so the extension processes audio inside the page: it routes the page's `<audio>` / `<video>` elements and Web Audio graphs through its own Web Audio chain:

```
AutoEq → EQ → bass → dialogue → night mode → stereo (width / mono / balance) → normalization → gain → limiter → soft clipper
```

- Nothing is touched while all settings are neutral — media is only routed once processing is actually needed.
- Media served from another domain without CORS permission is never routed (Web Audio would turn it silent); it keeps playing untouched and the popup says so.
- A media element is only routed once its AudioContext is allowed to run, so autoplay rules can't mute it.

## Privacy

Audio Extender collects no data. All processing happens locally in the browser. The only network request is made when you search for headphones: the public [AutoEq](https://github.com/jaakkopasanen/AutoEq) database (MIT) is downloaded from GitHub and cached.

## Project structure

```
manifest.json
background.js        badge, keyboard shortcuts, sidebar mode, "lower other tabs"
shared/settings.js   settings model shared by all parts
content/page.js      audio engine (runs in the page)
content/content.js   bridge between the page and the extension
popup/               popup / sidebar UI (popup.js, api.js, i18n.js, popup.css)
_locales/            extension name and description in six languages
icons/
```

## Development

Load the extension: `about:debugging` → *This Firefox* → *Load Temporary Add-on…* → select `manifest.json`.

Or with [web-ext](https://github.com/mozilla/web-ext):

```
npx web-ext run      # start Firefox with the extension
npx web-ext lint     # the same checks addons.mozilla.org runs
```

Design preview without installing: open `popup/popup.html` directly in a browser — it runs on fake data. Tab, theme and language can be set in the URL:

```
popup.html#eq&theme=cyber&lang=de
```

## Releases and updates

Firefox updates the extension from addons.mozilla.org automatically. To keep updates smooth:

1. **Version** — bump `version` in `manifest.json` ([SemVer](https://semver.org/)) and describe the changes in [CHANGELOG.md](CHANGELOG.md).
2. **Settings format** — new fields with a default in `shared/settings.js` need nothing: missing values are filled in from the defaults. If existing data has to change shape, bump `SCHEMA` and add a step to `MIGRATIONS` (same file); the background script runs it on update.
3. **Page messages** — if the message format between `content/content.js` and `content/page.js` changes, bump `PROTOCOL` in both `shared/settings.js` and `content/page.js`. Tabs still running the old engine then show "Reload the page" instead of misbehaving.
4. **Check and package** — `npx web-ext lint`, then `npx web-ext build` and upload the zip to AMO.

On install and update the extension injects itself into tabs that are already open, so they work without a reload. Settings, profiles and presets are kept.

## Contributing

Bug reports, ideas and translations are welcome — please open an issue or a pull request.

## Support

The extension is free and ad-free. If it helps you, you can [buy me a coffee](https://buymeacoffee.com/kotx) ☕

## License

[GNU General Public License v3.0 or later](LICENSE).

The license covers the source code only. The name **“Audio Extender”** and its logo are not licensed for use by forks or derivative works — please use a different name and logo for your own version.
