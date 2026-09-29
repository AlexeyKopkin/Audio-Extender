# Changelog

All notable changes to Audio Extender. Versions follow [Semantic Versioning](https://semver.org/).

## [0.2.1] — unreleased

- Fixed: sites whose player first points the video at another domain and then switches it to a streamed source stayed "can't be processed" — the source is now checked again whenever it changes
- The popup shows "audio playing" instead of "no audio yet" when sound plays but the settings don't change anything yet

## [0.2.0] — unreleased

Firefox for Android.

- Firefox for Android is supported (142 or newer)
- Fixed: on Firefox for Android the background script stopped at the missing windows / keyboard-shortcut APIs, so installing, updating and settings changes were not handled
- Mixer: mute, solo and "mute others" are hidden where the browser can't mute tabs (Firefox for Android) instead of doing nothing
- Touch: double-tap resets an EQ point or a graphic-EQ slider; EQ hints explain touch gestures; buttons and controls are at least 40 px on phones
- Phones: meters update less often and the background isn't animated, to save battery
- The popup finds the current page even when the browser opens it outside the page's window
- Minimum Firefox version is now 142 (needed for the "no data collection" declaration on all platforms; removes the AMO validation warning)

## [0.1.1] — unreleased

- Firefox for Android is no longer declared as supported until it has been tested (planned for 0.2.0)
- On browsers without a sidebar (Firefox for Android) the "Open in sidebar" option is hidden and can never disable the toolbar button
- The popup fits narrow phone screens instead of being cut off at 480 px
- Keyboard shortcuts are hidden where the browser doesn't support them

## [0.1.0] — unreleased

First version.

- Booster up to 600% with limiter and soft clipper
- Parametric EQ (up to 8 bands), 10- and 31-band graphic EQ, presets, own presets, AutoEq headphone correction
- Effects: clear dialogue, night mode, bass boost, stereo width, normalization, mono, balance, playback speed
- Mixer for all tabs with audio: per-tab gain, mute, solo, lower other tabs
- Per-site profiles, 5 themes, 6 languages, keyboard shortcuts, sidebar mode, export / import
- Never silences audio: DRM media, cross-origin media without CORS and not-yet-running audio contexts are left untouched
- Works in tabs that were open before installation or an update — no reload needed
- Settings schema version 1
