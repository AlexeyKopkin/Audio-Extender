# addons.mozilla.org listing kit

Everything needed to fill in the Audio Extender page on [addons.mozilla.org](https://addons.mozilla.org/developers/).

| What | File | Where on AMO |
|---|---|---|
| Name, summary, description, screenshot captions | `listing/en.md` (default) + `ru`, `uk`, `de`, `it`, `fr` | *Edit Product Page* — switch the language at the top of the form for each translation |
| Icon | `icon-128.png` | *Edit Product Page → Icon* |
| Screenshots (1280×800) | `screenshots/<lang>/01-booster.png` … `06-themes.png` — one set per language, the popup shown in that language (also used for the Chrome Web Store and Edge, see `../store/README.md`) | *Edit Product Page → Screenshots*, in this order, for each language; delete the old ones |
| Notes to reviewer | below | *Upload Version → Notes to Reviewer* |
| Release notes | `release-notes/<version>.md` (EN, RU) | *Upload Version → Release notes* |

Other fields:

- **Add-on URL (slug):** `audio-extender` — the popup's "Rate" button links to `https://addons.mozilla.org/firefox/addon/audio-extender/`
- **Categories:** Photos, Music & Videos
- **Support site:** `https://github.com/AlexeyKopkin/Audio-Extender/issues`
- **Homepage:** `https://github.com/AlexeyKopkin/Audio-Extender`
- **License:** GNU General Public License v3.0
- **Privacy policy:** not required — no data is collected (`data_collection_permissions: none`)
- **Compatibility:** Firefox for desktop and Firefox for Android (from 0.2.0; the manifest declares both)
- **Source code submission:** No — plain, unminified JavaScript; the build only copies files unchanged from `src/` and `platform/firefox/` (no bundler, minifier or transpiler)

The description uses the Markdown subset AMO supports (bold, lists, inline code, links); paste the content of the ```` ```markdown ```` block as is.

## Notes to reviewer

```
Plain, unminified JavaScript — no bundler, no minification, no remote code. The package files are the source files as they are.

content/chain.js and content/page.js run in the page's MAIN world: page.js routes <audio>/<video> elements and the page's own
AudioContexts through the Web Audio processing chain from chain.js (EQ, effects, gain, limiter, pitch). It talks to
content/content.js only through CustomEvents carrying JSON strings. content/speed.js (isolated world) handles the
speed keys on the page and shows a short speed badge.

Output device per tab: content.js calls navigator.mediaDevices.selectAudioOutput() only from a click on its own
button in the page (Firefox shows its device picker); the chosen device id is kept per site in storage.local.

Settings sync is opt-in (Settings): storage.sync holds the user's settings only.

Network: the only request is an optional download of the public AutoEq headphone database (MIT)
from raw.githubusercontent.com, made when the user searches for their headphones.

Permissions:
- <all_urls> host permission: processing audio on any site the user visits.
- scripting: re-injecting the content scripts into already open tabs after install/update,
  so they work without a reload.
- storage: user settings.
```
