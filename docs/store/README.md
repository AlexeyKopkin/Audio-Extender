# Chrome Web Store / Edge Add-ons listing kit

Everything needed for the Audio Extender pages on the [Chrome Web Store](https://chrome.google.com/webstore/devconsole) and [Edge Add-ons](https://partner.microsoft.com/dashboard/microsoftedge). Both use the same package: `web-ext-artifacts/audio_extender-chrome-<version>.zip`.

| What | File / value |
|---|---|
| Package | `audio_extender-chrome-0.5.0.zip` (one package for Chrome and Edge) |
| Name | Audio Extender |
| Short description (≤ 132 characters) | `listing/<lang>.md` → *Short description* |
| Detailed description (plain text) | `listing/<lang>.md` → *Description* |
| Languages | English (default), Русский, Українська, Deutsch, Italiano, Français — texts in `listing/<lang>.md`, images per language |
| Slide texts | `slides.json` (made into images by the screenshot tool) |
| Category | Chrome Web Store: **Lifestyle → Entertainment** (recommended; Tools as the alternative). Edge: **Entertainment** if offered, else Productivity |
| Icon 128×128 | `../amo/icon-128.png` |
| Screenshots 1280×800 | `../amo/screenshots/<lang>/01-booster.png` … `05-effects.png`, one set per language (Chrome Web Store takes up to 5; Edge up to 10 — add `06-themes.png` there) |
| Small promo tile 440×280 | `promo/<lang>.png` (Chrome Web Store, required; one per language) |
| Homepage | `https://github.com/AlexeyKopkin/Audio-Extender` |
| Support | `https://github.com/AlexeyKopkin/Audio-Extender/issues` |
| Privacy policy URL | not required (no user data) — if a field insists: `https://github.com/AlexeyKopkin/Audio-Extender#privacy` |
| Mature content | No |
| Visibility | Public |

## Privacy practices (Chrome Web Store → Privacy tab)

**Single purpose**

```
Improve and control the audio of web pages: volume boost, equalizer, sound effects, playback speed, per-tab mixer and output device.
```

**Permission justifications**

| Permission | Justification |
|---|---|
| `storage` | `Saves the user's audio settings for each site, presets and profiles, locally (and in the browser account only if the user turns on settings sync).` |
| `scripting` | `After install or update, injects the extension's own audio script into tabs that were already open, so they work without a reload.` |
| `sidePanel` | `Optional mode chosen in Settings: the extension's controls open in the browser's side panel instead of the popup.` |
| `tabCapture` | `Deep mode, started only by the user's click: processes the audio of the current tab when the page doesn't let the in-page engine access it (audio from another domain), and plays a tab on the output device the user chose.` |
| `offscreen` | `Required by Manifest V3 to play the captured tab audio (deep mode) through the extension's audio processing; no page is shown.` |
| Host permission `<all_urls>` | `The audio engine must run on every site the user plays sound on, to change its volume, equalizer, effects and speed. No page content is read, stored or sent anywhere.` |
| Remote code | `No, I am not using remote code.` |

**Data usage** — tick nothing (no category of user data is collected), then certify all three statements:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

The microphone is not a manifest permission: Chrome / Edge ask for it at run time only when the user wants to see the names of output devices; nothing is recorded (said in the description and in the popup).

## Edge Add-ons extras

- **Notes for certification:**

```
Plain, unminified JavaScript — no bundler, no minification, no remote code. The same package is published on the Chrome Web Store.
How to test: open any page with audio or video (for example a YouTube video), click the toolbar button and move the gain dial,
switch on an effect or change the speed (keys S / D on the page). "Deep mode" appears only for audio the page can't hand over.
```

- Search terms (up to 7): volume booster, equalizer, bass boost, sound booster, video speed controller, audio mixer, playback speed
