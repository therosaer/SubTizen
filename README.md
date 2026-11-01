<div align="center">

<img src="app/res/icon.png" alt="SubTizen" width="128" height="128">

# SubTizen

**A Subsonic-compatible music client for Tizen 2.4 smart TVs** — 2016 Samsung models.

[![Tizen](https://img.shields.io/badge/Tizen-2.4-2596be?style=flat-square)](https://www.tizen.org/)
[![Platform](https://img.shields.io/badge/platform-Samsung%20TV-1428a0?style=flat-square)](https://developer.samsung.com/tv)
[![Status](https://img.shields.io/badge/status-working-brightgreen?style=flat-square)](#build)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

</div>

---

A 10-foot music client driven entirely by the remote control. Talks to any
Subsonic-compatible server — Navidrome, Airsonic, Gonic, Subsonic — and renders an
Apple Music–style interface with synced lyrics.

## Screenshots

| Home (dark) | Home (light) |
|---|---|
| ![Home screen in dark mode](docs/screenshots/home-dark.png) | ![Home screen in light mode](docs/screenshots/home-light.png) |

| Artists | Search |
|---|---|
| ![Artists screen with A–Z letter strip](docs/screenshots/artists.png) | ![Search screen with on-screen keyboard](docs/screenshots/search.png) |

## Features

- 🎵 **Plays your library** — streams from any Subsonic server, transcoding FLAC/Ogg to MP3
- 🖼️ **Apple Music–style UI** — lavender gradient, translucent nav pill, artwork card rows
- 🎛️ **Full remote support** — D-pad, media keys, number-pad track jumps
- 📋 **Server playlists** — your Navidrome/Airsonic playlists, fetched live and playable
- 🎤 **Synced lyrics** — per-line highlighting from LRCLIB, backdrop tinted from album art
- 🌗 **Dark mode** — remembered across launches
- 🔍 **Search** — on-screen keyboard, since a TV remote has no text input

## Screens

| Screen | What it does |
|---|---|
| **Home** | Recently Played, Recently Added, and Top Picks as horizontal card rows that page as you scroll right |
| **Artists** | Every artist A–Z, with a letter strip; Enter opens their albums |
| **Playlists** | Playlists from the server, with owner and song count; Enter opens the track list |
| **Search** | On-screen keyboard with debounced results, albums first then songs |
| **Now Playing** | Large art, synced lyrics, seeker, and transport buttons |
| **Transport bar** | Persistent on every screen except Now Playing |

## Project layout

```
app/                 the web app (this is what gets packaged)
  config.xml         Tizen widget manifest, required_version="2.4"
  index.html         nav pill + all screens + transport bar
  css/style.css      Apple Music-inspired 10-foot UI, D-pad focus styling
  js/subsonic.js     Subsonic REST client (XHR, no fetch)
  js/lyrics.js       LRCLIB synced-lyrics client (XHR, no fetch)
  js/keys.js         Tizen remote key registration + keycode constants
  js/app.js          UI logic, playback, remote keybindings
  lib/md5.js         pure-JS MD5 (RFC 1321 verified)
  res/icon.png       app icon
tools/package.sh     builds dist/SubTizen.wgt
```

## Package identity

Tizen requires the package id to be **exactly 10 alphanumeric characters**, so
`config.xml` uses `SubTizen01` as `tizen:application/@package` and
`SubTizen01.SubTizen` as the application id. The widget `version` is bumped for each
release; the current release is `1.0.1`.

## Build

```bash
./tools/package.sh
```

Produces `dist/SubTizen.wgt`. Uses the Tizen Studio packager if installed at
`~/tizen-studio` (set `TIZEN_PROFILE` to your signing profile), otherwise falls back to
plain `zip` — which is what a `.wgt` is, and is enough for sideloading in developer mode.

## Install on the TV

Grab `SubTizen.wgt` from the [latest release](../../releases/latest), or build it
yourself with `./tools/package.sh`.

1. On the TV: **Apps → Settings → Developer mode**, enable it, and set the host PC's IP.
2. Reboot the TV, then:

   ```bash
   sdb connect <TV_IP>:26101
   sdb install dist/SubTizen.wgt
   ```

3. Launch **SubTizen** from the Apps screen.

## Remote control

| Key | Action |
|---|---|
| Up / Down / Left / Right | Move focus |
| Enter | Activate focused card, track, or button |
| Back / Return | Go back one screen |
| MediaPlay / MediaPause / MediaPlayPause | Playback control |
| MediaStop | Stop and rewind to 0 |
| MediaRewind / MediaFastForward | Seek back / forward 10s |
| MediaTrackNext / MediaTrackPrevious | Next / previous track |
| Number pad | Jump to track N in the open album |

Media and number keys only reach the page if the app registers them first via
`tizen.tvinputdevice.registerKey()`, which also requires the
`http://tizen.org/privilege/tv.inputdevice` privilege in `config.xml`. Without it the
registration fails silently and the remote's play/pause button does nothing.

Keycodes vary between TV models, so `keys.js` asks the device what it supports and
dispatches on the key *name*, falling back to hardcoded constants only when the device
reports nothing. If a button still does nothing, **press `0` three times** to show an
on-screen overlay of the last keycodes received.

## Tizen 2.4 constraints

| Constraint | Consequence |
|---|---|
| No `fetch` | All API calls use `XMLHttpRequest` |
| No `window.crypto.subtle` | `lib/md5.js` provides MD5 for token auth |
| WebKit decodes MP3/AAC, **not FLAC or Ogg/Opus** | Stream requests pass `format=mp3` |
| `maxBitRate` alone transcodes to **Ogg/Opus** | Always send `format=mp3` too |
| No ES6 modules / no build step | Plain scripts, ES5 syntax, IIFEs |
| WebKit does **not** move focus on arrow keys | D-pad navigation implemented in JS |
| Media/number keys are **not delivered unless registered** | `keys.js` registers them at startup |

## Security notes

- **Plaintext password auth** (`u=`/`p=`) is used for maximum server compatibility. The
  password is sent on every request and stored in `localStorage`. Fine on a trusted home
  LAN, **not safe over the internet** — the token scheme (`t=md5(password+salt)`) is
  already supported by the bundled MD5 library and is the recommended upgrade.
- **Lyrics leave the LAN.** Track title, artist, and album are sent to LRCLIB. No
  credentials or server address are included. Point `BASE` in `app/js/lyrics.js` at a
  self-hosted instance to avoid this.

## Known gaps

- No queue, shuffle, or repeat
- No volume control
- Servers that don't send `Access-Control-Allow-Origin` fail with `Network unreachable`
  (Navidrome sends permissive headers, so direct XHR works)

---

Detailed engineering notes — UI internals, D-pad and scrolling behaviour, keycode
diagnostics, and Tizen quirks — live in [HANDOVER.md](HANDOVER.md).

## License

[MIT](LICENSE) © 2026 therosaer.
