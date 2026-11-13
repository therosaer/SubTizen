# SubTizen — engineering handover

Detailed notes on how the app is built and why. The [README](README.md) is the short
version; this file is the reference for anyone changing the code.

## Verified against

Tested end-to-end against a live **Navidrome** server: login, the three home card rows with
cover art, album detail, and real audio playback (MP3 and FLAC-transcoded-to-MP3) all
confirmed working, along with D-pad navigation, media keys, number-pad track jumps, the
seeker, and dark mode.

## Home screen

Three sections, in order:

- **Recently Played** — `getAlbumList2?type=recent`, 12 albums.
- **Recently Added** — `getAlbumList2?type=newest`, 12 albums.
- **Top Picks** — most-played songs. Subsonic has no global top-songs endpoint
  (`getTopSongs` requires an `artist`), so the app pulls a 500-song pool via `search3`
  with an empty query and sorts client-side by `playCount`, taking the top 12.

Each section is one horizontal row of 300 px artwork cards with 26 px gutters and 80 px
margins, so roughly five cards are visible at 1080p. Left/Right walks along the row;
Up/Down moves between sections. Cover art is requested at 600 px (2x the rendered size) so
it stays sharp on high-density panels.

**Infinite rows.** Each section pages independently at 24 items per page. Reaching the
right-hand end of a row fetches the next page and appends it, so scrolling right keeps
loading rather than stopping at the first page. A short page marks the section exhausted and
stops further requests. Top Picks is ranked by `playCount`, which the server cannot sort by,
so its pool is fetched once and paged client-side.

**Card bodies.** The text block under the artwork is transparent, so no tinted band shows
between the cover art and the title. The artwork itself carries the drop shadow.

**Focus.** The focused card grows 7% and lifts 6 px, and its artwork gains a white ring plus a soft
shadow, which stays legible on the light background. This is one CSS transition with a little overshoot
(`.card`), not keyframes: the old keyframe "settle" started at the full scale instantly, so a card popped
instead of growing. `z-index: 2` keeps the grown card above its neighbour.

**Room for the focused card.** A row (`.grid`) is a horizontal scroll container, so it clips whatever leaves
its box. It carries `padding: 44px 36px 52px` with the matching negative margin (layout unchanged), and
`.card` is `overflow: visible`, so the lifted card and its ring are never cut off (that clipping was the flat
top edge). `ROW_PAD` in `focusNode` mirrors the 36 px side padding.

**Scrolling.** `focusNode` scrolls first and focuses second (see "List scrolling" at the end). There is no JS glide: a
`scrollLeft` animation fought the browser's own focus scrolling on the TV (forward, snap back, forward again), and
every step repainted a row of cards.

**Navigation animation.** Moving up/down slides the row being entered in from the direction of travel
(`.grid.row-in-*`, a CSS keyframe replayed from JS by removing the class, forcing a reflow, and re-adding it).
List rows (tracks, artists, playlists, results) ease their background and ring and slide 10 px towards you
while focused; keys and A-Z letters scale 8%. The animations are declared with both `-webkit-` and
unprefixed properties, since Tizen 2.4's WebKit only understands the prefixed forms.

## Artists

Every artist in the library, sorted A–Z. The list is built from `getArtists`, which returns
artists bucketed by index letter rather than in order, so the app re-sorts them itself:
case-insensitively by name, with punctuation-led names (`!Kung`) folded into a `#` bucket
that always sorts last so the list order matches the A–Z strip above it. The strip is one
button per letter actually present, and selecting one jumps to the first artist under it.
Enter on an artist loads their albums via `getArtist` and shows them as a card row; Enter on
a card opens the album, and Back returns to the artist rather than to Home.

Accented letters sort and group with their base letter (`stripAccents`: `String.normalize` where the engine has it, plus
a Latin table for older ones), so "Álvaro" is under A and "Ñengo Flow" under N; non-Latin names still go to `#`.

## Playlists

Playlists come straight from the server via `getPlaylists` — the app keeps no local copy and
offers no local editing, so what you see is whatever Navidrome/Airsonic/Subsonic holds for the
logged-in user. Subsonic has no offset for this endpoint, so the whole set arrives at once and
is rendered as a vertical list, the same shape as the artist list. Each row shows cover art,
name, owner, and song count.

Enter loads the playlist via `getPlaylist` and shows its entries as a track list. The entries
are assigned to `state.songs` with `currentIndex = -1`, so playback reuses the album path
unchanged — prev/next, the seeker, and the number-pad track jump all work without special
cases.

Two server quirks are handled:

- **Empty playlists.** Navidrome returns `{"playlists":{}}` — an empty object with no
  `playlist` key at all, not `"playlist":[]`. The `(response.playlists &&
  response.playlists.playlist) || []` guard covers it.
- **`getPlaylist` shape.** Most servers return `playlist.entry[]`, but some older ones return
  a bare `playlist` array of songs. `playlistEntries()` normalises both.

Navigation is split across two screens. On the list, Up/Down walk the playlists and Up from
the first row hands off to the nav bar. On the detail screen, Up/Down walk the tracks via
`movePlaylistTracks()` rather than the generic `moveFocus()` — `moveFocus()` walks *every*
focusable, which would step onto the "back" button in the header and let the D-pad leave the
list. Both screens handle Left/Right on the nav bar explicitly: their branches `return` early,
so without that the key never reached the generic handler and the toolbar stayed stuck on
whichever tab the Up handoff landed on.

## Search

An on-screen keyboard plus a flat vertical result list, because a TV remote has no text
input. The query is shown in a read-only `<span>` rather than an `<input>`: focusing a real
input would raise the TV's IME over the results, and the number keys would be swallowed by
the login-form guard in `bindNumberKeys()`.

The keyboard is 44 `<button>`s in four 10-key rows (digits, two qwerty rows, and `- . ' &`)
plus a fifth row of wide action keys (Space / Delete / Clear / Search). Each row is its own
`.key-row` block rather than one wrapping flow: the row length is not a divisor of the
container width, so letting the keys wrap pulls a key from the next row onto the current line
and shifts every row after the first.

Typing debounces `search3` by 350 ms; the Search key bypasses the debounce. Results are
albums first, then songs, each with 72 px art, title, subtitle, and a kind label. Responses
carry a sequence number so a slow reply to an earlier query cannot overwrite a newer one.
Left/Right walk the keyboard, Up/Down move by one measured row and drop into the results from
the last row, and Back steps out of the results to the keyboard and then to the nav bar. The
query and results survive tab switches.

## Now Playing

A full-screen view: large album art on the left, the current lyric line in the middle of the
right column with the neighbouring lines dimmed above and below, and title / artist / album
above a seeker and prev/play/next buttons along the bottom.

**Lyrics** come from **LRCLIB** (`https://lrclib.net`), a free, open, keyless lyrics database
that serves LRC text with per-line timestamps. Subsonic's own `getLyrics` is not used: it
returns plain text with no timing, so the highlight could only be guessed at. LRCLIB sends
`Access-Control-Allow-Origin: *`, so the TV calls it directly.

The exact-match endpoint is tried first; when it misses (it requires the duration to agree
within a couple of seconds) the search endpoint is used and the candidate whose duration is
closest to the track's wins. Navidrome joins multiple artists with a bullet
(`Bad Bunny • Dei V`), which never matches LRCLIB's naming, so a search with just the primary
artist is tried as a last resort.

Lines prefixed with an LRC-style timestamp (`[01:23.45]`) are synced to those timings; when
no line carries one — or only some do, which would collapse the untimed lines onto the start
of the track — the lines are spread evenly across the track's duration instead. Either way
the highlighted line advances with playback, and a response is tagged with a sequence number
so a slow reply for a previous track cannot overwrite the current one.

**Backdrop tint.** The backdrop is a three-stop gradient tinted from the album art: the cover
is drawn to a 24x24 canvas, the average colour of its opaque pixels is converted to HSL, and
the saturation and lightness are clamped so pale or near-black art still yields a readable
backdrop. A cross-origin cover taints the canvas, in which case the tint is skipped and the
CSS fallback gradient is used. The tint is painted on `#backdrop` as well as the screen, so
it runs edge to edge behind the nav bar instead of being cut off by it; the nav pill, theme
toggle, tabs, and avatar turn translucent white while the screen is up so the album colour
reads through them. The tint is cleared when the screen is left, otherwise the album colour
would follow the user onto every other screen.

Left/Right walk the three buttons, Up hands off to the nav bar, Down returns to the buttons,
and Back steps out of the buttons to the nav bar and then to the album list.

## Transport bar

Persistent on every screen *except* Now Playing, which carries its own copy of the same
controls. It has album art, now-playing text, prev/play/next, a status line, and a **seeker**
showing elapsed and total time with a progress bar.

The album art sits at the left edge of the bar at 96 px, requested at 192 px, and shows a `♫`
placeholder until a track starts. The seeker is driven by the `<audio>` element's
`timeupdate`/`durationchange` events plus a 500 ms polling timer, because Tizen's WebKit does
not fire `timeupdate` at a usable rate. The total comes from the element's `duration` when it
is known and falls back to the song's own duration from the API, since Tizen reports
`Infinity` for a progressive MP3 until it has buffered enough. The seeker resets when a new
track starts. The play button's icon flips between play and pause from the element's own
`play`/`pause` events, so it stays correct no matter which control started playback. A stream
that fails to load surfaces an error in the status line instead of leaving the UI waiting.

**Transport icons** are inline SVG rather than Unicode symbols. Tizen 2.4's system font has
no coverage for U+23EE/U+23ED, so those rendered as empty boxes with a stray line through
them. `setPlayIcon()` swaps the SVG markup rather than writing glyphs, for the same reason.

## Navigation and theming

The nav pill carries **Albums / Artists / Playlists / Search / Now Playing**, all wired, plus
a **Dark** / **Light** theme toggle at the right. The circular avatar to its left shows the
first letter of the signed-in username. The pill is hidden on the login screen, since there
is nothing to navigate before a server is connected.

**Dark mode** stores the choice in `localStorage` under `subtizen.theme` and restores it on
launch. Tizen 2.4's WebKit has no CSS custom properties, so the dark theme is a block of
explicit `body.dark` rule overrides rather than variable swaps.

## Remote control

Tizen only delivers media and number keys to the page if the app registers them first via
`tizen.tvinputdevice.registerKey()`. Without registration the `keydown` events never arrive,
so `js/keys.js` registers them at startup. Registration is best-effort and silently skipped
when `tizen` is undefined, which keeps the app testable in a desktop browser.

Registration also requires the `http://tizen.org/privilege/tv.inputdevice` privilege in
`config.xml`. Without it the `registerKey()` calls fail silently and media keys never reach
the page — this is the most common cause of a remote's play/pause button doing nothing.
`bindLifecycle()` re-registers on `viewshow` and `focus`, because the TV can drop the
registration when the app is backgrounded and re-entered from the Smart Hub.

### Keybindings

| Key | keyCode | Action |
|---|---|---|
| Up / Down / Left / Right | 38 / 40 / 37 / 39 | Move focus |
| Enter | 13, 29443 | Activate focused card, track, or button |
| Back / Return | 10009, 461 | Album detail → album list |
| MediaPlay | 415 | Resume |
| MediaPause | 19 | Pause |
| MediaPlayPause | 10252 | Toggle play/pause |
| MediaStop | 413 | Stop and rewind to 0 |
| MediaRewind | 412 | Seek back 10s |
| MediaFastForward | 417 | Seek forward 10s |
| MediaTrackNext | 10253, 10255 | Next track |
| MediaTrackPrevious | 10254, 10256 | Previous track |
| Number pad | 48–57 | Jump to track N in the open album |

**Number pad behaviour.** Digits are buffered for 900 ms so that pressing `1` then `2`
selects track 12 rather than track 1 followed by track 2. Out-of-range input reports
"No track N in this album." Digits are ignored while a text input has focus, so typing a
server URL or password is unaffected.

**Media keycodes are not fixed across TV models.** The codes in the table above are the
common ones, but a given TV may report different numbers for the same physical button, which
is why play/pause can appear to do nothing. `keys.js` therefore asks the device what it
supports via `tizen.tvinputdevice.getSupportedKeys()` and records the code it uses for each
key *name*. `mediaAction()` resolves an incoming keycode to a name first and only falls back
to the hardcoded constants when the device did not report one. Dispatch is on the name, never
on the number.

Not every Tizen model exposes every media key; unsupported registrations are ignored
harmlessly. Tizen 2.4 exposes `tizen.tvinputdevice`; newer firmware uses `tizen.inputdevice`,
and `keys.js` tries both. Registration is retried for a few seconds after load, because some
sets do not populate the device API until shortly after `window.load`.

If a media button still does nothing, the app records the last keycodes it saw. Open the
browser console on the TV and read `SubTizen.lastKeys` after pressing the button — that
number is what the remote actually sends, and it can be added to the fallback table.

**Skip buttons on some remotes.** A few Samsung remotes send the skip buttons as plain
fast-forward/rewind, or as the older `KEY_NEXT`/`KEY_PREVIOUS` codes, rather than as
`MediaTrackNext`/`MediaTrackPrevious`. `KEYS` therefore carries `MEDIA_NEXT_ALT` (10255) and
`MEDIA_PREV_ALT` (10256) as aliases, and `mediaAction()` maps them to `next`/`prev`.

### On-screen key diagnostic

A TV has no readable console, so the app can show the codes on screen instead. **Press `0`
three times in a row** to display an overlay in the top-left corner listing the keycode just
received and the last twelve codes seen. It hides itself after four seconds. Press the button
that misbehaves, then press `0` three times, and read the code off the screen.

Once the code is known, add it to `KEYS` in `js/keys.js` and to the fallback `switch` in
`mediaAction()`. The overlay is deliberately triggered by a triple-zero so it cannot be
reached by accident during normal navigation.

### D-pad navigation

Tizen's WebKit does not move focus between `tabindex` elements when arrow keys are pressed —
the app must do it. `bindRemote()` in `app.js` handles this globally:

- **Left/Right** walk along the current card row, one card at a time, pulling the next page
  when the end of the row is reached. On the nav bar they walk between tabs.
- **Up/Down** move between rows. Each home section is a single horizontal row, so Up/Down
  hands off to the neighbouring section (Recently Played → Recently Added → Top Picks) and
  preserves the horizontal position, so moving down from the 4th card lands on the 4th card
  of the next row. Up from the first row reaches the nav bar; Down from the nav bar returns
  to the card the D-pad was last on, not to the first card of the first row. The row length
  is measured from the rendered geometry rather than assumed, so the layout can change
  without breaking navigation.
- **Enter** (`13`, and the Tizen remote's `29443`) activates the focused card, track, or
  button. On an album card this opens the album; on a Top Picks song card it loads that
  song's album and starts the song.
- **Back** (`10009`) and legacy **Return** (`461`) go from album detail back to the home
  screen. On the nav bar they back out to the card the D-pad was last on, so the toolbar is
  never a dead end. On a card they are a no-op.

Appending a page must not disturb focus: `renderSection()` uses `insertAdjacentHTML` rather
than `innerHTML +=`, which re-parses the whole list and destroys the focused card, dropping
focus to `<body>` and breaking D-pad navigation mid-row.

`focusFirst()` runs on every screen transition and prefers a card or track over a toolbar
button, so the D-pad always starts on content rather than on "Refresh". Focused elements are
scrolled into view explicitly, because Tizen's WebKit does not do this reliably and the home
screen is taller than the viewport.

### Row-scoped horizontal scrolling

Each `.grid` row is its own horizontal scroll container, and `focusNode()` scrolls only the
row the focused card belongs to. This matters because `overflow-x: hidden` on `.screen` still
makes the screen a horizontal scroll container, and the browser's focus-reveal would
otherwise scroll it sideways to bring a focused card into view — dragging every row left and
right together. `focusNode()` therefore pins `screen.scrollLeft` to `0` and moves the row by
hand.

Three details make the hand-rolled scroll work, and all three are easy to regress:

- **The screen is found by walking `parentNode`, not `offsetParent`.** `.screen` is not
  positioned, so it is never an `offsetParent`; the chain from a card reaches `#app` (whose
  own `offsetParent` is `null`) without ever passing through the screen. Walking
  `offsetParent` silently returns `null` and skips the whole scroll block.
- **The scroll target is computed from the card's index and layout width**, not from
  `getBoundingClientRect()`. The painted box has already been shifted by the browser's scroll
  and is scaled while focused, so geometry-based maths overshoots. Index arithmetic is
  immune to both. The step is `cardWidth + 26`, matching `.card { margin: 0 26px 0 0 }`.
- **The correction is deferred with `setTimeout(..., 0)`.** The browser performs its own
  scroll-into-view *after* `focusNode()` returns, and it is not observable through the
  `scrollLeft` setter, so an immediate correction is simply overwritten. The deferred pass
  also measures against the row's pre-focus scroll position, not its current one — otherwise
  a row the browser has already scrolled looks "already correct" and is never brought back.

Two subtleties worth keeping in mind when editing this code:

- `data-index="0"` is a valid index, so index lookups compare against `null` rather than
  testing truthiness — otherwise the first card of every grid becomes unclickable. Cards also
  carry `data-list`, because a bare index is ambiguous across the three home grids.
- A focused card is scaled by CSS, so `getBoundingClientRect()` returns the *scaled* box. Row
  detection uses `offsetTop` with a tolerance instead, or the focused card would be mistaken
  for a different row.
- The card text block is transparent. A tinted `.body` background produced a visible band
  between the cover art and the title, so the artwork carries the shadow instead.
- `body` carries two independent classes: `dark` (theme) and `now-active` (Now Playing
  layout). `applyTheme()` rewrites only the `dark` flag and `show()` rewrites only
  `now-active`; assigning `body.className` wholesale in either place silently drops the
  other, which shows up as the transport bar reappearing over the Now Playing screen.

## Audio format handling

The test library was a mix of M4A, FLAC, and MP3. Since Tizen 2.4 cannot decode FLAC, the
client requests `format=mp3`, which makes the server transcode on the fly. Servers that
cannot transcode ignore the parameter and serve the original file — those tracks will fail to
play, which is a server limitation, not an app bug.

## CORS

Tizen web apps are subject to CORS. Navidrome sends permissive headers, so direct XHR works.
Servers that do not send `Access-Control-Allow-Origin` will fail with a `Network unreachable`
status. Workarounds are a reverse proxy that adds the header, or running the app against a
server configured to allow the TV's origin.

## AirPlay

Tizen 2.4 web apps cannot advertise Bonjour services, listen on sockets or decode AirPlay audio, so
receiving is done by `bridge/` (shairport-sync -> ffmpeg -> HTTP; see `bridge/README.md`) and the app is
only a client of it.

### Client (`js/airplay.js`, AirPlay parts of `js/app.js`)

- **Polling.** `airplay.js` polls `GET <bridge>/status` every 2 s and reports `begin` (idle -> live), `end`
  and `update` to `app.js`.
- **Session rules.** A new cast (`idle -> playing/paused`) pauses the Subsonic audio, selects the AirPlay tab
  and attaches the stream. When a Subsonic track plays, `AirPlay.release()` detaches the stream and sets
  `suppressed`, so the cast does not grab the audio back. `suppressed` clears on `idle`, or when the phone has
  been paused for 4 s or more and then plays again (`RESUME_TAKEOVER_MS`; the bridge stays live while paused, so
  idle alone would leave the TV silent). A shorter gap, such as a track change, does not take over. The remote's
  play/pause (`AirPlay.toggle()`) mutes/unmutes the stream only; transport belongs to the phone.
- **Bridge address.** Optional field on the connect screen, stored in `subtizen.connection.bridge`. Blank
  means `http://<subsonic host>:5100`.
- **Screen.** `#screen-airplay` reuses the Now Playing stage CSS (selectors are doubled `#screen-now,
  #screen-airplay`) and `body.now-active` applies to both. `applyNowTint(tint, screenId)` paints one of
  them; the cover is loaded with `crossOrigin='anonymous'` so the canvas can read it (the bridge sends CORS
  headers). `body.now-active #backdrop` paints the default purple behind the nav bar so it matches the
  screen when no tint is applied.
- **`loadHome(true)`** after connecting does not steal the screen if a cast already switched to AirPlay
  while the library was loading.

### Connection settings

The nav avatar is a button that reopens the connect form, pre-filled and relabelled Save / Cancel
(`openSettings`, `closeSettings`, `submitConnection`). Back also leaves it. If only the AirPlay bridge
address changed it is saved and applied without logging in again (a down Subsonic server cannot block fixing
the bridge) and the app lands on the AirPlay tab; if the server or credentials changed it reconnects and
stays on the form until the server answers. `body.connect-active` hides the transport bar so the form fits
at 1080p.

### Players

`airplay.js` tries three players in order and remembers a failure:

1. **Web Audio** (`/stream.wav`: a 44-byte header, then raw s16le stereo 44.1 kHz). Read with `fetch()` streams,
   or XHR in `x-user-defined` text mode on older WebKit (reconnecting every 6 MB to bound memory), and
   scheduled on an `AudioContext` with a 0.35 s jitter buffer. Verified in a desktop browser only; the 2016
   TV does not use it (it was not available or failed there).
2. **Samsung AVPlay** (`webapis.avplay`, `/stream.mp3`). Needs `$WEBAPIS/webapis/webapis.js` in `index.html` and
   the `http://developer.samsung.com/privilege/avplay` privilege in `config.xml`. This is what the TV uses.
3. **The `<audio>` element** (`/stream.mp3`). Works, but the TV buffers about 20 s.

The AirPlay screen names the player in use; when it falls back to the standard one it lists what was
available and why, e.g. `Standard player (webaudio no, avplay failed: ...)`.

### Delay (measured on a UE32K5502, Tizen 2.4)

The bridge hands audio to the TV within a fraction of a second, so the delay is the TV player's own
buffering. The bridge sends tuning in `/status` (`tv: { bufferUnit, bufferAmount, format }` from
`--tv-buffer` / `--tv-format`) and `avApplyBuffer()` applies it, so experiments need no app reinstall.
Results with AVPlay:

| Setting | Delay |
|---|---|
| mp3, 1 s buffer (default) | about 3-4 s (best) |
| wav, 1 s buffer | about 4 s (no gain) |
| mp3, 500 ms buffer | worse |
| mp3, 16 KB buffer | about 15 s (much worse; the TV reads the byte unit differently) |

So the defaults are the best known setting. If the TV refuses a buffer value, the app falls back to 1 s (a byte
amount is never reused as seconds) and the AirPlay screen says so.

### Bridge state (`bridge/metadata.js`)

- A pause is not a disconnect: `pend` only ends the play session. The state goes `idle` only after `ssnc/disc`
  (observed on a real iPhone), plus a 2 s grace that ignores a `disc` right after a `conn`, or after 30 min of
  silence as a safety net for a lost `disc`.
- The position clock is the PCM actually received since the last `prgr` message, so it freezes while paused and
  resumes by itself.
- The sender delivers artwork (`PICT`) a few milliseconds *before* the track tags, and `prgr` can also arrive
  before the tags, so a bundle keeps recent art and does not zero duration/position on a title change.
- `pbeg` keeps the client name, and the cover URL version only ever increases so the TV never reuses a stale
  cover.
- No remote control: the phone sends no DACP information to an AirPlay 2 receiver, so the TV cannot pause or skip
  the phone.
- Two AirPlay 2 receivers on one computer share a device ID unless one is offset, which makes a phone connect
  and show metadata but deliver no audio; the bridge sets `airplay_device_id_offset` (default 7).
- Covered by `node bridge/test.js`.

### Tested

On a real iPhone and TV: casting, artwork, title, progress, pause and resume (seeker holds), disconnect back to
"Ready for AirPlay", and the settings screen. In a desktop browser: the AVPlay call sequence (against a stub),
the Web Audio path, and layout at 1920x1080.

## Authentication, scrobbling and play modes

- **Auth.** `Subsonic(baseUrl, user, pass, auth)` sends `t`/`s` (token, salt per client instance) by default, or `p` when
  `auth === 'plain'`. `connect()` tries token first; a Subsonic-level refusal (`err.api`, e.g. code 41 or 40) retries once
  with plain, and a plain success stores `auth: 'plain'` in `subtizen.connection` so the next launch starts there. Network
  errors are not retried. Error messages never contain the request URL (it carries credentials).
- **Scrobbling.** `playIndex()` sends `scrobble?submission=false` (now playing); `updateSeeker()` accumulates real play time
  (`trackPlayTime`, which ignores seeks and pauses) and sends `submission=true` once at half the track (10 s to 240 s). It is
  fire-and-forget and never affects playback. AirPlay is not scrobbled.
- **Failed tracks.** The audio `error` handler calls `skipAfterError()`: it moves on after 1.5 s, and gives up after
  `MAX_FAIL_STREAK` (4) failures in a row so a dead server does not cycle through the album.
- **Shuffle / repeat.** `state.shuffle`, `state.repeat` (`off|all|one`) persist in `subtizen.playmode`. Shuffle keeps a
  permutation (`state.order`, `orderPos`) built from the track you picked; Next/Prev walk it, and at the end repeat-all
  reshuffles without repeating the same track back to back. `nextTrack(auto)`: repeat-one only replays when the track ended
  by itself (`playNext(true)`), because button handlers pass the click event, so only a literal `true` counts. The two
  buttons are `#np-shuffle` / `#np-repeat` in `.np-actions`; the Now Playing buttons have ids, not classes, so key handling
  uses `isNowAction()`, and Back from them goes to the nav bar.
- **Albums tab** only refetches the library if it was never loaded or is older than 10 minutes (`HOME_REFRESH_MS`).

## Nav bar keys

Focus on the nav bar is handled once, at the top of the global keydown handler (`isNavControl`): Left/Right move along the
bar (`moveNav`), Up stays, Enter clicks. Before this, every screen's own navigation (the search keyboard, the A-Z strip, ...) also
received those keys while a tab was focused and pulled focus back into the content, so from Search or Artists the bar could not
be walked. `focusNav()` lands on the tab of the current screen, not always the first. On Artists, Up from the A-Z strip and Back
from the strip reach the nav bar. Down from the bar and Back from the bar are still decided by each screen.

## Player bar, toast, favorites and Up Next

- **Tint.** The album tint is remembered in `state.nowTint` and painted only when Now Playing is shown (`show()`); it used to be
  painted the moment it was computed, so starting a track from an album or search screen recoloured the whole app. The AirPlay
  tint works the same way (`airplayTint`).
- **Player bar.** `renderBar()` is the one place that decides what the bar shows: the Subsonic track, or an AirPlay cast
  (`airplaySourceActive()`: bridge live and not displaced by a Subsonic track) with an `AirPlay` tag, dimmed skip buttons and the
  cast's progress. It also toggles `body.no-player`, which hides the bar and gives its space back until something has played or is
  being cast, and puts a green dot (`.casting`) on the AirPlay tab. It runs on every AirPlay update, once a second, and from
  `playIndex()`. Starting a Subsonic track calls `AirPlay.release()` first so the bar never flashes the cast. `playNext`/`playPrev`
  ignore button presses while a cast owns the bar.
- **Toast.** `#status` is a fixed toast (outside the bar) that fades after 3.5 s, or 8 s for errors. Routine messages
  (`QUIET_STATUS`: Playing., Library loaded., counts, Connected) are not shown.
- **Home.** `updateHomeVisibility()` hides a row and its heading while it has no items (and shows one message if all are empty).
  `neighbourGrid()` skips such rows when moving Up/Down, instead of treating the first empty row as the end of the page (Down from
  the nav bar did nothing when Recently Played was empty). A server without `getStarred2` does not fail the home load.
- **Favorites.** `Subsonic.star(id, on)` / `getStarred()` (`star`, `unstar`, `getStarred2`). The heart on Now Playing flips at once and
  rolls back with an error toast on failure; success rebuilds the Favorites row (`refreshFavorites`). Song objects carry a `starred`
  date when starred, which is what the heart reads.
- **Up Next.** `upNext()` returns what will play after the current track: the shuffled order when shuffle is on (so it matches what Next
  really plays), otherwise the rest of the queue, plus the start again for repeat-all. The panel replaces the lyrics and track details
  (`#screen-now.queue-open`). Keys: Up from the transport buttons reaches Favorite/Up Next, Enter on Up Next opens the list and focuses it,
  Up/Down walk it, Enter plays a row, Back closes it.

## Motion

- **Art fade-in.** Card, artist, playlist and result art is a child `.art-img` layer inside a placeholder; `fadeInArt()` loads each
  image with `new Image()` and adds `.in` (an opacity transition) once it has arrived. Covers that change (player bar, Now Playing,
  AirPlay) go through `setCoverImage()`, which keeps the old cover until the new one is loaded and then replays the `.fresh` fade; stale
  loads are ignored.
- **Entrance.** `enterAttrs(n)` gives the first 10 items of a row or track list an `.enter` class with a 45 ms-per-item inline delay
  (`enter-up`, `backwards` fill so they wait invisible). A row animates the first time it renders, not on later rebuilds.
- **Plain background on browse screens.** An experiment that tinted the page with the focused album's colour was removed: the browse
  screens (Albums, Artists, Playlists, Search) keep the plain grey-lavender backdrop. Only Now Playing and AirPlay tint, from the
  playing cover (`applyNowTint`).
- **Card to album.** `openAlbum(album, returnTo, sourceCard)` measures the card's art, builds the album page, and `flyArt()` moves a copy
  of the art (a transform, not layout) onto `#album-cover`. `leaveAlbum()` reverses it onto the card's *focused* size (7% bigger, 6 px up,
  measured before focus) and focuses that card again; if the card is off screen it is a plain return. Search results and song cards open
  without the flight.
- **Now Playing.** Lyrics are built once per song as one column (`.np-lyrics-track`); a new line only restyles lines and changes the
  column's `translateY` so the current line sits one line from the top, which the CSS transition glides (edges fade with a mask). The
  cover shrinks while paused (`#screen-now.paused`, `#screen-airplay.paused`) and swells on play.
- Test note: in a hidden or unfocused browser pane CSS transitions do not advance, so `getComputedStyle` shows start values; click into
  the page (or take a screenshot) before measuring.

## Row memory

Moving Up/Down between home rows returns to the card you last had in the target row (`state.rowMemory`, filled by `rememberRowPosition`
in `focusNode`, read by `neighbourGrid`). Before, focus went to the same *column* of the next row, so browsing a few cards in one row,
going to another and coming back lost your place. A row you have not visited yet still opens at the matching column.

## Performance on a 2016 TV

Animation that is free on a desktop is not on this hardware, so motion is kept to what is cheap and the rest backs off by itself:

- **Cheap only.** Focus is a `transform` transition on one card, a static white ring (no `box-shadow` transition: it repaints every frame),
  and no `will-change` (that put a GPU layer on every card). List rows, keys and tabs have no transitions. The Now Playing cover only
  scales. The lyric glide is one `transform` on one element, which is why it stays smooth.
- **No redundant DOM writes.** The player bar redraws every second, so it only touches the page when something changed: body and tab
  classes, play/pause SVGs (`state.playIcon`), seeker text and width (`setTextIf` / `setWidthIf`, rounded to 0.2%), lyric line classes,
  and the AirPlay screen (`state.apSig`). Anything that resets those values must go through the same helpers (`resetSeekerDisplay`).
- **Lyrics block** is three lines (216 px). Taller, it runs into the song title and artist just below it.

### Row paging and moving between rows (second pass)

- **Paging.** Pages are 12 items (`PAGE_SIZE`) and the next page is requested when focus is `PREFETCH_AHEAD` (6) cards from the end of
  a row, not at the last card, so it is usually there before you arrive. A page is appended 4 cards at a time, 40 ms apart
  (`appendCards`, with a per-list token so a rebuild stops stale chunks); the first render is inserted at once.
- **Covers.** Card art is requested at 300 px (`CARD_ART_SIZE`, was 600: four times the pixels to decode for a 300 px card on a 1080p
  screen) and loaded through a queue of 3 (`pumpArt`) so decoding is spread over frames. Appended cards do not animate in.
- **Between rows.** The row slide (`animateRow`, opacity + transform on a container holding every card) is gone, the screen's vertical
  scroll jumps and shadows are small (`0 6px 14px`).
- **Lite mode.** Evidence of a slow device (two page renders over 150 ms) calls `enableLite()`: it stores `subtizen.lite = on`, adds
  `body.lite` and turns off the art fades, entrance animations and the album flight (CSS `body.lite ...` plus checks in `openAlbum`,
  `leaveAlbum`). To bring the motion back: `localStorage.removeItem('subtizen.lite')` and reload.

### List scrolling

`focusNode` scrolls first and focuses second. A browser scrolls a container on focus only when the element is not already in view, so
putting it in view beforehand leaves nothing for the browser to do. (When the TV's browser scrolled after our code ran, a list went forward,
snapped back and went forward again.) The screen is pinned sideways (`scrollLeft = 0`), a row card gets its row scrolled by hand from its
index (`rowScrollFor`, using `ROW_PAD`), and every element gets `revealInScreen()`, which measures where it is and moves it only if it is
within 20 px of an edge. The same writes are asserted once more on the next tick, and `wantScroll` / `writeScroll` set a short-lived guard
that puts a container straight back if a scroll event shows the browser moved it elsewhere (scroll events arrive before paint). Moving
between rows in the album, playlist and artist lists goes straight to the neighbouring element (`neighbourRow`) instead of scanning every
row (an artist list can be hundreds long). In a hidden browser pane scroll events are not delivered, so the guard cannot be exercised
there; the scroll-first order is what the tests cover.
