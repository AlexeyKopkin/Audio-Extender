# Changelog

All notable changes to Audio Extender. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

Chrome and Edge.

- Chrome and Edge version from the same code (one package for both)
- Chrome / Edge: option to open in the browser's side panel
- Chrome / Edge: deep mode — for audio the page can't hand over (another domain without permission), the popup offers to process the whole tab; the browser shows a sharing indicator on the tab while it's on
- The site line shows "audio playing" also when the audio plays but can't be processed
- Clearer when a page's audio can't be processed: the notice names the reason (copy protection or audio from another site), and the Booster gauge fades with a short "Not applied" line instead of moving without effect (Chrome / Edge: with a Deep mode link)
- Output device per tab: "Play on" in the Booster and in every Mixer row sends a tab to other speakers or headphones; remembered per site, back to the default device if the chosen one is missing
  - Firefox: the first choice opens Firefox's device picker from a button on the page; on later visits the device switches over with the first click on the page
  - Chrome / Edge: the tab plays through deep mode; device names need a one-time microphone permission (nothing is recorded)
  - Not available on Firefox for Android
- Playback speed from 0.1× to 16×; the slider has a log scale, so the usual speeds around 1× stay easy to set. Firefox plays sound only between 0.125× and 8×; outside that range the popup says so
- Speed keys on pages: `S` / `D` slower / faster by 0.1, `R` back to 1×, `G` between 1× and the last speed, `Z` / `X` back / forward 10 s. The step (0.05 / 0.1 / 0.25) and the jump (5 / 10 / 15 / 30 s) can be changed. The keys work on any keyboard layout, never while typing, and can be turned off everywhere or for one site (Effects → Playback speed); a key press is remembered as the site's speed
- A short "1.5×" badge over the video confirms a speed change, then disappears (can be turned off); for videos of a minute or longer it also shows the time left at that speed ("1.5× · −12:30")
- Players that set the speed back to 1× when a new video starts get the site's speed again; a change made later in the player's own menu is kept
- Firefox: the limiter's "Reduction" no longer shows about −1 dB when nothing is being limited
- Shortcuts for speed faster / slower / back to 1× that work without clicking into the page; they have no keys by default — set them in the browser's extension shortcuts
- The speed keys can be changed or turned off one by one (Effects → Playback speed → Change keys)
- Optional keys for an A-B loop (set A, set B, clear) and frame-by-frame steps; the jump keys can jump further at higher speed
- Optional hold key: 2× while the key is held, the site's speed again on release (assign it under Change keys)
- Optional: Shift + mouse wheel over a video changes the speed (Effects → Playback speed, off by default)
- Exact values: click the gain number or the speed to type a value; Shift + mouse wheel over the gauge changes the gain by 1%
- "Only on sites I choose" (Settings): on every other site nothing is touched — no processing, no speed keys, no output device; the popup there offers "Turn on here"
- Maximum volume (Settings): 150 / 200 / 300 / 400 / 600%. Nothing plays louder than that — not the slider, the Mixer, the shortcut, or a site saved or imported with a higher level
- A paused tab no longer keeps the computer awake: audio processing goes to sleep after 10 seconds without playback and wakes up with the next play

## [0.2.1] — 2026-09-29

- Fixed: sites whose player first points the video at another domain and then switches it to a streamed source stayed "can't be processed" — the source is now checked again whenever it changes
- The popup shows "audio playing" instead of "no audio yet" when sound plays but the settings don't change anything yet

## [0.2.0] — 2026-09-26

Firefox for Android.

- Firefox for Android is supported (142 or newer)
- Fixed: on Firefox for Android the background script stopped at the missing windows / keyboard-shortcut APIs, so installing, updating and settings changes were not handled
- Mixer: mute, solo and "mute others" are hidden where the browser can't mute tabs (Firefox for Android) instead of doing nothing
- Touch: double-tap resets an EQ point or a graphic-EQ slider; EQ hints explain touch gestures; buttons and controls are at least 40 px on phones
- Phones: meters update less often and the background isn't animated, to save battery
- The popup finds the current page even when the browser opens it outside the page's window
- Minimum Firefox version is now 142 (needed for the "no data collection" declaration on all platforms; removes the AMO validation warning)

## [0.1.1] — not published (superseded by 0.2.0)

- Firefox for Android is no longer declared as supported until it has been tested (planned for 0.2.0)
- On browsers without a sidebar (Firefox for Android) the "Open in sidebar" option is hidden and can never disable the toolbar button
- The popup fits narrow phone screens instead of being cut off at 480 px
- Keyboard shortcuts are hidden where the browser doesn't support them

## [0.1.0] — not published (superseded by 0.2.0)

First version.

- Booster up to 600% with limiter and soft clipper
- Parametric EQ (up to 8 bands), 10- and 31-band graphic EQ, presets, own presets, AutoEq headphone correction
- Effects: clear dialogue, night mode, bass boost, stereo width, normalization, mono, balance, playback speed
- Mixer for all tabs with audio: per-tab gain, mute, solo, lower other tabs
- Per-site profiles, 5 themes, 6 languages, keyboard shortcuts, sidebar mode, export / import
- Never silences audio: DRM media, cross-origin media without CORS and not-yet-running audio contexts are left untouched
- Works in tabs that were open before installation or an update — no reload needed
- Settings schema version 1
