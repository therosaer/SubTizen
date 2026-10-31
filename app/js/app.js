/*
 * app.js - SubTizen.
 * Flow: connect -> browse album cards -> open album -> play track.
 *
 * The UI follows Apple Music on Apple TV: a pill nav bar, a grid of artwork
 * cards, and a persistent transport bar. Tizen 2.4's WebKit does not move
 * focus on arrow keys, so D-pad navigation is implemented here.
 */
(function (global) {
    'use strict';

    var STORAGE_KEY = 'subtizen.connection';
    var HISTORY_KEY = 'subtizen.history';
    /*
     * Cards render at 300 CSS px. Requesting 132 px (the old vertical-list
     * size) made the artwork visibly pixelated once the layout grew, so ask
     * for 2x to stay sharp on high-density panels.
     */
    var CARD_ART_SIZE = 600;

    /* Transport-bar art renders at 96 CSS px; request 2x for sharpness. */
    var NP_ART_SIZE = 192;

    var state = {
        client: null,
        albums: [],
        songs: [],
        currentIndex: -1,
        currentSong: null,
        seekerTimer: null,
        lastGrid: null,
        now: {
            lyrics: [],
            line: -1,
            seq: 0
        },
        search: {
            query: '',
            results: [],
            timer: null,
            seq: 0
        },
        artists: {
            items: [],
            letters: [],
            loaded: false,
            loading: false,
            seq: 0
        },
        playlists: {
            items: [],
            loaded: false,
            loading: false,
            seq: 0
        },
        /* Entries of the playlist currently open on the playlist screen. */
        playlistSongs: [],
        /* Albums of the artist currently open on the artist detail screen. */
        artistAlbums: [],
        /*
         * Where the album detail screen should return to. Opening an album
         * from the artist screen must come back to that artist, not to Home.
         */
        albumReturn: 'screen-albums'
    };

    var el = {};

    function $(id) {
        return document.getElementById(id);
    }

    function show(screenId) {
        var screens = document.querySelectorAll('.screen');
        var i;
        for (i = 0; i < screens.length; i++) {
            screens[i].className = screens[i].className.replace(/\s*active/, '');
        }
        $(screenId).className += ' active';

        /*
         * The Now Playing screen carries its own seeker and transport buttons,
         * so the persistent bar is hidden and the app area is stretched to the
         * bottom edge while it is up.
         */
        document.body.className = document.body.className
            .replace(/\s*now-active/, '') +
            (screenId === 'screen-now' ? ' now-active' : '');

        /*
         * The album tint is painted on `#backdrop` as well as the screen, so it
         * has to be taken back off when the screen is left — otherwise the
         * album colour would follow the user onto every other screen.
         */
        if (screenId !== 'screen-now') {
            applyNowTint(null);
        }

        /* The nav pill only makes sense once a server is connected. */
        el.nav.className = (screenId === 'screen-connect') ? 'hidden' : '';

        focusFirst();
    }

    function setStatus(message, isError) {
        el.status.innerHTML = message || '';
        el.status.className = 'status' + (isError ? ' error' : '');
    }

    function saveConnection(conn) {
        try {
            global.localStorage.setItem(STORAGE_KEY, JSON.stringify(conn));
        } catch (e) {
            /* localStorage may be unavailable; non-fatal */
        }
    }

    function loadConnection() {
        try {
            var raw = global.localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function formatDuration(seconds) {
        var m, s;
        seconds = parseInt(seconds, 10) || 0;
        m = Math.floor(seconds / 60);
        s = seconds % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function escapeHtml(text) {
        return String(text === undefined || text === null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /* ---------- Connect ---------- */

    function connect(url, user, pass) {
        var client = new Subsonic(url, user, pass);
        setStatus('Connecting to ' + url + ' ...', false);

        client.ping(function (response) {
            state.client = client;
            saveConnection({ url: url, user: user, pass: pass });
            setAvatar(user);
            setStatus('Connected to ' + (response.version || 'server') + '.', false);
            loadHome();
        }, function (err) {
            setStatus('Connection failed: ' + err.message, true);
        });
    }

    /*
     * The nav avatar shows the first letter of the signed-in username, the way
     * Apple Music shows the account initial.
     */
    function setAvatar(user) {
        var initial = (user || '').replace(/^\s+/, '').charAt(0);
        el.avatar.textContent = initial ? initial.toUpperCase() : '?';
    }

    /* ---------- Home sections ---------- */

    /*
     * The home screen is three independent card grids. A card therefore needs
     * to know both which grid it is in and its position, so cards carry
     * `data-list` alongside `data-index`; a bare index would be ambiguous
     * across the three lists.
     */
    /*
     * Each section pages independently. `offset` is how many items have been
     * fetched so far, `exhausted` marks a server that returned a short page,
     * and `loading` guards against firing two requests for the same page.
     */
    var SECTIONS = {
        recent: { list: 'recent-list', items: [], kind: 'album', offset: 0,
                  exhausted: false, loading: false, local: true },
        added: { list: 'added-list', items: [], kind: 'album', offset: 0,
                 exhausted: false, loading: false },
        top: { list: 'top-list', items: [], kind: 'song', offset: 0,
               exhausted: false, loading: false }
    };

    var SECTION_ORDER = ['recent', 'added', 'top'];

    /* How many items to request per page. */
    var PAGE_SIZE = 24;

    /*
     * Top Picks is ranked by playCount, which the server cannot sort by, so
     * the whole song pool is fetched once and ranked client-side. The pool is
     * capped because the response is parsed on a TV with limited memory.
     */
    var SONG_POOL_SIZE = 500;

    /*
     * How many albums the local listening history keeps. The row pages
     * through this list client-side, so it is the effective row length.
     */
    var HISTORY_LIMIT = 60;

    /*
     * Recently Played is the app's own listening history, not the server's.
     * `getAlbumList2?type=recent` is ordered by the server's `played` column,
     * which only moves when something scrobbles a play — and this app never
     * did, so the row stayed empty (or stale) no matter what was played on the
     * TV. The history is recorded here instead, in localStorage, so it
     * survives restarts and does not depend on the server's scrobble support.
     *
     * Entries are albums, most recent first, shaped like the albumList2 items
     * the row already renders: { id, name, artist, coverArt, played }.
     */
    function loadHistory() {
        var raw, list;
        try {
            raw = global.localStorage.getItem(HISTORY_KEY);
            list = raw ? JSON.parse(raw) : [];
        } catch (e) {
            return [];
        }
        return Object.prototype.toString.call(list) === '[object Array]' ? list : [];
    }

    function saveHistory(list) {
        try {
            global.localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
        } catch (e) {
            /* localStorage may be unavailable; non-fatal */
        }
    }

    /*
     * Record a play. The album is moved to the front rather than appended, so
     * replaying an album does not fill the row with duplicates.
     *
     * The key is the album id. `getAlbum` songs carry `parent` (the album) but
     * no `albumId`; `search3` songs carry `albumId` but no `parent`. Both are
     * the same album, so either is accepted and the entry is stored under the
     * album id the row can open.
     */
    function recordPlay(song) {
        var albumId = song && (song.albumId || song.parent);
        var list, entry, i;

        if (!albumId) {
            return;
        }
        list = loadHistory();
        for (i = 0; i < list.length; i++) {
            if (list[i].id === albumId) {
                entry = list[i];
                list.splice(i, 1);
                break;
            }
        }
        if (!entry) {
            entry = {
                id: albumId,
                name: song.album || '',
                artist: song.artist || '',
                coverArt: song.coverArt || ''
            };
        }
        entry.played = new Date().getTime();
        list.unshift(entry);
        if (list.length > HISTORY_LIMIT) {
            list.length = HISTORY_LIMIT;
        }
        saveHistory(list);
        refreshRecent();
    }

    /*
     * Rebuild the Recently Played row from the history. The row is paged
     * client-side, so a new play only has to re-render the first page; the
     * rest is picked up as the user scrolls right.
     */
    function refreshRecent() {
        var section = SECTIONS.recent;
        var history = loadHistory();
        var i, item, changed = false;

        if (history.length !== section.items.length) {
            changed = true;
        } else {
            for (i = 0; i < history.length; i++) {
                if (history[i].id !== section.items[i].id) {
                    changed = true;
                    break;
                }
            }
        }
        if (!changed) {
            return;
        }

        section.items = history;
        section.offset = Math.min(section.offset, history.length);
        section.exhausted = section.offset >= history.length;
        section.loading = false;

        /* Re-rendering drops focus, so put it back on the same album. */
        item = document.activeElement;
        if (item && item.getAttribute && item.getAttribute('data-list') === 'recent') {
            item = item.getAttribute('data-id');
        } else {
            item = null;
        }
        renderSection('recent', 0);
        if (item) {
            restoreRecentFocus(item);
        }
    }

    function restoreRecentFocus(albumId) {
        var cards = document.querySelectorAll(
            '.screen.active .card[data-list="recent"]'
        );
        var i;
        for (i = 0; i < cards.length; i++) {
            if (cards[i].getAttribute('data-id') === albumId) {
                focusNode(cards[i]);
                return;
            }
        }
    }

    function loadHome() {
        var pending = SECTION_ORDER.length;
        var failed = false;

        setStatus('Loading your library ...', false);

        function done() {
            pending--;
            if (pending === 0 && !failed) {
                setStatus('Library loaded.', false);
                show('screen-albums');
            }
        }

        function fail(err) {
            failed = true;
            setStatus('Could not load library: ' + err.message, true);
        }

        loadSection('recent', done, fail);
        loadSection('added', done, fail);
        loadSection('top', done, fail);
    }

    /* Fetch the next page of one section and append it to the row. */
    function loadSection(key, onDone, onFail) {
        var section = SECTIONS[key];

        if (section.loading || section.exhausted) {
            if (onDone) {
                onDone();
            }
            return;
        }
        section.loading = true;

        function receive(items) {
            var from = section.items.length;
            section.loading = false;
            if (items.length < PAGE_SIZE) {
                section.exhausted = true;
            }
            section.offset += items.length;
            section.items = section.items.concat(items);
            renderSection(key, from);
            if (onDone) {
                onDone();
            }
        }

        function fail(err) {
            section.loading = false;
            if (onFail) {
                onFail(err);
            }
        }

        /*
         * Recently Played is the local history, so paging it means slicing
         * the stored list rather than asking the server for another page.
         */
        if (section.local) {
            receive(loadHistory().slice(section.offset,
                section.offset + PAGE_SIZE));
            return;
        }

        if (key === 'top') {
            /*
             * The pool is fetched in one shot and ranked, so paging it means
             * slicing the ranked list rather than asking for another page.
             */
            if (section.pool) {
                receive(section.pool.slice(section.offset,
                    section.offset + PAGE_SIZE));
                return;
            }
            state.client.getSongPool(SONG_POOL_SIZE, 0, function (response) {
                var songs = (response.searchResult3 &&
                    response.searchResult3.song) || [];
                songs.sort(function (a, b) {
                    return (b.playCount || 0) - (a.playCount || 0);
                });
                section.pool = songs;
                receive(songs.slice(0, PAGE_SIZE));
            }, fail);
            return;
        }

        state.client.getAlbumList('newest',
            PAGE_SIZE, section.offset, function (response) {
                receive((response.albumList2 && response.albumList2.album) || []);
            }, fail);
    }

    /*
     * Called when focus reaches the end of a row, so scrolling right keeps
     * pulling more items instead of stopping at the first page.
     */
    function loadMore(key) {
        var section = SECTIONS[key];
        if (!section || section.loading || section.exhausted) {
            return;
        }
        loadSection(key, null, function (err) {
            setStatus('Could not load more: ' + err.message, true);
        });
    }

    /*
     * Render a section's cards. `from` lets a page append only its new items
     * instead of rebuilding the whole row, which would drop focus and re-fetch
     * every cover image.
     */
    function renderSection(key, from) {
        var section = SECTIONS[key];
        var items = section.items;
        var listEl = $(section.list);
        var html = [];
        var i, item, art, title, sub;

        if (!items.length) {
            listEl.innerHTML = '<li class="empty">Nothing here yet.</li>';
            return;
        }

        if (typeof from !== 'number') {
            from = 0;
        }
        /*
         * A rebuild (from 0) replaces the row; a page append keeps it. The
         * distinction matters because `insertAdjacentHTML` below only ever
         * adds, so a rebuild that did not clear first would duplicate every
         * card already on screen.
         */
        if (from === 0) {
            listEl.innerHTML = '';
        }

        for (i = from; i < items.length; i++) {
            item = items[i];
            art = item.coverArt ?
                '<span class="art" style="background-image:url(\'' +
                    escapeHtml(state.client.coverArtUrl(item.coverArt, CARD_ART_SIZE)) +
                    '\')"></span>' :
                '<span class="art-fallback">&#9835;</span>';

            if (section.kind === 'song') {
                title = item.title;
                sub = item.artist;
            } else {
                title = item.name;
                sub = item.artist;
            }

            html.push(
                '<li class="card" data-list="' + key + '" data-index="' + i + '"' +
                    ' data-kind="' + section.kind + '"' +
                    ' data-id="' + escapeHtml(item.id || '') + '"' +
                    ' data-title="' + escapeHtml(title) + '" tabindex="0">' +
                    art +
                    '<span class="body">' +
                        '<span class="card-title">' + escapeHtml(title) + '</span>' +
                        '<span class="card-sub">' + escapeHtml(sub) + '</span>' +
                    '</span>' +
                '</li>'
            );
        }
        /*
         * Append with insertAdjacentHTML rather than `innerHTML +=`, which
         * re-parses the whole list and destroys the focused card, dropping
         * focus to <body> and breaking D-pad navigation mid-row.
         */
        listEl.insertAdjacentHTML('beforeend', html.join(''));
    }

    /* ---------- Album detail ---------- */

    function openAlbum(album, returnTo) {
        if (!album) {
            return;
        }
        state.albumReturn = returnTo || 'screen-albums';
        setStatus('Loading ' + album.name + ' ...', false);

        state.client.getAlbum(album.id, function (response) {
            var songs = (response.album && response.album.song) || [];
            state.songs = songs;
            state.currentIndex = -1;
            el.albumTitle.innerHTML = escapeHtml(album.name);
            el.albumArtist.innerHTML = escapeHtml(album.artist);
            renderSongs(songs);
            setStatus(songs.length + ' track(s).', false);
            show('screen-album');
        }, function (err) {
            setStatus('Could not load album: ' + err.message, true);
        });
    }

    /*
     * A card in "Top Picks" is a song, not an album, so activating it plays
     * that song directly. Playing a song outside an album context still needs
     * a track list for prev/next, so the song's own album is loaded first and
     * the matching track is selected within it.
     */
    function openSong(song) {
        /*
         * `getAlbum` songs carry `parent` (the album id); `search3` songs —
         * which is what Top Picks is built from — carry `albumId` instead.
         * Accepting only `parent` made every Top Picks play fail with "no
         * album to open", so those plays never reached the history.
         */
        var albumId = song && (song.parent || song.albumId);
        if (!albumId) {
            setStatus('This song has no album to open.', true);
            return;
        }
        setStatus('Loading ' + song.title + ' ...', false);

        state.client.getAlbum(albumId, function (response) {
            var songs = (response.album && response.album.song) || [];
            var i;
            state.songs = songs;
            state.currentIndex = -1;
            el.albumTitle.innerHTML = escapeHtml(response.album.name || '');
            el.albumArtist.innerHTML = escapeHtml(response.album.artist || '');
            renderSongs(songs);
            show('screen-album');

            for (i = 0; i < songs.length; i++) {
                if (songs[i].id === song.id) {
                    playIndex(i);
                    return;
                }
            }
            /*
             * The track is not in the album listing (the pool and the album
             * can disagree). Play it from the pool's own copy so the history
             * still gets the album id, which only the pool song carries.
             */
            state.songs = [song];
            playIndex(0);
        }, function (err) {
            setStatus('Could not load album: ' + err.message, true);
        });
    }

    function renderSongs(songs) {
        var html = [];
        var i, song;

        if (!songs.length) {
            el.songList.innerHTML = '<li class="empty">No tracks in this album.</li>';
            return;
        }

        for (i = 0; i < songs.length; i++) {
            song = songs[i];
            html.push(
                '<li class="track" data-index="' + i + '"' +
                    ' data-id="' + escapeHtml(song.id || '') + '"' +
                    ' data-title="' + escapeHtml(song.title) + '" tabindex="0">' +
                    '<span class="track-num">' + (song.track || (i + 1)) + '</span>' +
                    '<span class="track-title">' + escapeHtml(song.title) + '</span>' +
                    '<span class="track-dur">' + formatDuration(song.duration) + '</span>' +
                '</li>'
            );
        }
        el.songList.innerHTML = html.join('');
    }

    /* ---------- Artists ---------- */

    /*
     * The Artists tab lists every artist in the library A-Z. Subsonic's
     * getArtists returns them already bucketed by index letter, but the
     * buckets are not guaranteed to be sorted and some servers fold
     * punctuation and accented names into "#", so the list is flattened and
     * re-sorted here with a locale-aware comparison.
     */
    function artistSortKey(name) {
        return String(name || '').replace(/^\s+/, '').toLowerCase();
    }

    function compareArtists(a, b) {
        var ka = artistSortKey(a.name);
        var kb = artistSortKey(b.name);
        if (ka < kb) {
            return -1;
        }
        if (ka > kb) {
            return 1;
        }
        return 0;
    }

    /*
     * The index letter shown next to an artist and used for the A-Z strip.
     * Anything that does not start with a letter or digit is grouped under
     * "#", matching the convention Subsonic clients use.
     */
    function artistLetter(name) {
        var ch = String(name || '').replace(/^\s+/, '').charAt(0).toUpperCase();
        return /[A-Z0-9]/.test(ch) ? ch : '#';
    }

    /*
     * Sort by index bucket first, then by name. Sorting on the raw name alone
     * would put punctuation-led names ("!Kung") before the digits, while the
     * A-Z strip groups them under "#" at the end — the list and the strip
     * would then disagree about where those artists live.
     */
    function compareArtists(a, b) {
        var la = artistLetter(a.name);
        var lb = artistLetter(b.name);
        var ka, kb;

        if (la !== lb) {
            /* "#" is the catch-all bucket and always sorts last. */
            if (la === '#') {
                return 1;
            }
            if (lb === '#') {
                return -1;
            }
            return la < lb ? -1 : 1;
        }
        ka = artistSortKey(a.name);
        kb = artistSortKey(b.name);
        if (ka < kb) {
            return -1;
        }
        if (ka > kb) {
            return 1;
        }
        return 0;
    }

    function loadArtists() {
        var seq;

        if (!state.client) {
            return;
        }
        if (state.artists.loaded || state.artists.loading) {
            renderArtists();
            return;
        }
        state.artists.loading = true;
        seq = ++state.artists.seq;
        setStatus('Loading artists ...', false);

        state.client.getArtists(function (response) {
            var buckets = (response.artists && response.artists.index) || [];
            var items = [];
            var i, j, bucket, list;

            if (seq !== state.artists.seq) {
                return;
            }
            for (i = 0; i < buckets.length; i++) {
                bucket = buckets[i];
                list = (bucket && bucket.artist) || [];
                for (j = 0; j < list.length; j++) {
                    items.push(list[j]);
                }
            }
            items.sort(compareArtists);
            state.artists.items = items;
            state.artists.loaded = true;
            state.artists.loading = false;
            renderArtists();
            setStatus(items.length + ' artist(s).', false);
        }, function (err) {
            if (seq !== state.artists.seq) {
                return;
            }
            state.artists.loading = false;
            setStatus('Could not load artists: ' + err.message, true);
        });
    }

    /*
     * The A-Z strip is built from the letters actually present, so it never
     * offers a jump to a letter with no artists behind it.
     */
    function renderArtistIndex() {
        var letters = state.artists.letters;
        var html = [];
        var i;

        if (!letters.length) {
            el.artistIndex.innerHTML = '';
            return;
        }
        for (i = 0; i < letters.length; i++) {
            html.push('<button class="index-letter" data-letter="' +
                escapeHtml(letters[i]) + '" tabindex="0">' +
                escapeHtml(letters[i]) + '</button>');
        }
        el.artistIndex.innerHTML = html.join('');
    }

    function renderArtists() {
        var items = state.artists.items;
        var html = [];
        var letters = [];
        var i, item, letter, art;

        if (!items.length) {
            state.artists.letters = [];
            renderArtistIndex();
            el.artistList.innerHTML =
                '<li class="empty">No artists in this library.</li>';
            return;
        }

        for (i = 0; i < items.length; i++) {
            item = items[i];
            letter = artistLetter(item.name);
            if (letters[letters.length - 1] !== letter) {
                letters.push(letter);
            }
            art = item.coverArt ?
                '<span class="artist-art" style="background-image:url(\'' +
                    escapeHtml(state.client.coverArtUrl(item.coverArt, 144)) +
                    '\')"></span>' :
                '<span class="artist-art empty"></span>';

            html.push(
                '<li class="artist" data-index="' + i + '"' +
                    ' data-letter="' + escapeHtml(letter) + '"' +
                    ' data-id="' + escapeHtml(item.id || '') + '"' +
                    ' data-name="' + escapeHtml(item.name) + '" tabindex="0">' +
                    art +
                    '<span class="artist-text">' +
                        '<span class="artist-name">' + escapeHtml(item.name) + '</span>' +
                        '<span class="artist-sub">' +
                            escapeHtml(item.albumCount || 0) + ' album(s)' +
                        '</span>' +
                    '</span>' +
                    '<span class="artist-letter">' + escapeHtml(letter) + '</span>' +
                '</li>'
            );
        }
        state.artists.letters = letters;
        renderArtistIndex();
        el.artistList.innerHTML = html.join('');
    }

    /* Jump the list to the first artist under a letter. */
    function jumpToLetter(letter) {
        var rows = el.artistList.querySelectorAll('.artist');
        var i;
        for (i = 0; i < rows.length; i++) {
            if (rows[i].getAttribute('data-letter') === letter) {
                focusNode(rows[i]);
                return;
            }
        }
    }

    /*
     * Opening an artist loads their albums and shows them as cards, reusing
     * the album grid so Enter on a card opens the album as it does on Home.
     */
    function openArtist(artist) {
        if (!artist) {
            return;
        }
        setStatus('Loading ' + artist.name + ' ...', false);

        state.client.getArtist(artist.id, function (response) {
            var albums = (response.artist && response.artist.album) || [];
            var i;

            state.artistAlbums = albums;
            el.artistTitle.innerHTML = escapeHtml(artist.name);
            el.artistCount.innerHTML = albums.length + ' album(s)';

            if (!albums.length) {
                el.artistAlbums.innerHTML =
                    '<li class="empty">No albums for this artist.</li>';
            } else {
                var html = [];
                for (i = 0; i < albums.length; i++) {
                    html.push(
                        '<li class="card" data-list="artist" data-index="' + i + '"' +
                            ' data-kind="album"' +
                            ' data-id="' + escapeHtml(albums[i].id || '') + '"' +
                            ' data-title="' + escapeHtml(albums[i].name) + '"' +
                            ' tabindex="0">' +
                            (albums[i].coverArt ?
                                '<span class="art" style="background-image:url(\'' +
                                    escapeHtml(state.client.coverArtUrl(
                                        albums[i].coverArt, CARD_ART_SIZE)) +
                                    '\')"></span>' :
                                '<span class="art-fallback">&#9835;</span>') +
                            '<span class="body">' +
                                '<span class="card-title">' +
                                    escapeHtml(albums[i].name) + '</span>' +
                                '<span class="card-sub">' +
                                    escapeHtml(albums[i].year || '') + '</span>' +
                            '</span>' +
                        '</li>'
                    );
                }
                el.artistAlbums.innerHTML = html.join('');
            }
            setStatus(albums.length + ' album(s) by ' + artist.name + '.', false);
            show('screen-artist');
        }, function (err) {
            setStatus('Could not load artist: ' + err.message, true);
        });
    }

    function activateArtist(node) {
        var index = indexOfNode(node);
        var artist = state.artists.items[index];
        if (artist) {
            openArtist(artist);
        }
    }

    /* ---------- Playlists ---------- */

    /*
     * Playlists come straight from the server via getPlaylists, so they are
     * whatever the user has on Navidrome/Airsonic/Subsonic — the app keeps no
     * local copy and no local edits. The list is not paged: Subsonic has no
     * offset for it, so the whole set arrives at once and is rendered as a
     * vertical list, the same shape as the artist list.
     */
    function loadPlaylists() {
        var seq;

        if (!state.client) {
            return;
        }
        if (state.playlists.loaded || state.playlists.loading) {
            renderPlaylists();
            if ($('screen-playlists').className.indexOf('active') >= 0) {
                focusFirst();
            }
            return;
        }
        state.playlists.loading = true;
        seq = ++state.playlists.seq;
        setStatus('Loading playlists ...', false);

        state.client.getPlaylists(function (response) {
            var items = (response.playlists && response.playlists.playlist) || [];

            if (seq !== state.playlists.seq) {
                return;
            }
            state.playlists.items = items;
            state.playlists.loaded = true;
            state.playlists.loading = false;
            renderPlaylists();
            /*
             * `show()` ran before the rows existed, so its focusFirst() had
             * nothing to land on. Put the D-pad on the first playlist now.
             */
            if ($('screen-playlists').className.indexOf('active') >= 0) {
                focusFirst();
            }
            setStatus(items.length + ' playlist(s).', false);
        }, function (err) {
            if (seq !== state.playlists.seq) {
                return;
            }
            state.playlists.loading = false;
            setStatus('Could not load playlists: ' + err.message, true);
        });
    }

    function renderPlaylists() {
        var items = state.playlists.items;
        var html = [];
        var i, item, art, count;

        if (!items.length) {
            el.playlistList.innerHTML =
                '<li class="empty">No playlists on this server.</li>';
            return;
        }

        for (i = 0; i < items.length; i++) {
            item = items[i];
            count = parseInt(item.songCount, 10) || 0;
            art = item.coverArt ?
                '<span class="playlist-art" style="background-image:url(\'' +
                    escapeHtml(state.client.coverArtUrl(item.coverArt, 144)) +
                    '\')"></span>' :
                '<span class="playlist-art empty"></span>';

            html.push(
                '<li class="playlist" data-index="' + i + '"' +
                    ' data-id="' + escapeHtml(item.id || '') + '"' +
                    ' data-name="' + escapeHtml(item.name) + '" tabindex="0">' +
                    art +
                    '<span class="playlist-text">' +
                        '<span class="playlist-name">' +
                            escapeHtml(item.name) + '</span>' +
                        '<span class="playlist-sub">' +
                            escapeHtml(item.owner || 'Playlist') + '</span>' +
                    '</span>' +
                    '<span class="playlist-count">' +
                        count + (count === 1 ? ' song' : ' songs') +
                    '</span>' +
                '</li>'
            );
        }
        el.playlistList.innerHTML = html.join('');
    }

    /*
     * Servers disagree on the shape of getPlaylist: most return
     * `playlist.entry[]`, but some older ones return a bare `playlist` array
     * of songs. Both are normalised to a plain song array here.
     */
    function playlistEntries(response) {
        var playlist = response && response.playlist;
        if (!playlist) {
            return [];
        }
        if (Object.prototype.toString.call(playlist) === '[object Array]') {
            return playlist;
        }
        return playlist.entry || [];
    }

    /*
     * Opening a playlist loads its entries and shows them as a track list.
     * The entries are played through the same `state.songs` / `playIndex()`
     * path as an album, so prev/next, the seeker, and the number-pad track
     * jump all work unchanged.
     */
    function openPlaylist(playlist) {
        if (!playlist) {
            return;
        }
        setStatus('Loading ' + playlist.name + ' ...', false);

        state.client.getPlaylist(playlist.id, function (response) {
            var songs = playlistEntries(response);

            state.playlistSongs = songs;
            state.songs = songs;
            state.currentIndex = -1;
            el.playlistTitle.innerHTML = escapeHtml(playlist.name);
            el.playlistCount.innerHTML = songs.length + ' song(s)';
            renderPlaylistSongs(songs);
            setStatus(songs.length + ' song(s) in ' + playlist.name + '.', false);
            show('screen-playlist');
            /* show() focused before the tracks were rendered; redo it now. */
            focusFirst();
        }, function (err) {
            setStatus('Could not load playlist: ' + err.message, true);
        });
    }

    function renderPlaylistSongs(songs) {
        var html = [];
        var i, song;

        if (!songs.length) {
            el.playlistSongs.innerHTML =
                '<li class="empty">This playlist is empty.</li>';
            return;
        }

        for (i = 0; i < songs.length; i++) {
            song = songs[i];
            html.push(
                '<li class="track" data-index="' + i + '"' +
                    ' data-id="' + escapeHtml(song.id || '') + '"' +
                    ' data-title="' + escapeHtml(song.title) + '" tabindex="0">' +
                    '<span class="track-num">' + (i + 1) + '</span>' +
                    '<span class="track-title">' + escapeHtml(song.title) +
                        '<span class="track-artist">' +
                            escapeHtml(song.artist || '') + '</span>' +
                    '</span>' +
                    '<span class="track-dur">' +
                        formatDuration(song.duration) + '</span>' +
                '</li>'
            );
        }
        el.playlistSongs.innerHTML = html.join('');
    }

    function activatePlaylist(node) {
        var index = indexOfNode(node);
        var playlist = state.playlists.items[index];
        if (playlist) {
            openPlaylist(playlist);
        }
    }

    /* ---------- Search ---------- */

    /*
     * A TV remote has no keyboard, so the query is typed on an on-screen
     * keyboard driven by the D-pad. The query lives in a read-only field
     * rather than an <input>: focusing a real input would raise the TV's own
     * IME over the results, and the number keys would be swallowed by the
     * login-form guard in bindNumberKeys().
     */
    var SEARCH_DEBOUNCE_MS = 350;

    /*
     * The keyboard is laid out as rows of keys. `w` is the key width in
     * multiples of the base key, so the wide keys line up with the grid.
     */
    var KEYBOARD_ROWS = [
        ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
        ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
        ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '-'],
        ['z', 'x', 'c', 'v', 'b', 'n', 'm', '.', '\'', '&'],
        [
            { label: 'Space', action: 'space', w: 3 },
            { label: 'Delete', action: 'back', w: 2 },
            { label: 'Clear', action: 'clear', w: 2 },
            { label: 'Search', action: 'go', w: 3 }
        ]
    ];

    function renderKeyboard() {
        var html = [];
        var i, j, key, label, action, cls;

        /*
         * Each row gets its own block container. Relying on the keys to wrap
         * at the container width does not work: the row length is not a
         * divisor of the width, so an extra key from the next row fits on the
         * line and every row after the first shifts by one.
         */
        for (i = 0; i < KEYBOARD_ROWS.length; i++) {
            html.push('<div class="key-row">');
            for (j = 0; j < KEYBOARD_ROWS[i].length; j++) {
                key = KEYBOARD_ROWS[i][j];
                if (typeof key === 'string') {
                    label = key;
                    action = 'char';
                    cls = 'key';
                } else {
                    label = key.label;
                    action = key.action;
                    cls = 'key' + (key.w === 3 ? ' wider' : (key.w === 2 ? ' wide' : ''));
                }
                html.push(
                    '<button class="' + cls + '" data-key="' + escapeHtml(label) + '"' +
                        ' data-action="' + action + '" tabindex="0">' +
                        escapeHtml(label) +
                    '</button>'
                );
            }
            html.push('</div>');
        }
        el.keyboard.innerHTML = html.join('');
    }

    function renderQuery() {
        el.searchQuery.innerHTML = escapeHtml(state.search.query);
    }

    /*
     * Results are a flat vertical list of albums and songs. Albums come first
     * because opening one is the more useful action on a TV, and a song result
     * plays directly.
     */
    function renderResults() {
        var results = state.search.results;
        var html = [];
        var i, item, art, title, sub, kind;

        if (!state.search.query) {
            el.searchResults.innerHTML =
                '<li class="empty">Type a search above, then press Search.</li>';
            return;
        }
        if (!results.length) {
            el.searchResults.innerHTML =
                '<li class="empty">No matches for &ldquo;' +
                escapeHtml(state.search.query) + '&rdquo;.</li>';
            return;
        }

        for (i = 0; i < results.length; i++) {
            item = results[i];
            if (item.kind === 'album') {
                title = item.data.name;
                sub = item.data.artist;
                kind = 'Album';
            } else {
                title = item.data.title;
                sub = item.data.artist +
                    (item.data.album ? ' \u2014 ' + item.data.album : '');
                kind = 'Song';
            }
            art = item.data.coverArt ?
                '<span class="result-art" style="background-image:url(\'' +
                    escapeHtml(state.client.coverArtUrl(item.data.coverArt, 144)) +
                    '\')"></span>' :
                '<span class="result-art empty"></span>';

            html.push(
                '<li class="result" data-index="' + i + '"' +
                    ' data-kind="' + item.kind + '" tabindex="0">' +
                    art +
                    '<span class="result-text">' +
                        '<span class="result-title">' + escapeHtml(title) + '</span>' +
                        '<span class="result-sub">' + escapeHtml(sub) + '</span>' +
                    '</span>' +
                    '<span class="result-kind">' + kind + '</span>' +
                '</li>'
            );
        }
        el.searchResults.innerHTML = html.join('');
    }

    function runSearch() {
        var query = state.search.query;
        var seq;

        if (!state.client || !query) {
            state.search.results = [];
            renderResults();
            return;
        }

        /*
         * Responses can arrive out of order when the user keeps typing, so
         * each request carries a sequence number and a stale reply is dropped
         * rather than overwriting newer results.
         */
        state.search.seq++;
        seq = state.search.seq;
        setStatus('Searching for \u201c' + query + '\u201d ...', false);

        state.client.search3(query, function (response) {
            var result = response.searchResult3 || {};
            var albums = result.album || [];
            var songs = result.song || [];
            var items = [];
            var i;

            if (seq !== state.search.seq) {
                return;
            }
            for (i = 0; i < albums.length; i++) {
                items.push({ kind: 'album', data: albums[i] });
            }
            for (i = 0; i < songs.length; i++) {
                items.push({ kind: 'song', data: songs[i] });
            }
            state.search.results = items;
            renderResults();
            setStatus(items.length + ' result(s) for \u201c' + query + '\u201d.', false);
        }, function (err) {
            if (seq !== state.search.seq) {
                return;
            }
            state.search.results = [];
            renderResults();
            setStatus('Search failed: ' + err.message, true);
        });
    }

    /* Coalesce keystrokes so a fast typist does not fire a request per letter. */
    function scheduleSearch() {
        if (state.search.timer) {
            clearTimeout(state.search.timer);
        }
        state.search.timer = setTimeout(function () {
            state.search.timer = null;
            runSearch();
        }, SEARCH_DEBOUNCE_MS);
    }

    function searchKey(key) {
        var action = key.getAttribute('data-action');
        var label = key.getAttribute('data-key');

        if (action === 'char') {
            if (state.search.query.length >= 60) {
                return;
            }
            state.search.query += label;
        } else if (action === 'space') {
            state.search.query += ' ';
        } else if (action === 'back') {
            state.search.query = state.search.query.slice(0, -1);
        } else if (action === 'clear') {
            state.search.query = '';
        } else if (action === 'go') {
            if (state.search.timer) {
                clearTimeout(state.search.timer);
                state.search.timer = null;
            }
            runSearch();
            return;
        }
        renderQuery();
        scheduleSearch();
    }

    function openSearch() {
        renderQuery();
        renderResults();
        if (state.search.query) {
            runSearch();
        }
    }

    function activateResult(node) {
        var index = indexOfNode(node);
        var item = state.search.results[index];
        if (!item) {
            return;
        }
        if (item.kind === 'album') {
            openAlbum(item.data);
        } else {
            openSong(item.data);
        }
    }

    /* ---------- Now Playing ---------- */

    /*
     * The Now Playing tab is a full-size stage: the album art on the left and
     * the lyrics the server returns for the track on the right, with the
     * backdrop tinted from the artwork. The seeker and transport buttons sit
     * on the screen itself, so the persistent bar is hidden while it is up.
     */
    var NP_ART_LARGE = 1040;

    /* How many lyric lines to show around the current one. */
    var NP_LYRIC_WINDOW = 3;

    /*
     * The backdrop is sampled from the cover art rather than hardcoded, so the
     * screen takes on the album's own colours. The art is fetched through an
     * <img> and drawn to a small canvas; a cross-origin image would taint the
     * canvas and make getImageData() throw, in which case the CSS fallback
     * gradient stays in place.
     */
    var NP_TINT_SIZE = 24;
    var npTintSeq = 0;

    function rgbToHsl(r, g, b) {
        var max = Math.max(r, g, b);
        var min = Math.min(r, g, b);
        var h = 0;
        var s = 0;
        var l = (max + min) / 2;
        var d = max - min;

        if (d) {
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) {
                h = (g - b) / d + (g < b ? 6 : 0);
            } else if (max === g) {
                h = (b - r) / d + 2;
            } else {
                h = (r - g) / d + 4;
            }
            h /= 6;
        }
        return { h: h, s: s, l: l };
    }

    function hslCss(h, s, l) {
        return 'hsl(' + Math.round(h * 360) + ',' +
            Math.round(s * 100) + '%,' + Math.round(l * 100) + '%)';
    }

    /*
     * Average the artwork's pixels, then push the result into a range that
     * works as a backdrop: a near-grey cover would otherwise produce a flat
     * grey screen, and a very bright one would wash out the white lyrics.
     */
    function tintFromImage(img) {
        var canvas = document.createElement('canvas');
        var ctx, data, i, r = 0, g = 0, b = 0, n = 0, hsl;

        canvas.width = NP_TINT_SIZE;
        canvas.height = NP_TINT_SIZE;
        ctx = canvas.getContext('2d');
        if (!ctx) {
            return null;
        }
        ctx.drawImage(img, 0, 0, NP_TINT_SIZE, NP_TINT_SIZE);
        try {
            data = ctx.getImageData(0, 0, NP_TINT_SIZE, NP_TINT_SIZE).data;
        } catch (e) {
            return null;
        }
        for (i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 128) {
                continue;
            }
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            n++;
        }
        if (!n) {
            return null;
        }
        hsl = rgbToHsl(r / n / 255, g / n / 255, b / n / 255);
        if (hsl.s < 0.18) {
            hsl.s = 0.18;
        }
        return {
            top: hslCss(hsl.h, Math.min(hsl.s, 0.75), 0.26),
            mid: hslCss(hsl.h, Math.min(hsl.s, 0.7), 0.16),
            bottom: hslCss(hsl.h, Math.min(hsl.s, 0.65), 0.09)
        };
    }

    function applyNowTint(tint) {
        var screen = $('screen-now');
        var backdrop = $('backdrop');
        var css;

        if (!tint) {
            screen.style.background = '';
            backdrop.style.background = '';
            return;
        }
        css = 'linear-gradient(to bottom right, ' +
            tint.top + ' 0%, ' + tint.mid + ' 55%, ' + tint.bottom + ' 100%)';
        screen.style.background = css;
        /*
         * The nav bar sits above `#app` and is not part of the screen, so the
         * tint is painted on the backdrop as well. Otherwise the album colour
         * stops at the top of the app area and the bar reads as a black band
         * across it.
         */
        backdrop.style.background = css;
    }

    function tintNowPlaying(song) {
        var seq = ++npTintSeq;
        var img;

        if (!song || !song.coverArt || !state.client) {
            applyNowTint(null);
            return;
        }
        img = new Image();
        img.onload = function () {
            if (seq !== npTintSeq) {
                return;
            }
            applyNowTint(tintFromImage(img));
        };
        img.onerror = function () {
            if (seq === npTintSeq) {
                applyNowTint(null);
            }
        };
        img.src = state.client.coverArtUrl(song.coverArt, 96);
    }

    function renderNowPlaying() {
        var song = state.currentSong;

        if (!song) {
            el.npCover.className = 'np-cover empty';
            el.npCover.style.backgroundImage = '';
            el.npTitle.innerHTML = '';
            el.npArtist.innerHTML = '';
            el.npAlbum.innerHTML = '';
            el.npLyrics.innerHTML = '<p class="np-line current">Nothing playing</p>';
            tintNowPlaying(null);
            return;
        }

        el.npTitle.innerHTML = escapeHtml(song.title);
        el.npArtist.innerHTML = escapeHtml(song.artist);
        el.npAlbum.innerHTML = escapeHtml(song.album);

        if (song.coverArt) {
            el.npCover.className = 'np-cover';
            el.npCover.style.backgroundImage = 'url(\'' +
                state.client.coverArtUrl(song.coverArt, NP_ART_LARGE) + '\')';
        } else {
            el.npCover.className = 'np-cover empty';
            el.npCover.style.backgroundImage = '';
        }
        tintNowPlaying(song);
        renderLyrics();
    }

    /*
     * Lyrics are plain text from the server, one line per row. The current
     * line is highlighted and the window is kept short so the block never
     * grows past the stage.
     */
    function renderLyrics() {
        var lines = state.now.lyrics;
        var current = state.now.line;
        var html = [];
        var from, to, i;

        if (!lines.length) {
            el.npLyrics.innerHTML = '<p class="np-line current">' +
                escapeHtml(state.currentSong ? state.currentSong.title : '') +
                '</p>';
            return;
        }

        /*
         * The window is anchored on the current line so the highlight sits in
         * the middle of the block and the surrounding lines scroll past it.
         */
        from = Math.max(0, current - 1);
        to = Math.min(lines.length, from + NP_LYRIC_WINDOW);
        from = Math.max(0, to - NP_LYRIC_WINDOW);

        for (i = from; i < to; i++) {
            html.push('<p class="np-line' +
                (i === current ? ' current' : (i < current ? ' past' : '')) +
                '">' + escapeHtml(lines[i].text) + '</p>');
        }
        el.npLyrics.innerHTML = html.join('');
    }

    /*
     * Some servers prefix lines with an LRC-style timestamp (`[01:23.45]`).
     * When every line carries one the timings are used directly; otherwise the
     * lines are spread evenly across the track, which keeps the highlight
     * moving with playback instead of pinning the first line for the whole
     * song.
     */
    var LRC_TIME = /^\s*\[(\d+):(\d+(?:[.,]\d+)?)\]\s*/;

    function parseLyricLines(text) {
        var raw = text.replace(/\r\n/g, '\n').split('\n');
        var lines = [];
        var timed = 0;
        var i, match, seconds;

        for (i = 0; i < raw.length; i++) {
            match = LRC_TIME.exec(raw[i]);
            if (match) {
                seconds = (parseInt(match[1], 10) * 60) +
                    parseFloat(match[2].replace(',', '.'));
                lines.push({ text: raw[i].replace(LRC_TIME, ''), time: seconds });
                timed++;
            } else if (raw[i].replace(/\s+/g, '')) {
                lines.push({ text: raw[i], time: -1 });
            }
        }

        /*
         * A partial set of timestamps is worse than none — the untimed lines
         * would all collapse onto the start of the track — so only trust the
         * timings when every line has one.
         */
        if (timed !== lines.length) {
            for (i = 0; i < lines.length; i++) {
                lines[i].time = -1;
            }
        }
        return lines;
    }

    function updateLyricLine() {
        var lines = state.now.lyrics;
        var duration = seekerDuration();
        var now = el.audio.currentTime;
        var line, i;

        if (!lines.length || duration <= 0) {
            return;
        }

        if (lines[0].time >= 0) {
            line = 0;
            for (i = 0; i < lines.length; i++) {
                if (lines[i].time <= now) {
                    line = i;
                } else {
                    break;
                }
            }
        } else {
            line = Math.floor((now / duration) * lines.length);
        }

        if (line >= lines.length) {
            line = lines.length - 1;
        }
        if (line < 0) {
            line = 0;
        }
        if (line !== state.now.line) {
            state.now.line = line;
            renderLyrics();
        }
    }

    function loadLyrics(song) {
        var seq = ++state.now.seq;

        state.now.lyrics = [];
        state.now.line = 0;
        renderLyrics();

        if (!song || !global.Lyrics) {
            return;
        }
        global.Lyrics.fetch(song, function (text) {
            var lines = [];

            if (seq !== state.now.seq) {
                return;
            }
            if (typeof text === 'string') {
                lines = parseLyricLines(text);
            }
            state.now.lyrics = lines;
            state.now.line = 0;
            renderLyrics();
            updateLyricLine();
        }, function () {
            /* Lyrics are optional; the title stands in for them. */
            if (seq === state.now.seq) {
                state.now.lyrics = [];
                renderLyrics();
            }
        });
    }

    function updateNowSeeker() {
        updateLyricLine();
    }

    /* ---------- Playback ---------- */
    function playIndex(index) {
        var song = state.songs[index];
        var rows, i;
        if (!song) {
            return;
        }

        state.currentIndex = index;
        state.currentSong = song;
        el.audio.src = state.client.streamUrl(song.id);
        el.audio.play();

        /* Feed the Recently Played row. */
        recordPlay(song);

        el.nowPlaying.innerHTML = escapeHtml(song.title) +
            '<span class="np-artist">' + escapeHtml(song.artist) + '</span>';

        /* Album art in the transport bar, matching the track being played. */
        if (song.coverArt) {
            el.npArt.className = 'np-art';
            el.npArt.style.backgroundImage = 'url(\'' +
                state.client.coverArtUrl(song.coverArt, NP_ART_SIZE) + '\')';
        } else {
            el.npArt.className = 'np-art empty';
            el.npArt.style.backgroundImage = '';
        }

        /* Reset the seeker so the previous track's progress does not linger. */
        el.seekFill.style.width = '0%';
        el.seekElapsed.innerHTML = '0:00';
        el.seekTotal.innerHTML = '0:00';
        el.npSeekFill.style.width = '0%';
        el.npElapsed.innerHTML = '0:00';
        el.npTotal.innerHTML = '0:00';
        renderNowPlaying();
        loadLyrics(song);
        setStatus('Loading ' + song.title + ' ...', false);

        rows = el.songList.querySelectorAll('.track');
        for (i = 0; i < rows.length; i++) {
            rows[i].className = rows[i].className.replace(/\s*playing/, '');
        }
        if (rows[index]) {
            rows[index].className += ' playing';
        }
    }

    function playNext() {
        if (state.currentIndex + 1 < state.songs.length) {
            playIndex(state.currentIndex + 1);
        }
    }

    function playPrev() {
        if (state.currentIndex > 0) {
            playIndex(state.currentIndex - 1);
        }
    }

    /* ---------- Playback state and seeker ---------- */

    function formatClock(seconds) {
        var total, mins, secs;
        if (!isFinite(seconds) || seconds < 0) {
            return '0:00';
        }
        total = Math.floor(seconds);
        mins = Math.floor(total / 60);
        secs = total % 60;
        return mins + ':' + (secs < 10 ? '0' : '') + secs;
    }

    /*
     * The transport bar reflects the audio element rather than assuming a
     * stream started successfully. Without this the UI showed nothing while a
     * stalled stream sat there, which read as the app hanging.
     */
    /*
     * The stream's duration is not always known to the media element: Tizen's
     * WebKit reports Infinity for a progressive MP3 until it has buffered
     * enough, and some servers omit Content-Length on transcoded streams. The
     * song's own duration from the API is authoritative, so fall back to it
     * rather than showing 0:00.
     */
    function seekerDuration() {
        var audio = el.audio;
        if (isFinite(audio.duration) && audio.duration > 0) {
            return audio.duration;
        }
        if (state.currentSong && state.currentSong.duration > 0) {
            return state.currentSong.duration;
        }
        return 0;
    }

    function updateSeeker() {
        var audio = el.audio;
        var duration = seekerDuration();
        var pct = 0;
        var total = '0:00';
        var elapsed = formatClock(audio.currentTime);

        if (duration > 0) {
            pct = (audio.currentTime / duration) * 100;
            if (pct > 100) {
                pct = 100;
            }
            total = formatClock(duration);
        }
        el.seekTotal.innerHTML = total;
        el.seekElapsed.innerHTML = elapsed;
        el.seekFill.style.width = pct + '%';

        /* The Now Playing screen mirrors the same state on its own bar. */
        el.npTotal.innerHTML = total;
        el.npElapsed.innerHTML = elapsed;
        el.npSeekFill.style.width = pct + '%';

        updateNowSeeker();
    }

    /*
     * Tizen's WebKit does not always fire `timeupdate` at a usable rate, so
     * poll while playing as a safety net. The timer is cleared on pause and
     * on error so it never runs against a stopped element.
     */
    function startSeekerTimer() {
        stopSeekerTimer();
        state.seekerTimer = global.setInterval(updateSeeker, 500);
    }

    function stopSeekerTimer() {
        if (state.seekerTimer) {
            global.clearInterval(state.seekerTimer);
            state.seekerTimer = null;
        }
    }

    /*
     * Swap the play/pause SVG rather than writing Unicode glyphs, which the
     * Tizen 2.4 system font does not cover. Both the transport bar and the
     * Now Playing screen show the same button, so both are updated together.
     */
    function playIconMarkup(playing) {
        return playing ?
            '<svg viewBox="0 0 24 24" aria-hidden="true">' +
                '<path d="M6.5 4h4v16h-4z"/>' +
                '<path d="M13.5 4h4v16h-4z"/>' +
            '</svg>' :
            '<svg viewBox="0 0 24 24" aria-hidden="true">' +
                '<path d="M7 4.5v15L20 12z"/>' +
            '</svg>';
    }

    function setPlayIcon(playing) {
        var label = playing ? 'Pause' : 'Play';
        el.playBtn.innerHTML = playIconMarkup(playing);
        el.playBtn.setAttribute('aria-label', label);
        el.npPlay.innerHTML = playIconMarkup(playing);
        el.npPlay.setAttribute('aria-label', label);
    }

    function bindAudio() {
        var audio = el.audio;

        audio.addEventListener('timeupdate', updateSeeker, false);
        audio.addEventListener('durationchange', updateSeeker, false);
        audio.addEventListener('loadedmetadata', updateSeeker, false);

        audio.addEventListener('play', function () {
            setPlayIcon(true);
            setStatus('Playing.', false);
            startSeekerTimer();
        }, false);

        audio.addEventListener('pause', function () {
            setPlayIcon(false);
            stopSeekerTimer();
        }, false);

        audio.addEventListener('waiting', function () {
            setStatus('Buffering ...', false);
        }, false);

        audio.addEventListener('playing', function () {
            setStatus('Playing.', false);
            startSeekerTimer();
        }, false);

        audio.addEventListener('stalled', function () {
            setStatus('Stream stalled. Check the server.', true);
        }, false);

        /*
         * A failed stream used to leave the UI silent and apparently frozen.
         * Surface the reason and clear the seeker instead.
         */
        audio.addEventListener('error', function () {
            var code = audio.error ? audio.error.code : 0;
            var reason = 'Playback failed.';
            if (code === 1) {
                reason = 'Playback aborted.';
            } else if (code === 2) {
                reason = 'Network error while streaming.';
            } else if (code === 3) {
                reason = 'Could not decode this stream.';
            } else if (code === 4) {
                reason = 'This stream format is not supported.';
            }
            setStatus(reason, true);
            setPlayIcon(false);
            stopSeekerTimer();
            el.seekFill.style.width = '0%';
            el.seekElapsed.innerHTML = '0:00';
            el.seekTotal.innerHTML = '0:00';
            el.npSeekFill.style.width = '0%';
            el.npElapsed.innerHTML = '0:00';
            el.npTotal.innerHTML = '0:00';
        }, false);

        audio.addEventListener('ended', function () {
            stopSeekerTimer();
            playNext();
        }, false);
    }

    /* ---------- Focus / D-pad ---------- */

    function visible(nodes) {
        var out = [];
        var i;
        for (i = 0; i < nodes.length; i++) {
            if (nodes[i].offsetParent !== null) {
                out.push(nodes[i]);
            }
        }
        return out;
    }

    /*
     * The home screen is taller than the viewport, so a focused card can sit
     * off-screen. Tizen's WebKit does not scroll focused elements into view
     * reliably, so we do it explicitly.
     */
    function focusNode(node) {
        var screen = node.parentNode;
        var top, bottom, viewTop, viewBottom;
        var row, rowScrollBefore;

        /*
         * The row is a scroll container, so `focus()` makes the browser scroll
         * it into view — and the browser centres the card, which overshoots by
         * a whole page. Remember where the row was so the overshoot can be
         * undone below.
         */
        row = node.parentNode;
        rowScrollBefore = (row && row.className && row.className.indexOf('grid') >= 0)
            ? row.scrollLeft : 0;

        node.focus();

        /*
         * Walk up by parentNode, not offsetParent: `.screen` is not positioned,
         * so it is never an offsetParent, and the chain from a card reaches
         * `#app` (whose own offsetParent is null) without ever passing through
         * the screen.
         */
        while (screen && (!screen.className ||
                screen.className.indexOf('screen') < 0)) {
            screen = screen.parentNode;
        }
        if (!screen || !screen.className) {
            return;
        }

        /*
         * The browser's focus-reveal scrolls the nearest scrollable ancestor,
         * which is the screen. That drags every row sideways together, so the
         * screen is pinned and the row is scrolled by hand instead.
         */
        screen.scrollLeft = 0;

        top = node.offsetTop;
        bottom = top + node.offsetHeight;
        viewTop = screen.scrollTop;
        viewBottom = viewTop + screen.clientHeight;

        if (top < viewTop) {
            screen.scrollTop = top - 20;
        } else if (bottom > viewBottom) {
            screen.scrollTop = bottom - screen.clientHeight + 20;
        }

        /* Scroll only the row the focused card belongs to. */
        row = node.parentNode;
        if (!row || !row.className || row.className.indexOf('grid') < 0) {
            return;
        }
        /*
         * Undo the browser's focus-reveal overshoot, then scroll by hand.
         *
         * The browser performs its own scroll-into-view *after* this function
         * returns (it is not observable through the scrollLeft setter), so the
         * correction has to be deferred to the next frame or it gets
         * overwritten.
         *
         * The target is derived from the card's index and layout width rather
         * than from getBoundingClientRect(), because the painted box has
         * already been shifted by the browser's scroll and is scaled 6% while
         * focused. Index arithmetic is immune to both.
         */
        var cards = gridOf(node);
        var index = indexIn(cards, node);
        if (index < 0) {
            return;
        }
        var cardW = node.offsetWidth;
        /* Matches `.card { margin: 0 26px 0 0 }`. */
        var gap = 26;
        var step = cardW + gap;
        var rowLeft = index * step;
        var rowRight = rowLeft + cardW;

        function applyRowScroll() {
            /*
             * Measure against where the row was before focus, not where the
             * browser's focus-reveal left it. Otherwise a row that the browser
             * has already scrolled looks "already correct" and is never
             * brought back to the focused card.
             */
            var rowViewLeft = rowScrollBefore;
            var rowViewRight = rowViewLeft + row.clientWidth;

            if (rowLeft < rowViewLeft) {
                row.scrollLeft = Math.max(0, rowLeft - 20);
            } else if (rowRight > rowViewRight) {
                /* Scroll just far enough to reveal the card, not a page. */
                row.scrollLeft = rowRight - row.clientWidth + 20;
            } else {
                row.scrollLeft = rowViewLeft;
            }
        }

        row.scrollLeft = rowScrollBefore;
        applyRowScroll();
        global.setTimeout(applyRowScroll, 0);
    }
    /*
     * Replay a CSS animation by removing the class, forcing a reflow, then
     * re-adding it. Without the reflow the browser coalesces the change and
     * the animation never restarts.
     */
    function replayAnimation(node, className) {
        if (!node) {
            return;
        }
        node.className = node.className
            .replace(/\s*row-in-up/, '')
            .replace(/\s*row-in-down/, '');
        /* Reading offsetWidth forces the style recalculation. */
        void node.offsetWidth;
        node.className += ' ' + className;
    }

    /* Slide the row the focus just landed on, in the direction of travel. */
    function animateRow(node, delta) {
        var list = node && node.parentNode;
        if (!list || !list.className || list.className.indexOf('grid') < 0) {
            return;
        }
        replayAnimation(list, delta > 0 ? 'row-in-down' : 'row-in-up');
    }

    function focusables() {
        return visible(document.querySelectorAll(
            '.screen.active .card, .screen.active .track, .screen.active .result, ' +
            '.screen.active .artist, .screen.active .playlist, ' +
            '.screen.active .index-letter, ' +
            '.screen.active .key, .screen.active button, .screen.active input'
        ));
    }

    function focusFirst() {
        var nodes = focusables();
        var i;
        /* Prefer content over chrome so the D-pad starts on the grid. */
        for (i = 0; i < nodes.length; i++) {
            if (nodes[i].className.indexOf('card') >= 0 ||
                    nodes[i].className.indexOf('track') >= 0 ||
                    nodes[i].className.indexOf('result') >= 0 ||
                    nodes[i].className.indexOf('artist') >= 0 ||
                    nodes[i].className.indexOf('playlist') >= 0) {
                focusNode(nodes[i]);
                return;
            }
        }
        if (nodes.length) {
            focusNode(nodes[0]);
        }
    }

    /*
     * The home screen stacks three independent card rows. Left/right walks
     * along a row; up/down moves between rows and hands off to the
     * neighbouring section at the edge. The column count is measured from the
     * rendered geometry rather than assumed, so the layout can change without
     * breaking navigation.
     */
    function cardsPerRow(cards) {
        var top = cards[0].offsetTop;
        var i;
        for (i = 1; i < cards.length; i++) {
            /* offsetTop is integer-rounded, but a focused card is scaled, so
               compare with a tolerance rather than for exact equality. */
            if (Math.abs(cards[i].offsetTop - top) > 5) {
                return i;
            }
        }
        return cards.length;
    }

    function gridOf(node) {
        var list = node.getAttribute && node.getAttribute('data-list');
        if (!list) {
            return null;
        }
        return visible(document.querySelectorAll(
            '.screen.active .card[data-list="' + list + '"]'
        ));
    }

    function indexIn(nodes, node) {
        var i;
        for (i = 0; i < nodes.length; i++) {
            if (nodes[i] === node) {
                return i;
            }
        }
        return -1;
    }

    /*
     * Move one card left/right inside the current row. Reaching the right-hand
     * end pulls the next page, so the row keeps growing as the user scrolls.
     */
    function moveInGrid(cards, delta) {
        var index = indexIn(cards, document.activeElement);
        var target;
        if (index < 0) {
            focusNode(cards[0]);
            return;
        }
        target = index + delta;
        if (target >= 0 && target < cards.length) {
            focusNode(cards[target]);
            if (delta > 0 && target >= cards.length - 2) {
                loadMore(cards[target].getAttribute('data-list'));
            }
        }
    }

    /*
     * Move one row up/down. Returns false when the grid edge is reached, so
     * the caller can hand focus to the neighbouring grid instead.
     */
    function moveGridRow(cards, delta) {
        var index = indexIn(cards, document.activeElement);
        var perRow, target;
        if (index < 0) {
            focusNode(cards[0]);
            return true;
        }
        perRow = cardsPerRow(cards);
        target = index + delta * perRow;
        if (target < 0 || target >= cards.length) {
            return false;
        }
        focusNode(cards[target]);
        return true;
    }

    /*
     * The section above/below the current one, in visual order. `column` is
     * the horizontal position to preserve across the handoff, so moving down
     * from the 4th card of one row lands on the 4th card of the next.
     */
    function neighbourGrid(currentList, delta, column) {
        var lists = ['recent', 'added', 'top'];
        var pos = -1;
        var i, cards, index;
        if (currentList === null) {
            /* Coming down from the nav bar: land on the first section. */
            pos = delta > 0 ? -1 : lists.length;
        } else {
            for (i = 0; i < lists.length; i++) {
                if (lists[i] === currentList) {
                    pos = i;
                    break;
                }
            }
            if (pos < 0) {
                return null;
            }
        }
        pos += delta;
        if (pos < 0 || pos >= lists.length) {
            return null;
        }
        cards = visible(document.querySelectorAll(
            '.screen.active .card[data-list="' + lists[pos] + '"]'
        ));
        if (!cards.length) {
            return null;
        }
        if (typeof column === 'number' && column > 0) {
            index = column < cards.length ? column : cards.length - 1;
            return [cards[index]];
        }
        return cards;
    }

    /* The nav bar buttons, in visual order, for the Up handoff. */
    function navFocusables() {
        return visible(document.querySelectorAll('#nav .tab'));
    }

    /*
     * Search-screen navigation. The keyboard is a wrapping block of keys, so
     * Left/Right walk it in document order and Up/Down move by one visual row.
     * The row length is measured from the rendered geometry rather than
     * assumed, the same way the home grids do it, so the layout can change
     * without breaking navigation.
     */
    function moveSearchFocus(key) {
        var keys = visible(el.keyboard.querySelectorAll('.key'));
        var results = visible(el.searchResults.querySelectorAll('.result'));
        var target = document.activeElement;
        var index, perRow, next;

        if (target && target.className.indexOf('result') >= 0) {
            index = indexIn(results, target);
            if (key === 38) {
                /* Up from the first result returns to the keyboard. */
                if (index <= 0) {
                    if (keys.length) {
                        focusNode(keys[keys.length - 1]);
                    }
                } else {
                    focusNode(results[index - 1]);
                }
            } else if (key === 40) {
                if (index + 1 < results.length) {
                    focusNode(results[index + 1]);
                }
            }
            return;
        }

        if (!keys.length) {
            return;
        }
        index = indexIn(keys, target);
        if (index < 0) {
            focusNode(keys[0]);
            return;
        }

        if (key === 37 || key === 39) {
            next = index + (key === 39 ? 1 : -1);
            if (next >= 0 && next < keys.length) {
                focusNode(keys[next]);
            }
            return;
        }

        perRow = cardsPerRow(keys);
        next = index + (key === 40 ? perRow : -perRow);
        if (next >= 0 && next < keys.length) {
            focusNode(keys[next]);
        } else if (key === 40) {
            /* Below the last keyboard row are the results. */
            if (results.length) {
                focusNode(results[0]);
            }
        } else {
            /* Above the first keyboard row is the nav bar. */
            focusNav();
        }
    }

    /*
     * The Artists screen: a vertical list of artists with an A-Z strip above
     * it. Up/Down walk the list, Left/Right walk the strip, and the strip
     * jumps the list to the first artist under a letter.
     */
    function artistRows() {
        return visible(el.artistList.querySelectorAll('.artist'));
    }

    function artistIndexButtons() {
        return visible(el.artistIndex.querySelectorAll('.index-letter'));
    }

    function moveArtistList(delta) {
        var rows = artistRows();
        var index = indexIn(rows, document.activeElement);
        var target;

        if (!rows.length) {
            return;
        }
        if (index < 0) {
            focusNode(rows[0]);
            return;
        }
        target = index + delta;
        if (target >= 0 && target < rows.length) {
            focusNode(rows[target]);
        } else if (delta < 0) {
            /* Above the first artist is the A-Z strip. */
            focusArtistIndex();
        }
    }

    function moveArtistIndex(delta) {
        var nodes = artistIndexButtons();
        var index = indexIn(nodes, document.activeElement);
        if (!nodes.length) {
            return;
        }
        if (index < 0) {
            focusNode(nodes[0]);
            return;
        }
        focusNode(nodes[(index + delta + nodes.length) % nodes.length]);
    }

    function focusArtistIndex() {
        var nodes = artistIndexButtons();
        if (nodes.length) {
            focusNode(nodes[0]);
            return true;
        }
        return false;
    }

    /*
     * The Playlists screen is a plain vertical list, so Up/Down walk it and
     * Up from the first row hands off to the nav bar.
     */
    function playlistRows() {
        return visible(el.playlistList.querySelectorAll('.playlist'));
    }

    function movePlaylistList(delta) {
        var rows = playlistRows();
        var index = indexIn(rows, document.activeElement);
        var target;

        if (!rows.length) {
            return;
        }
        if (index < 0) {
            focusNode(rows[0]);
            return;
        }
        target = index + delta;
        if (target >= 0 && target < rows.length) {
            focusNode(rows[target]);
        } else if (delta < 0) {
            /* Above the first playlist is the nav bar. */
            focusNav();
        }
    }

    /*
     * The playlist detail screen is a vertical track list. Up/Down walk the
     * tracks only — `moveFocus()` would also step onto the "back" button in
     * the header, so the D-pad could leave the list and land on chrome.
     */
    function movePlaylistTracks(delta) {
        var rows = visible(el.playlistSongs.querySelectorAll('.track'));
        var index = indexIn(rows, document.activeElement);
        var target;

        if (!rows.length) {
            return;
        }
        if (index < 0) {
            focusNode(rows[0]);
            return;
        }
        target = index + delta;
        if (target >= 0 && target < rows.length) {
            focusNode(rows[target]);
        }
    }

    /* Move along the nav bar, wrapping at the ends. */
    function moveNav(delta) {
        var nodes = navFocusables();
        var index = indexIn(nodes, document.activeElement);
        if (!nodes.length) {
            return;
        }
        if (index < 0) {
            focusNode(nodes[0]);
            return;
        }
        focusNode(nodes[(index + delta + nodes.length) % nodes.length]);
    }

    function focusNav() {
        var nodes = navFocusables();
        if (nodes.length) {
            focusNode(nodes[0]);
            return true;
        }
        return false;
    }

    /* Walk the Now Playing transport buttons, wrapping at the ends. */
    function moveNowActions(delta) {
        var nodes = [el.npPrev, el.npPlay, el.npNext];
        var index = indexIn(nodes, document.activeElement);
        if (index < 0) {
            focusNode(el.npPlay);
            return;
        }
        focusNode(nodes[(index + delta + nodes.length) % nodes.length]);
    }

    /*
     * Remember where the D-pad was before it went up to the nav bar, so Down
     * (or Back) can drop straight back onto that card instead of forcing the
     * user to re-enter the grid from the top.
     */
    function rememberGridFocus() {
        var node = document.activeElement;
        if (node && node.className.indexOf('card') >= 0) {
            state.lastGrid = node;
        }
    }

    function restoreGridFocus() {
        var node = state.lastGrid;
        if (node && node.parentNode && node.className.indexOf('card') >= 0) {
            focusNode(node);
            return true;
        }
        return false;
    }

    function moveFocus(delta) {
        var nodes = focusables();
        var current = document.activeElement;
        var i;
        if (!nodes.length) {
            return;
        }
        for (i = 0; i < nodes.length; i++) {
            if (nodes[i] === current) {
                focusNode(nodes[(i + delta + nodes.length) % nodes.length]);
                return;
            }
        }
        focusNode(nodes[0]);
    }

    function indexOfNode(node) {
        var raw = node.getAttribute('data-index');
        return raw === null ? -1 : parseInt(raw, 10);
    }

    function bindList(listEl, handler) {
        listEl.addEventListener('click', function (event) {
            var node = event.target;
            while (node && node !== listEl && indexOfNode(node) < 0) {
                node = node.parentNode;
            }
            if (node && node !== listEl) {
                handler(node);
            }
        }, false);

        /* TV remotes send Enter as keydown on the focused element. */
        listEl.addEventListener('keydown', function (event) {
            var key = event.keyCode;
            if (key === 13 || key === 29443) {
                if (event.target.getAttribute && indexOfNode(event.target) >= 0) {
                    /*
                     * Activating a card can move focus to a button on the
                     * screen it opens, and the global handler would then fire
                     * the same keypress again on that button. Mark the event
                     * so bindRemote leaves it alone.
                     */
                    event.__subtizenHandled = true;
                    handler(event.target);
                }
            }
        }, false);
    }

    /*
     * The on-screen keyboard is a list of <button>s rather than cards, so it
     * needs its own binding: the browser already turns Enter on a focused
     * button into a click, and the global handler would otherwise fire the key
     * a second time.
     */
    function bindKeyboard() {
        el.keyboard.addEventListener('click', function (event) {
            var node = event.target;
            while (node && node !== el.keyboard &&
                    !(node.getAttribute && node.getAttribute('data-action'))) {
                node = node.parentNode;
            }
            if (node && node !== el.keyboard) {
                searchKey(node);
            }
        }, false);
    }

    /*
     * The A-Z strip is a row of <button>s, so it needs its own binding: the
     * browser already turns Enter on a focused button into a click.
     */
    function bindArtistIndex() {
        el.artistIndex.addEventListener('click', function (event) {
            var node = event.target;
            while (node && node !== el.artistIndex &&
                    !(node.getAttribute && node.getAttribute('data-letter'))) {
                node = node.parentNode;
            }
            if (node && node !== el.artistIndex) {
                jumpToLetter(node.getAttribute('data-letter'));
            }
        }, false);
    }

    /* Resolve a card element to the item it represents. */
    function itemForCard(card) {
        var key = card.getAttribute('data-list');
        var index = indexOfNode(card);
        var section = SECTIONS[key];
        if (!section || index < 0) {
            return null;
        }
        return section.items[index] || null;
    }

    function activateCard(card) {
        var key = card.getAttribute('data-list');
        var item;

        /* The artist detail grid is not one of the home SECTIONS. */
        if (key === 'artist') {
            item = state.artistAlbums[indexOfNode(card)];
            if (item) {
                openAlbum(item, 'screen-artist');
            }
            return;
        }

        item = itemForCard(card);
        if (!item) {
            return;
        }
        if (SECTIONS[key].kind === 'song') {
            openSong(item);
        } else {
            openAlbum(item);
        }
    }

    /* Global D-pad handling: arrows move focus, Enter activates. */
    function bindRemote() {
        document.addEventListener('keydown', function (event) {
            var key = event.keyCode;
            var target = document.activeElement;
            var cards, next;

            /*
             * A list handler already acted on this keypress. Activating a card
             * can move focus onto a button on the screen it opens, and acting
             * again here would fire that button with the same key.
             */
            if (event.__subtizenHandled) {
                return;
            }

            /*
             * The search screen is a keyboard plus a vertical result list, so
             * it gets its own navigation: Left/Right walk the keyboard, Up/Down
             * move between keyboard rows and into the results, and Enter types
             * the focused key or opens the focused result.
             */
            if ($('screen-search').className.indexOf('active') >= 0) {
                if (key === 37 || key === 39 || key === 38 || key === 40) {
                    event.preventDefault();
                    moveSearchFocus(key);
                } else if (key === 13 || key === 29443) {
                    if (target && target.className.indexOf('key') >= 0) {
                        event.preventDefault();
                        searchKey(target);
                    } else if (target && target.className.indexOf('result') >= 0) {
                        event.preventDefault();
                        activateResult(target);
                    }
                } else if (key === 10009 || key === 461) {
                    event.preventDefault();
                    if (target && target.className.indexOf('result') >= 0) {
                        /* Back out of the results to the keyboard. */
                        focusNode(el.keyboard.querySelector('.key'));
                    } else if (target && target.className.indexOf('key') >= 0) {
                        /* Back out of the keyboard to the nav bar. */
                        focusNav();
                    } else {
                        show('screen-albums');
                    }
                }
                return;
            }

            /*
             * The Now Playing screen carries its own transport buttons, so the
             * D-pad walks them and Up hands off to the nav bar. Back steps out
             * of the buttons first, then leaves the screen.
             */
            if ($('screen-now').className.indexOf('active') >= 0) {
                if (key === 37 || key === 39) {
                    event.preventDefault();
                    if (target && target.className.indexOf('tab') >= 0) {
                        /* Walk along the nav bar, not the transport buttons. */
                        moveNav(key === 39 ? 1 : -1);
                    } else {
                        moveNowActions(key === 39 ? 1 : -1);
                    }
                } else if (key === 38) {
                    event.preventDefault();
                    focusNav();
                } else if (key === 40) {
                    event.preventDefault();
                    focusNode(el.npPlay);
                } else if (key === 13 || key === 29443) {
                    if (target && target.className.indexOf('np-') >= 0) {
                        event.preventDefault();
                        target.click();
                    }
                } else if (key === 10009 || key === 461) {
                    event.preventDefault();
                    if (target && target.className.indexOf('np-') >= 0) {
                        /* Back out of the buttons to the nav bar. */
                        focusNav();
                    } else {
                        show('screen-albums');
                    }
                }
                return;
            }

            /*
             * The Artists screen is a vertical list of artists with an A-Z
             * strip above it. Up/Down walk the list, Left/Right walk the
             * strip, and Enter opens the focused artist or jumps to the
             * focused letter.
             */
            if ($('screen-artists').className.indexOf('active') >= 0) {
                if (key === 38 || key === 40) {
                    event.preventDefault();
                    moveArtistList(key === 40 ? 1 : -1);
                } else if (key === 37 || key === 39) {
                    event.preventDefault();
                    moveArtistIndex(key === 39 ? 1 : -1);
                } else if (key === 13 || key === 29443) {
                    /*
                     * Artist rows are handled by bindList, so only the A-Z
                     * strip needs the global handler.
                     */
                    if (target && target.className.indexOf('index-letter') >= 0) {
                        event.preventDefault();
                        jumpToLetter(target.getAttribute('data-letter'));
                    }
                } else if (key === 10009 || key === 461) {
                    event.preventDefault();
                    if (target && target.className.indexOf('artist') >= 0) {
                        /* Back out of the list to the A-Z strip. */
                        focusArtistIndex();
                    } else {
                        show('screen-albums');
                    }
                }
                return;
            }

            /*
             * The Playlists screen is a vertical list of playlists. Up/Down
             * walk it, Enter opens the focused playlist, and Back returns to
             * the album list.
             */
            if ($('screen-playlists').className.indexOf('active') >= 0) {
                if (key === 38 || key === 40) {
                    event.preventDefault();
                    movePlaylistList(key === 40 ? 1 : -1);
                } else if (key === 37 || key === 39) {
                    /*
                     * Left/Right only mean something on the nav bar. Without
                     * this the key fell through to the generic handler, which
                     * has no grid to walk here, so the toolbar stayed stuck on
                     * whichever tab the Up handoff landed on.
                     */
                    if (target && target.className.indexOf('tab') >= 0) {
                        event.preventDefault();
                        moveNav(key === 39 ? 1 : -1);
                    }
                } else if (key === 10009 || key === 461) {
                    event.preventDefault();
                    if (target && target.className.indexOf('playlist') >= 0) {
                        /* Back out of the list to the nav bar. */
                        focusNav();
                    } else {
                        show('screen-albums');
                    }
                }
                return;
            }

            /*
             * The playlist detail screen is a vertical track list, so Up/Down
             * walk it and Back returns to the playlist list.
             */
            if ($('screen-playlist').className.indexOf('active') >= 0) {
                if (key === 38 || key === 40) {
                    event.preventDefault();
                    movePlaylistTracks(key === 40 ? 1 : -1);
                } else if (key === 37 || key === 39) {
                    /* Left/Right only mean something on the nav bar. */
                    if (target && target.className.indexOf('tab') >= 0) {
                        event.preventDefault();
                        moveNav(key === 39 ? 1 : -1);
                    }
                } else if (key === 10009 || key === 461) {
                    event.preventDefault();
                    show('screen-playlists');
                }
                return;
            }

            /*
             * The artist detail screen is a single row of album cards, so
             * Left/Right walk it and Up hands off to the nav bar.
             */
            if ($('screen-artist').className.indexOf('active') >= 0) {
                if (key === 37 || key === 39) {
                    event.preventDefault();
                    cards = target && target.className.indexOf('card') >= 0 ?
                        gridOf(target) : null;
                    if (cards) {
                        moveInGrid(cards, key === 39 ? 1 : -1);
                    }
                } else if (key === 38) {
                    event.preventDefault();
                    focusNav();
                } else if (key === 40) {
                    event.preventDefault();
                    cards = visible(el.artistAlbums.querySelectorAll('.card'));
                    if (cards.length) {
                        focusNode(cards[0]);
                    }
                } else if (key === 10009 || key === 461) {
                    event.preventDefault();
                    show('screen-artists');
                }
                return;
            }

            if (key === 38 || key === 40) {          /* up / down */
                event.preventDefault();
                cards = target && target.className.indexOf('card') >= 0 ?
                    gridOf(target) : null;
                if (cards) {
                    if (!moveGridRow(cards, key === 40 ? 1 : -1)) {
                        next = neighbourGrid(target.getAttribute('data-list'),
                            key === 40 ? 1 : -1, indexIn(cards, target));
                        if (next) {
                            focusNode(next[0]);
                            animateRow(next[0], key === 40 ? 1 : -1);
                        } else if (key === 38) {
                            /* Above the first section is the nav bar. */
                            rememberGridFocus();
                            focusNav();
                        }
                    }
                } else if (target && target.className.indexOf('tab') >= 0) {
                    /* Down from the nav bar returns to the grid. */
                    if (key === 40) {
                        if (!restoreGridFocus()) {
                            next = neighbourGrid(null, 1);
                            if (next) {
                                focusNode(next[0]);
                                animateRow(next[0], 1);
                            }
                        }
                    }
                } else {
                    moveFocus(key === 40 ? 1 : -1);
                }
            } else if (key === 37 || key === 39) {   /* left / right */
                event.preventDefault();
                cards = target && target.className.indexOf('card') >= 0 ?
                    gridOf(target) : null;
                if (cards) {
                    moveInGrid(cards, key === 39 ? 1 : -1);
                } else if (target && target.className.indexOf('tab') >= 0) {
                    /* Walk along the nav bar. */
                    moveNav(key === 39 ? 1 : -1);
                } else {
                    moveFocus(key === 39 ? 1 : -1);
                }
            } else if (key === 13 || key === 29443) { /* Enter / Tizen remote Enter */
                if (target && target.tagName === 'BUTTON') {
                    event.preventDefault();
                    target.click();
                }
            } else if (key === 10009 || key === 461) { /* Back / Return */
                event.preventDefault();
                if ($('screen-album').className.indexOf('active') >= 0) {
                    show(state.albumReturn);
                } else if (target && target.className.indexOf('tab') >= 0) {
                    /* Back out of the nav bar to wherever the D-pad was. */
                    if (!restoreGridFocus()) {
                        focusFirst();
                    }
                }
            }
        }, false);
    }

    /* ---------- Media keys ---------- */

    function togglePlayPause() {
        if (!el.audio.src) {
            return;
        }
        if (el.audio.paused) {
            el.audio.play();
        } else {
            el.audio.pause();
        }
    }

    function stopPlayback() {
        el.audio.pause();
        el.audio.currentTime = 0;
    }

    function seekBy(seconds) {
        var target;
        if (!el.audio.src || isNaN(el.audio.duration)) {
            return;
        }
        target = el.audio.currentTime + seconds;
        if (target < 0) {
            target = 0;
        }
        if (target > el.audio.duration) {
            target = el.audio.duration;
        }
        el.audio.currentTime = target;
    }

    /*
     * Media keys are matched by the name the device reported for the keycode,
     * because the numeric code differs between TV models. The hardcoded
     * constants are only a fallback for hosts that cannot report names.
     */
    function mediaAction(key) {
        var name = RemoteKeys.nameForCode(key);
        var K = RemoteKeys.KEYS;

        if (name) {
            switch (name) {
            case 'MediaPlay': return 'play';
            case 'MediaPause': return 'pause';
            case 'MediaPlayPause': return 'toggle';
            case 'MediaStop': return 'stop';
            case 'MediaRewind': return 'rewind';
            case 'MediaFastForward': return 'forward';
            case 'MediaTrackNext': return 'next';
            case 'MediaTrackPrevious': return 'prev';
            default: return null;
            }
        }

        switch (key) {
        case K.MEDIA_PLAY: return 'play';
        case K.MEDIA_PAUSE: return 'pause';
        case K.MEDIA_PLAY_PAUSE: return 'toggle';
        case K.MEDIA_STOP: return 'stop';
        case K.MEDIA_REWIND: return 'rewind';
        case K.MEDIA_FAST_FORWARD: return 'forward';
        case K.MEDIA_TRACK_NEXT: return 'next';
        case K.MEDIA_TRACK_PREVIOUS: return 'prev';
        case K.MEDIA_NEXT_ALT: return 'next';
        case K.MEDIA_PREV_ALT: return 'prev';
        default: return null;
        }
    }

    /*
     * Every keydown is recorded so a TV whose media keys use unexpected codes
     * can be diagnosed from the app itself: pressing 0 three times shows the
     * last codes seen on screen, and they are also exposed on
     * window.SubTizen.lastKeys.
     */
    var lastKeys = [];
    var diagEl = null;
    var diagCount = 0;

    function recordKey(code) {
        lastKeys.push(code);
        if (lastKeys.length > 12) {
            lastKeys.shift();
        }
        if (code === 48) {
            diagCount++;
            if (diagCount >= 3) {
                diagCount = 0;
                showKeyDiag();
            }
        } else {
            diagCount = 0;
        }
    }

    function showKeyDiag() {
        if (!diagEl) {
            diagEl = document.createElement('div');
            diagEl.className = 'key-diag';
            document.body.appendChild(diagEl);
        }
        diagEl.innerHTML = 'last keys: ' + lastKeys.join(', ');
        diagEl.style.display = 'block';
        global.setTimeout(function () {
            diagEl.style.display = 'none';
        }, 4000);
    }

    function bindMediaKeys() {
        document.addEventListener('keydown', function (event) {
            var action;
            recordKey(event.keyCode);
            action = mediaAction(event.keyCode);

            if (!action) {
                return;
            }
            event.preventDefault();

            switch (action) {
            case 'play':
                if (el.audio.src) {
                    el.audio.play();
                }
                break;
            case 'pause':
                el.audio.pause();
                break;
            case 'toggle':
                togglePlayPause();
                break;
            case 'stop':
                stopPlayback();
                break;
            case 'rewind':
                seekBy(-10);
                break;
            case 'forward':
                seekBy(10);
                break;
            case 'next':
                playNext();
                break;
            case 'prev':
                playPrev();
                break;
            default:
                break;
            }
        }, false);
    }

    /* ---------- Number pad ---------- */

    /*
     * Digits jump directly to a track number within the open album, which is
     * the convention on TV media apps. Typing is buffered briefly so that
     * "1" then "2" selects track 12 rather than track 1 followed by track 2.
     */
    var NUM_BUFFER_MS = 900;
    var numBuffer = '';
    var numTimer = null;

    function commitNumber() {
        var n;
        if (numTimer) {
            clearTimeout(numTimer);
            numTimer = null;
        }
        if (!numBuffer) {
            return;
        }
        n = parseInt(numBuffer, 10);
        numBuffer = '';

        if (!state.songs.length) {
            setStatus('Open an album first.', true);
            return;
        }
        if (n < 1 || n > state.songs.length) {
            setStatus('No track ' + n + ' in this album.', true);
            return;
        }
        playIndex(n - 1);
    }

    function bindNumberKeys() {
        document.addEventListener('keydown', function (event) {
            var key = event.keyCode;
            var digit;

            if (!RemoteKeys.isNumberKey(key)) {
                return;
            }
            /* Let the user type into the login form normally. */
            if (document.activeElement && document.activeElement.tagName === 'INPUT') {
                return;
            }
            event.preventDefault();

            digit = RemoteKeys.numberFromKey(key);
            numBuffer += String(digit);
            if (numBuffer.length > 3) {
                numBuffer = numBuffer.slice(-3);
            }
            setStatus('Track ' + numBuffer + ' ...', false);

            if (numTimer) {
                clearTimeout(numTimer);
            }
            numTimer = setTimeout(commitNumber, NUM_BUFFER_MS);
        }, false);
    }

    /* ---------- Nav tabs ---------- */

    function selectTab(tab) {
        var tabs = document.querySelectorAll('#nav .tab');
        var i;
        for (i = 0; i < tabs.length; i++) {
            if (!tabs[i].getAttribute('data-tab')) {
                continue;   /* the theme toggle is not a tab */
            }
            tabs[i].className = 'tab' +
                (tabs[i].getAttribute('data-tab') === tab ? ' active' : '');
        }
    }

    function bindTabs() {
        var tabs = document.querySelectorAll('#nav .tab');
        var i;
        for (i = 0; i < tabs.length; i++) {
            if (!tabs[i].getAttribute('data-tab')) {
                continue;
            }
            tabs[i].addEventListener('click', function () {
                var tab = this.getAttribute('data-tab');
                selectTab(tab);
                if (tab === 'albums') {
                    if (state.client) {
                        loadHome();
                    }
                } else if (tab === 'artists') {
                    if (state.client) {
                        show('screen-artists');
                        loadArtists();
                    }
                } else if (tab === 'playlists') {
                    if (state.client) {
                        show('screen-playlists');
                        loadPlaylists();
                    }
                } else if (tab === 'search') {
                    if (state.client) {
                        show('screen-search');
                        openSearch();
                    }
                } else if (tab === 'now') {
                    renderNowPlaying();
                    updateSeeker();
                    show('screen-now');
                    setStatus(el.audio.src ? 'Now playing.' : 'Nothing playing yet.', false);
                } else {
                    setStatus(tab.charAt(0).toUpperCase() + tab.slice(1) +
                        ' is not implemented yet.', false);
                }
            }, false);
        }
    }

    /* ---------- Theme ---------- */

    var THEME_KEY = 'subtizen.theme';

    function applyTheme(dark) {
        /*
         * `now-active` is owned by `show()`; only the `dark` flag is rewritten
         * here so switching theme does not drop the Now Playing layout.
         */
        document.body.className = document.body.className
            .replace(/\s*dark/, '') +
            (dark ? ' dark' : '');
        el.themeBtn.innerHTML = dark ? 'Light' : 'Dark';
        try {
            global.localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
        } catch (e) {
            /* localStorage may be unavailable; non-fatal */
        }
    }

    function loadTheme() {
        var saved = null;
        try {
            saved = global.localStorage.getItem(THEME_KEY);
        } catch (e) {
            saved = null;
        }
        applyTheme(saved === 'dark');
    }

    function bindTheme() {
        el.themeBtn.addEventListener('click', function () {
            applyTheme(document.body.className.indexOf('dark') < 0);
        }, false);
    }

    function init() {
        el.nav = $('nav');
        el.avatar = $('nav-avatar');
        el.status = $('status');
        el.songList = $('song-list');
        el.albumTitle = $('album-title');
        el.albumArtist = $('album-artist');
        el.nowPlaying = $('now-playing');
        el.npArt = $('np-art');
        el.audio = $('audio');
        el.themeBtn = $('btn-theme');
        el.playBtn = $('btn-play');
        el.seekFill = $('seek-fill');
        el.seekElapsed = $('seek-elapsed');
        el.seekTotal = $('seek-total');
        el.keyboard = $('keyboard');
        el.searchQuery = $('search-query');
        el.searchResults = $('search-results');
        el.artistIndex = $('artist-index');
        el.artistList = $('artist-list');
        el.artistTitle = $('artist-title');
        el.artistCount = $('artist-count');
        el.artistAlbums = $('artist-albums');
        el.playlistList = $('playlist-list');
        el.playlistSongs = $('playlist-songs');
        el.playlistTitle = $('playlist-title');
        el.playlistCount = $('playlist-count');
        el.npCover = $('np-cover');
        el.npLyrics = $('np-lyrics');
        el.npTitle = $('np-title');
        el.npArtist = $('np-artist');
        el.npAlbum = $('np-album');
        el.npSeekFill = $('np-seek-fill');
        el.npElapsed = $('np-elapsed');
        el.npTotal = $('np-total');
        el.npPrev = $('np-prev');
        el.npPlay = $('np-play');
        el.npNext = $('np-next');

        $('connect-form').addEventListener('submit', function (event) {
            event.preventDefault();
            connect(
                $('server-url').value.trim(),
                $('username').value.trim(),
                $('password').value
            );
        }, false);

        $('back-to-albums').addEventListener('click', function () {
            show(state.albumReturn);
        }, false);

        $('back-to-artists').addEventListener('click', function () {
            show('screen-artists');
        }, false);

        $('back-to-playlists').addEventListener('click', function () {
            show('screen-playlists');
        }, false);

        $('btn-prev').addEventListener('click', playPrev, false);
        $('btn-next').addEventListener('click', playNext, false);
        el.playBtn.addEventListener('click', togglePlayPause, false);

        el.npPrev.addEventListener('click', playPrev, false);
        el.npNext.addEventListener('click', playNext, false);
        el.npPlay.addEventListener('click', togglePlayPause, false);

        bindAudio();

        bindList($('recent-list'), activateCard);
        bindList($('added-list'), activateCard);
        bindList($('top-list'), activateCard);
        bindList(el.songList, function (node) {
            playIndex(indexOfNode(node));
        });
        renderKeyboard();
        bindKeyboard();
        bindList(el.searchResults, activateResult);
        bindList(el.artistList, activateArtist);
        bindList(el.artistAlbums, activateCard);
        bindList(el.playlistList, activatePlaylist);
        bindList(el.playlistSongs, function (node) {
            playIndex(indexOfNode(node));
        });
        bindArtistIndex();
        bindTabs();
        bindTheme();
        bindRemote();
        bindMediaKeys();
        bindNumberKeys();
        RemoteKeys.registerWhenReady();
        RemoteKeys.bindLifecycle();
        loadTheme();

        var saved = loadConnection();
        if (saved && saved.url && saved.user && saved.pass) {
            $('server-url').value = saved.url;
            $('username').value = saved.user;
            $('password').value = saved.pass;
            connect(saved.url, saved.user, saved.pass);
        } else {
            show('screen-connect');
        }
    }

    global.addEventListener('load', init, false);

    // Exposed for automated verification of section ordering and sorting.
    global.SubTizen = {
        SECTIONS: SECTIONS,
        SECTION_ORDER: SECTION_ORDER,
        RemoteKeys: global.RemoteKeys,
        get lastKeys() { return lastKeys.slice(); },
        get currentSongDuration() {
            return state.currentSong ? state.currentSong.duration : null;
        },
        get client() { return state.client; },
        get searchQuery() { return state.search.query; },
        get searchResults() { return state.search.results.slice(); },
        get artists() { return state.artists.items.slice(); },
        get artistLetters() { return state.artists.letters.slice(); },
        get artistAlbums() { return state.artistAlbums.slice(); },
        get playlists() { return state.playlists.items.slice(); },
        get playlistSongs() { return state.playlistSongs.slice(); },
        get history() { return loadHistory(); },
        setAvatar: setAvatar,
        searchKey: function (label) {
            var keys = el.keyboard.querySelectorAll('.key');
            var i;
            for (i = 0; i < keys.length; i++) {
                if (keys[i].getAttribute('data-key') === label) {
                    searchKey(keys[i]);
                    return true;
                }
            }
            return false;
        },
        openAlbumById: function (id) {
            openAlbum({ id: id, name: '', artist: '' });
        },
        openSongById: function (id) {
            var pool = SECTIONS.top.pool || [];
            var i;
            for (i = 0; i < pool.length; i++) {
                if (pool[i].id === id) {
                    openSong(pool[i]);
                    return true;
                }
            }
            return false;
        },
        recordPlayForTest: recordPlay
    };
}(this));
