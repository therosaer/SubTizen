# Changelog

## 1.1

### Added
- **AirPlay receiver.** Cast from an iPhone, iPad or Mac to the TV. A small Node service in [`bridge/`](bridge/README.md) (shairport-sync
  + ffmpeg) runs on another machine on the network and the app plays its stream through Samsung's AVPlay player, with artwork, title,
  artist and progress. A new **AirPlay** tab, a bridge address field (editable later from the username icon), and a mini-player that
  also shows a cast. Pause, resume and disconnect are handled; the delay is about 3-4 seconds.
- **Favorites.** A heart on Now Playing stars the track on your server; a Favorites row on Home lists them.
- **Up Next.** See what plays next (in shuffled order too) and jump to any track.
- **Shuffle and repeat** (off / all / one) on Now Playing, remembered across launches.
- **Scrobbling.** Plays from the TV count on your server (Top Picks, play counts); a track that fails to play is skipped.
- **Token authentication.** The password no longer travels in URLs (older servers fall back to the plain login automatically).
- **Connection settings.** The username icon reopens the connect form to change the server or the AirPlay bridge.
- **Motion.** Covers fade in, rows rise in, focus and row scrolling glide, a card's art flies into the album page and back, and the
  Now Playing lyrics glide while the cover shrinks on pause. On a slow TV these switch themselves off ("lite mode").
- **Player bar.** Slimmer, hidden until something plays or is cast, with messages as a short-lived toast instead of permanent text.

### Fixed
- The tab bar could not be walked from Search, Artists and some other screens; Artists had no way to reach it at all.
- Accented artist names (Á, Ñ, É, Ø ...) sorted under "#" instead of their letter.
- Home rows: Down from the tab bar did nothing when Recently Played was empty; empty rows are now hidden.
- Moving between Home rows put focus on the same column instead of where you were in that row.
- The Now Playing screen's Back key skipped the tab bar.
- Walking down long track or artist lists could scroll back and forth.
- A dozen smaller things (lyrics client identity, a dead duplicate comparator, misleading "stalled" message, ...).

### Changed
- Cover art is requested at 300 px and rows load 12 items at a time, starting a few cards before the end of a row.
- The README, `HANDOVER.md` and `bridge/README.md` describe all of the above.

### Notes
- The widget now needs the `http://developer.samsung.com/privilege/avplay` privilege (for the AirPlay player).
- A TV rejects an unsigned package (`install failed[118]`); sign it with a certificate that includes the TV's DUID.
- Tested on a 2016 Samsung TV (UE32K5502, Tizen 2.4) with an iPhone and Navidrome.

## 1.0.1
Initial public release: Subsonic client with Home, Artists, Playlists, Search and Now Playing, synced lyrics, dark mode.
