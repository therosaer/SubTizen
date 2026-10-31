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

**Focus.** The focused card scales up 6% and its artwork gains a white ring plus a soft
shadow, which stays legible on the light background. Focused cards are scrolled into view,
since Tizen's WebKit does not do this reliably.

**Navigation animation.** Moving left/right plays a short lift-and-settle animation on the
newly focused card, and moving up/down slides the row being entered in from the direction of
travel. Both are CSS keyframes replayed from JS by removing the class, forcing a reflow, and
re-adding it, because the browser otherwise coalesces the change and the animation never
restarts. The animations are declared with both `-webkit-` and unprefixed properties, since
Tizen 2.4's WebKit only understands the prefixed forms.

## Artists

Every artist in the library, sorted A–Z. The list is built from `getArtists`, which returns
artists bucketed by index letter rather than in order, so the app re-sorts them itself:
case-insensitively by name, with punctuation-led names (`!Kung`) folded into a `#` bucket
that always sorts last so the list order matches the A–Z strip above it. The strip is one
button per letter actually present, and selecting one jumps to the first artist under it.
Enter on an artist loads their albums via `getArtist` and shows them as a card row; Enter on
a card opens the album, and Back returns to the artist rather than to Home.

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

The nav pill carries **Albums / Artists / Search / Now Playing**, all wired, plus a
**Dark** / **Light** theme toggle at the right. The circular avatar to its left shows the
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
  and is scaled 6% while focused, so geometry-based maths overshoots. Index arithmetic is
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
