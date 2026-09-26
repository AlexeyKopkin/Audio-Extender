# addons.mozilla.org listing kit

Everything needed to fill in the Audio Extender page on [addons.mozilla.org](https://addons.mozilla.org/developers/).

| What | File | Where on AMO |
|---|---|---|
| Name, summary, description, screenshot captions | `listing/en.md` (default) + `ru`, `uk`, `de`, `it`, `fr` | *Edit Product Page* — switch the language at the top of the form for each translation |
| Icon | `icon-128.png` | *Edit Product Page → Icon* |
| Screenshots (1280×800) | `screenshots/01-booster.png` … `05-themes.png` | *Edit Product Page → Screenshots*, in this order |
| Notes to reviewer | below | *Upload Version → Notes to Reviewer* |

Other fields:

- **Add-on URL (slug):** `audio-extender` — the popup's "Rate" button links to `https://addons.mozilla.org/firefox/addon/audio-extender/`
- **Categories:** Photos, Music & Videos
- **Support site:** `https://github.com/AlexeyKopkin/Audio-Extender/issues`
- **Homepage:** `https://github.com/AlexeyKopkin/Audio-Extender`
- **License:** GNU General Public License v3.0
- **Privacy policy:** not required — no data is collected (`data_collection_permissions: none`)
- **Compatibility:** Firefox for desktop
- **Source code submission:** No — the code is plain, unminified JavaScript without a build step

The description is written in the HTML subset AMO accepts (`<b>`, `<ul>`, `<li>`, `<code>`, `<a>`); paste the content of the ```` ```html ```` block as is.

## Notes to reviewer

```
Plain, unminified JavaScript — no build step, no bundler, no remote code.

content/page.js runs in the page's MAIN world: it routes <audio>/<video> elements and the page's own
AudioContexts through a Web Audio processing chain (EQ, effects, gain, limiter). It talks to
content/content.js only through CustomEvents carrying JSON strings.

Network: the only request is an optional download of the public AutoEq headphone database (MIT)
from raw.githubusercontent.com, made when the user searches for their headphones.

Permissions:
- <all_urls> host permission: processing audio on any site the user visits.
- scripting: re-injecting the content scripts into already open tabs after install/update,
  so they work without a reload.
- storage: user settings.
```
