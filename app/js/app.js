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
    var PLAYMODE_KEY = 'subtizen.playmode';
    var HOME_REFRESH_MS = 10 * 60 * 1000;
    var MAX_FAIL_STREAK = 4;
    /*
     * Cards render at 300 CSS px. Requesting 132 px (the old vertical-list
     * size) made the artwork visibly pixelated once the layout grew, so ask
     * for 2x to stay sharp on high-density panels.
     */
    var CARD_ART_SIZE = 300;

    /* Transport-bar art renders at 96 CSS px; request 2x for sharpness. */
    var NP_ART_SIZE = 192;

    var state = {
        client: null,
        albums: [],
        songs: [],
        currentIndex: -1,
        currentSong: null,
        shuffle: false,
        repeat: 'off',              /* off | all | one */
        order: [],                  /* shuffled play order: indexes into `songs` */
        orderPos: 0,
        playedMs: 0,                /* time actually played of the current track (for scrobbling) */
        lastTickAt: 0,
        scrobbled: false,
        failStreak: 0,              /* consecutive tracks that failed to play */
        homeLoadedAt: 0,
        rowMemory: {},              /* last focused card index per home row */
        nowTint: null,              /* tint for the Now Playing screen only */
        casting: false,             /* an AirPlay cast owns the player bar */
        barSig: '',
        seekerTimer: null,
        lastGrid: null,
        now: {
            lyrics: [],
            line: -1,
            seq: 0,
            built: -1
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
        var fromAirPlay = $('screen-airplay').className.indexOf('active') >= 0;
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
            .replace(/\s*now-active/, '')
            .replace(/\s*connect-active/, '') +
            ((screenId === 'screen-now' || screenId === 'screen-airplay') ?
                ' now-active' : '') +
            (screenId === 'screen-connect' ? ' connect-active' : '');

        /*
         * The album tint is painted on `#backdrop` as well as the screen, so it
         * has to be taken back off when the screen is left — otherwise the
         * album colour would follow the user onto every other screen.
         */
        /*
         * The album tint belongs to the two stage screens only. It is remembered and
         * painted when one of them is shown, and cleared everywhere else; painting it
         * as soon as it was computed made the whole app change colour whenever a track
         * started from an album or search screen.
         */
        if (screenId === 'screen-airplay') {
            applyNowTint(airplayTint, 'screen-airplay');
        } else if (screenId === 'screen-now') {
            applyNowTint(state.nowTint, 'screen-now');
        } else {
            applyNowTint(null);
        }

        /* The nav pill only makes sense once a server is connected. */
        el.nav.className = (screenId === 'screen-connect' && !state.client) ? 'hidden' : '';

        focusFirst();
    }

    /*
     * Messages appear as a toast and fade after a few seconds. Routine ones that
     * only restate what is already on screen (Playing., Library loaded., counts)
     * are kept out of the way; errors stay longer.
     */
    var statusTimer = null;
    var QUIET_STATUS = /^(Playing\.|Library loaded\.|Now playing\.|Nothing playing yet\.|Connected to |\d+ (artist|playlist|track)\(s\)\.)/;

    function setStatus(message, isError) {
        var cls = 'status' + (isError ? ' error' : '');
        el.status.innerHTML = message || '';
        if (statusTimer) {
            global.clearTimeout(statusTimer);
            statusTimer = null;
        }
        if (!message || (!isError && QUIET_STATUS.test(message))) {
            el.status.className = cls;
            return;
        }
        el.status.className = cls + ' show';
        statusTimer = global.setTimeout(function () {
            el.status.className = cls;
        }, isError ? 8000 : 3500);
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

    /* ---------- Art loading and entrance motion ---------- */

    /*
     * Cover art goes in a child layer that starts transparent and fades in when the image has
     * actually loaded, instead of popping in half-drawn. `fadeInArt(root)` finds every layer
     * under `root` that still has a `data-src` and loads it.
     */
    function artLayer(url) {
        return '<span class="art-img" data-src="' + escapeHtml(url) + '"></span>';
    }

    var artQueue = [];
    var artActive = 0;
    var ART_PARALLEL = 3;

    /*
     * Covers load a few at a time rather than all at once, so decoding them (done on the main thread
     * of a TV's browser) is spread over many frames instead of landing in one. A cover whose card
     * has since been removed is skipped.
     */
    function pumpArt() {
        var node, url, img;
        while (artActive < ART_PARALLEL && artQueue.length) {
            node = artQueue.shift();
            if (!node.parentNode) {
                continue;
            }
            url = node.getAttribute('data-load');
            node.removeAttribute('data-load');
            artActive++;
            img = new Image();
            img.onload = (function (n, u) {
                return function () {
                    artActive--;
                    n.style.backgroundImage = 'url(\'' + u + '\')';
                    n.className += ' in';
                    pumpArt();
                };
            }(node, url));
            img.onerror = function () {
                artActive--;
                pumpArt();
            };
            img.src = url;
        }
    }

    function fadeInArt(root) {
        var nodes = root.querySelectorAll('.art-img[data-src]');
        var i;
        for (i = 0; i < nodes.length; i++) {
            nodes[i].setAttribute('data-load', nodes[i].getAttribute('data-src'));
            nodes[i].removeAttribute('data-src');
            artQueue.push(nodes[i]);
        }
        pumpArt();
    }

    /*
     * A cover that changes (player bar, Now Playing, AirPlay) keeps showing the old one until the
     * new image is ready, then fades up. A stale load for an earlier track is ignored.
     */
    function setCoverImage(node, url) {
        var img;
        if (!url) {
            node.removeAttribute('data-cover');
            node.style.backgroundImage = '';
            return;
        }
        if (node.getAttribute('data-cover') === url) {
            return;
        }
        node.setAttribute('data-cover', url);
        img = new Image();
        img.onload = function () {
            if (node.getAttribute('data-cover') !== url) {
                return;
            }
            node.style.backgroundImage = 'url(\'' + url + '\')';
            node.className = node.className.replace(/\s*fresh\b/g, '');
            void node.offsetWidth;
            node.className += ' fresh';
        };
        img.src = url;
    }

    /* Class and inline delay that make the Nth item of a list rise in after the one before it. */
    var CHUNK = 4;                /* cards added per tick when a page is appended */
    var ENTER_STEP_MS = 45;
    var ENTER_MAX = 10;

    function enterAttrs(n) {
        var ms;
        if (n >= ENTER_MAX) {
            return { cls: '', style: '' };
        }
        ms = n * ENTER_STEP_MS;
        return { cls: ' enter',
                 style: ' style="-webkit-animation-delay:' + ms + 'ms;animation-delay:' + ms + 'ms"' };
    }

    /* ---------- Connect ---------- */

    /*
     * Log in with token auth first, so the password never travels in a URL. A server
     * that refuses it with a Subsonic error (too old, or LDAP users) is retried once
     * with the legacy plaintext login, and that choice is remembered for next launch.
     * Network failures are not retried: a different login scheme cannot fix them.
     */
    function connect(url, user, pass, bridge) {
        var saved = loadConnection();
        var firstMode = (saved && saved.auth === 'plain' && saved.url === url) ? 'plain' : 'token';

        setStatus('Connecting to ' + url + ' ...', false);

        function attempt(mode) {
            var client = new Subsonic(url, user, pass, mode);
            client.ping(function (response) {
                state.client = client;
                state.homeLoadedAt = 0;
                saveConnection({ url: url, user: user, pass: pass, bridge: bridge || '', auth: client.auth });
                setAvatar(user);
                AirPlay.configure(bridge, url);
                AirPlay.start();
                resetSettingsForm();
                setStatus('Connected to ' + (response.version || 'server') + '.', false);
                loadHome(true);
            }, function (err) {
                if (mode === 'token' && err.api) {
                    attempt('plain');
                    return;
                }
                setStatus('Connection failed: ' + err.message, true);
            });
        }

        attempt(firstMode);
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
        favorites: { list: 'fav-list', items: [], kind: 'song', offset: 0,
                     exhausted: false, loading: false },
        top: { list: 'top-list', items: [], kind: 'song', offset: 0,
               exhausted: false, loading: false }
    };

    var SECTION_ORDER = ['recent', 'favorites', 'added', 'top'];
    var SECTION_TITLE = { recent: 'title-recent', favorites: 'title-favorites',
                          added: 'title-added', top: 'title-top' };

    /* How many items to request per page. */
    var PAGE_SIZE = 12;
    /* Start fetching the next page this many cards before the end of a row, not at the last card. */
    var PREFETCH_AHEAD = 6;

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

    /*
     * `keepAirPlay` is set on the first load after connecting: a cast can start
     * while the library is still loading, and the finished load must not pull
     * the user off the AirPlay screen it already switched to.
     */
    function loadHome(keepAirPlay) {
        var pending = SECTION_ORDER.length;
        var failed = false;

        setStatus('Loading your library ...', false);

        function done() {
            pending--;
            if (pending === 0 && !failed) {
                setStatus('Library loaded.', false);
                state.homeLoadedAt = new Date().getTime();
                if (keepAirPlay === true &&
                        $('screen-airplay').className.indexOf('active') >= 0) {
                    return;
                }
                show('screen-albums');
            }
        }

        function fail(err) {
            failed = true;
            setStatus('Could not load library: ' + err.message, true);
        }

        loadSection('recent', done, fail);
        /* A server without favorites support must not fail the whole home screen. */
        loadSection('favorites', done, done);
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

        if (key === 'favorites') {
            /* All starred songs arrive at once, newest first; paging slices the list. */
            if (section.pool) {
                receive(section.pool.slice(section.offset, section.offset + PAGE_SIZE));
                return;
            }
            state.client.getStarred(function (response) {
                var songs = (response.starred2 && response.starred2.song) || [];
                songs.sort(function (a, b) {
                    return String(b.starred || '').localeCompare(String(a.starred || ''));
                });
                section.pool = songs;
                receive(songs.slice(0, PAGE_SIZE));
            }, fail);
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
        var i, item, art, title, sub, enter, animate;

        if (!items.length) {
            listEl.innerHTML = '';
            updateHomeVisibility();
            return;
        }
        animate = !section.entered;
        section.entered = true;

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
                '<span class="art">' +
                    artLayer(state.client.coverArtUrl(item.coverArt, CARD_ART_SIZE)) + '</span>' :
                '<span class="art-fallback">&#9835;</span>';
            /* Rows rise in the first time they appear; a later rebuild (e.g. Recently Played) stays still. */
            enter = enterAttrs((animate && from === 0 && !lite) ? i : ENTER_MAX);

            if (section.kind === 'song') {
                title = item.title;
                sub = item.artist;
            } else {
                title = item.name;
                sub = item.artist;
            }

            html.push(
                '<li class="card' + enter.cls + '"' + enter.style +
                    ' data-list="' + key + '" data-index="' + i + '"' +
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
        appendCards(listEl, html, from === 0);
        updateHomeVisibility();
    }

    /*
     * A first render goes in at once. A later page is added a few cards at a time, a tick apart, so
     * the browser never has to lay out, paint and decode a dozen covers inside one frame (that was
     * the stall when a row reached its end and loaded more). A rebuild or a newer page makes any
     * chunks still waiting for an older one stop.
     */
    function appendCards(listEl, parts, immediate) {
        var token = (listEl.__token || 0) + 1;
        var at = 0;
        var t0 = new Date().getTime();

        listEl.__token = token;
        if (immediate || parts.length <= CHUNK) {
            listEl.insertAdjacentHTML('beforeend', parts.join(''));
            fadeInArt(listEl);
            if (new Date().getTime() - t0 > 150) {
                markSlow(1);
            }
            return;
        }
        (function step() {
            if (listEl.__token !== token) {
                return;
            }
            listEl.insertAdjacentHTML('beforeend', parts.slice(at, at + CHUNK).join(''));
            fadeInArt(listEl);
            at += CHUNK;
            if (at < parts.length) {
                global.setTimeout(step, 40);
            }
        }());
    }

    function setHidden(node, hidden) {
        if (!node || (node.className.indexOf('hidden') >= 0) === hidden) {
            return;                       /* an unchanged class would still restyle the page */
        }
        node.className = node.className.replace(/\s*hidden\b/g, '') + (hidden ? ' hidden' : '');
    }

    /*
     * A row with nothing in it (no history yet, no favorites) is hidden along with its
     * heading, instead of taking up space to say "Nothing here yet." If every row is
     * empty a single message is shown.
     */
    function updateHomeVisibility() {
        var any = false;
        var i, key, has;
        for (i = 0; i < SECTION_ORDER.length; i++) {
            key = SECTION_ORDER[i];
            has = SECTIONS[key].items.length > 0;
            any = any || has;
            setHidden($(SECTION_TITLE[key]), !has);
            setHidden($(SECTIONS[key].list), !has);
        }
        setHidden($('home-empty'), any || !state.homeLoadedAt);
    }

    /* After starring or unstarring, rebuild the Favorites row from the server. */
    function refreshFavorites() {
        var section = SECTIONS.favorites;
        section.items = [];
        section.offset = 0;
        section.exhausted = false;
        section.loading = false;
        section.pool = null;
        loadSection('favorites', updateHomeVisibility, function () {});
    }

    /* ---------- Album detail ---------- */

    /*
     * The art of a card flies to the album header's cover and, on Back, flies back to the card it
     * came from. It is a copy of the art moved with a transform (cheap on a TV), starting where
     * `from` is and ending on `to`; both are squares in viewport coordinates.
     */
    function flyArt(from, to, url, onDone) {
        var fly = document.createElement('div');
        var scale = from.width / to.width;

        fly.className = 'fly-art';
        fly.style.left = to.left + 'px';
        fly.style.top = to.top + 'px';
        fly.style.width = to.width + 'px';
        fly.style.height = to.height + 'px';
        fly.style.borderRadius = '12px';
        fly.style.backgroundImage = 'url(\'' + url + '\')';
        fly.style.webkitTransition = 'none';
        fly.style.transition = 'none';
        fly.style.webkitTransform = 'translate(' + (from.left - to.left) + 'px,' +
            (from.top - to.top) + 'px) scale(' + scale + ')';
        fly.style.transform = fly.style.webkitTransform;
        document.body.appendChild(fly);
        void fly.offsetWidth;
        fly.style.webkitTransition = '';
        fly.style.transition = '';
        fly.style.webkitTransform = 'translate(0px,0px) scale(1)';
        fly.style.transform = 'translate(0px,0px) scale(1)';
        global.setTimeout(function () {
            if (fly.parentNode) {
                fly.parentNode.removeChild(fly);
            }
            if (onDone) {
                onDone();
            }
        }, 450);
    }

    function inViewport(rect) {
        return rect.width > 0 && rect.top >= 0 && rect.left >= 0 &&
            rect.bottom <= global.innerHeight && rect.right <= global.innerWidth;
    }

    function setAlbumCover(url) {
        el.albumCover.style.backgroundImage = url ? 'url(\'' + url + '\')' : '';
    }

    /*
     * `sourceCard` is the card that was activated, when there is one; its art is what flies.
     * Without it (a search result, a song card) the album simply opens.
     */
    function openAlbum(album, returnTo, sourceCard) {
        var artEl, srcRect = null, coverUrl = '';
        if (!album) {
            return;
        }
        state.albumReturn = returnTo || 'screen-albums';
        state.albumSource = null;
        coverUrl = album.coverArt ? state.client.coverArtUrl(album.coverArt, CARD_ART_SIZE) : '';
        artEl = sourceCard && sourceCard.querySelector && !lite ? sourceCard.querySelector('.art') : null;
        if (artEl && coverUrl) {
            srcRect = artEl.getBoundingClientRect();
            if (!inViewport(srcRect)) {
                srcRect = null;
            } else {
                state.albumSource = {
                    list: sourceCard.getAttribute('data-list'),
                    id: sourceCard.getAttribute('data-id'),
                    url: coverUrl
                };
            }
        }
        setStatus('Loading ' + album.name + ' ...', false);

        state.client.getAlbum(album.id, function (response) {
            var songs = (response.album && response.album.song) || [];
            var toRect;
            state.songs = songs;
            state.currentIndex = -1;
            el.albumTitle.innerHTML = escapeHtml(album.name);
            el.albumArtist.innerHTML = escapeHtml(album.artist);
            renderSongs(songs);
            setAlbumCover(coverUrl);
            el.albumCover.className = 'album-cover' + (srcRect ? ' flying' : '');
            setStatus(songs.length + ' track(s).', false);
            $('screen-album').scrollTop = 0;
            show('screen-album');
            if (srcRect) {
                toRect = el.albumCover.getBoundingClientRect();
                flyArt(srcRect, toRect, coverUrl, function () {
                    el.albumCover.className = 'album-cover';
                });
            }
        }, function (err) {
            setStatus('Could not load album: ' + err.message, true);
        });
    }

    /*
     * Back from an album. If the album was opened from a card that is still on screen, the cover
     * flies back into that card's place and the card regains focus; otherwise it is a plain
     * return. The target is the card's focused size (it grows 7% and lifts 6 px), measured before
     * focus so the art lands exactly where the focus animation leaves it.
     */
    function leaveAlbum() {
        var src = state.albumSource;
        var returnTo = state.albumReturn;
        var cover = el.albumCover;
        var from, card, art, r, to;

        if (!src || !cover.style.backgroundImage || lite) {
            show(returnTo);
            return;
        }
        from = cover.getBoundingClientRect();
        show(returnTo);
        card = document.querySelector('.screen.active .card[data-list="' + src.list +
            '"][data-id="' + src.id + '"]');
        art = card ? card.querySelector('.art') : null;
        if (!art) {
            return;
        }
        r = art.getBoundingClientRect();
        if (!inViewport(r)) {
            focusNode(card);
            return;
        }
        to = { left: r.left - 0.035 * r.width, top: r.top - 0.035 * r.width - 6,
               width: r.width * 1.07, height: r.height * 1.07 };
        art.className += ' flying-hidden';
        focusNode(card);
        flyArt(from, to, src.url, function () {
            art.className = art.className.replace(/\s*flying-hidden\b/g, '');
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
            state.albumSource = null;
            setAlbumCover(response.album.coverArt ?
                state.client.coverArtUrl(response.album.coverArt, CARD_ART_SIZE) : '');
            el.albumCover.className = 'album-cover';
            $('screen-album').scrollTop = 0;
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
        var i, song, enter;

        if (!songs.length) {
            el.songList.innerHTML = '<li class="empty">No tracks in this album.</li>';
            return;
        }

        for (i = 0; i < songs.length; i++) {
            song = songs[i];
            enter = enterAttrs(i);
            html.push(
                '<li class="track' + enter.cls + '"' + enter.style + ' data-index="' + i + '"' +
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
    /*
     * Accented letters sort and group with their base letter ("Álvaro" under A,
     * "Ñengo Flow" under N) instead of falling into "#". String.normalize splits
     * a letter from its accent where the engine has it; the table covers the Latin
     * letters of older engines that lack it. Non-Latin scripts still go to "#".
     */
    var ACCENT_FROM = '\u00c0\u00c1\u00c2\u00c3\u00c4\u00c5\u00c7\u00c8\u00c9\u00ca\u00cb' +
        '\u00cc\u00cd\u00ce\u00cf\u00d1\u00d2\u00d3\u00d4\u00d5\u00d6\u00d8\u00d9\u00da\u00db\u00dc\u00dd' +
        '\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5\u00e7\u00e8\u00e9\u00ea\u00eb\u00ec\u00ed\u00ee\u00ef' +
        '\u00f1\u00f2\u00f3\u00f4\u00f5\u00f6\u00f8\u00f9\u00fa\u00fb\u00fc\u00fd\u00ff';
    var ACCENT_TO = 'AAAAAACEEEEIIIINOOOOOOUUUUY' + 'aaaaaaceeeeiiiinoooooouuuuyy';

    function stripAccents(text) {
        var out = String(text || '');
        var i, at;
        if (out.normalize) {
            out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        }
        /* Whatever survives (or everything, without normalize) goes through the table. */
        for (i = 0; i < out.length; i++) {
            at = ACCENT_FROM.indexOf(out.charAt(i));
            if (at >= 0) {
                out = out.slice(0, i) + ACCENT_TO.charAt(at) + out.slice(i + 1);
            }
        }
        return out;
    }

    function artistSortKey(name) {
        return stripAccents(name).replace(/^\s+/, '').toLowerCase();
    }

    /*
     * The index letter shown next to an artist and used for the A-Z strip.
     * Anything that does not start with a letter or digit is grouped under
     * "#", matching the convention Subsonic clients use.
     */
    function artistLetter(name) {
        var ch = stripAccents(name).replace(/^\s+/, '').charAt(0).toUpperCase();
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
                '<span class="artist-art">' +
                    artLayer(state.client.coverArtUrl(item.coverArt, 144)) + '</span>' :
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
        fadeInArt(el.artistList);
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
                                '<span class="art">' + artLayer(state.client.coverArtUrl(
                                    albums[i].coverArt, CARD_ART_SIZE)) + '</span>' :
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
                fadeInArt(el.artistAlbums);
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
                '<span class="playlist-art">' +
                    artLayer(state.client.coverArtUrl(item.coverArt, 144)) + '</span>' :
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
        fadeInArt(el.playlistList);
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
        var i, song, enter;

        if (!songs.length) {
            el.playlistSongs.innerHTML =
                '<li class="empty">This playlist is empty.</li>';
            return;
        }

        for (i = 0; i < songs.length; i++) {
            song = songs[i];
            enter = enterAttrs(i);
            html.push(
                '<li class="track' + enter.cls + '"' + enter.style + ' data-index="' + i + '"' +
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
                '<span class="result-art">' +
                    artLayer(state.client.coverArtUrl(item.data.coverArt, 144)) + '</span>' :
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
        fadeInArt(el.searchResults);
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

    function applyNowTint(tint, screenId) {
        var screen = $(screenId || 'screen-now');
        var backdrop = $('backdrop');
        var css;

        /* Only one of the two stage screens carries a tint at a time. */
        $('screen-now').style.background = '';
        $('screen-airplay').style.background = '';

        if (!tint) {
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

    function setNowTint(tint) {
        state.nowTint = tint;
        if ($('screen-now').className.indexOf('active') >= 0) {
            applyNowTint(tint, 'screen-now');
        }
    }

    function tintNowPlaying(song) {
        var seq = ++npTintSeq;
        var img;

        if (!song || !song.coverArt || !state.client) {
            setNowTint(null);
            return;
        }
        img = new Image();
        img.onload = function () {
            if (seq !== npTintSeq) {
                return;
            }
            setNowTint(tintFromImage(img));
        };
        img.onerror = function () {
            if (seq === npTintSeq) {
                setNowTint(null);
            }
        };
        img.src = state.client.coverArtUrl(song.coverArt, 96);
    }

    function renderNowPlaying() {
        var song = state.currentSong;
        renderFav();

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
            el.npCover.className = el.npCover.className.replace(/\s*empty\b/g, '');
            setCoverImage(el.npCover, state.client.coverArtUrl(song.coverArt, NP_ART_LARGE));
        } else {
            el.npCover.className = 'np-cover empty';
            setCoverImage(el.npCover, '');
        }
        tintNowPlaying(song);
        renderLyrics();
    }

    /*
     * Lyrics are plain text from the server, one line per row. The current
     * line is highlighted and the window is kept short so the block never
     * grows past the stage.
     */
    /*
     * The lyrics are built once per song as one long column. Moving to the next line does not
     * rewrite the text: it restyles the lines and slides the column so the current line sits
     * near the top of the block, which the CSS transition turns into a glide.
     */
    var LYRIC_ANCHOR = 72;       /* y of the current line inside the block (one line down) */

    function renderLyrics() {
        var lines = state.now.lyrics;
        var current = state.now.line;
        var html = [];
        var track, nodes, i, fresh = false;

        if (!lines.length) {
            el.npLyrics.className = 'np-lyrics';
            el.npLyrics.innerHTML = '<p class="np-line current">' +
                escapeHtml(state.currentSong ? state.currentSong.title : '') +
                '</p>';
            state.now.built = -1;
            return;
        }

        if (state.now.built !== state.now.seq) {
            for (i = 0; i < lines.length; i++) {
                html.push('<p class="np-line">' + escapeHtml(lines[i].text) + '</p>');
            }
            el.npLyrics.className = 'np-lyrics has-track';
            el.npLyrics.innerHTML = '<div class="np-lyrics-track">' + html.join('') + '</div>';
            state.now.built = state.now.seq;
            fresh = true;
        }

        track = el.npLyrics.firstChild;
        nodes = track.childNodes;
        if (current < 0) {
            current = 0;
        }
        for (i = 0; i < nodes.length; i++) {
            setClassIf(nodes[i], 'np-line' +
                (i === current ? ' current' : (i < current ? ' past' : '')));
        }
        if (!nodes[current]) {
            return;
        }
        if (fresh) {
            /* A new song starts in place; only later lines glide. */
            track.style.webkitTransition = 'none';
            track.style.transition = 'none';
        }
        track.style.webkitTransform = 'translateY(' + (LYRIC_ANCHOR - nodes[current].offsetTop) + 'px)';
        track.style.transform = 'translateY(' + (LYRIC_ANCHOR - nodes[current].offsetTop) + 'px)';
        if (fresh) {
            void track.offsetWidth;
            track.style.webkitTransition = '';
            track.style.transition = '';
        }
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
    /*
     * `pos` is the song's place in the shuffled order when it was reached by walking
     * that order; a track picked by hand starts a fresh shuffle from itself.
     */
    function playIndex(index, pos) {
        var song = state.songs[index];
        var rows, i;
        if (!song) {
            return;
        }

        state.currentIndex = index;
        state.currentSong = song;
        if (state.shuffle) {
            if (typeof pos === 'number') {
                state.orderPos = pos;
            } else {
                buildOrder(index);
            }
        }
        /* Starting a Subsonic track takes the TV from any AirPlay cast right away. */
        AirPlay.release();
        el.audio.src = state.client.streamUrl(song.id);
        el.audio.play();

        /* Tell the server what is playing; the "played" call follows at the halfway mark. */
        state.playedMs = 0;
        state.lastTickAt = 0;
        state.scrobbled = false;
        state.client.scrobble(song.id, false);

        /* Feed the Recently Played row. */
        recordPlay(song);

        /* Title, art and play state in the player bar. */
        renderBar();

        /* Reset the seeker so the previous track's progress does not linger. */
        resetSeekerDisplay();
        renderNowPlaying();
        loadLyrics(song);
        if (queueOpen()) {
            refreshQueue();
        }

        rows = el.songList.querySelectorAll('.track');
        for (i = 0; i < rows.length; i++) {
            rows[i].className = rows[i].className.replace(/\s*playing/, '');
        }
        if (rows[index]) {
            rows[index].className += ' playing';
        }
    }

    /* ---------- Shuffle and repeat ---------- */

    function loadPlayMode() {
        var mode;
        try {
            mode = JSON.parse(global.localStorage.getItem(PLAYMODE_KEY));
        } catch (e) {
            mode = null;
        }
        state.shuffle = !!(mode && mode.shuffle);
        state.repeat = (mode && (mode.repeat === 'all' || mode.repeat === 'one')) ? mode.repeat : 'off';
    }

    function savePlayMode() {
        try {
            global.localStorage.setItem(PLAYMODE_KEY,
                JSON.stringify({ shuffle: state.shuffle, repeat: state.repeat }));
        } catch (e) {
            /* localStorage may be unavailable; non-fatal */
        }
    }

    /*
     * A shuffled order is a random permutation of the queue. `start` (an index) is
     * placed first, so switching shuffle on, or picking a track, continues from it.
     */
    function buildOrder(start) {
        var n = state.songs.length;
        var idx = [];
        var i, j, tmp;

        for (i = 0; i < n; i++) {
            if (i !== start) {
                idx.push(i);
            }
        }
        for (i = idx.length - 1; i > 0; i--) {
            j = Math.floor(Math.random() * (i + 1));
            tmp = idx[i];
            idx[i] = idx[j];
            idx[j] = tmp;
        }
        state.order = (typeof start === 'number' && start >= 0) ? [start].concat(idx) : idx;
        state.orderPos = 0;
    }

    /*
     * The track after the current one, as { index, pos } or null at the end of the
     * queue. `auto` is true when the previous track ended by itself: only then does
     * repeat-one replay it. The Next button (or skipping a broken track) moves on.
     */
    function nextTrack(auto) {
        var n = state.songs.length;
        var cur = state.currentIndex;
        var tmp;

        if (!n) {
            return null;
        }
        if (auto && state.repeat === 'one' && cur >= 0) {
            return { index: cur, pos: state.shuffle ? state.orderPos : undefined };
        }
        if (state.shuffle) {
            if (state.order.length !== n || state.order[state.orderPos] !== cur) {
                buildOrder(cur);
            }
            if (state.orderPos + 1 < state.order.length) {
                return { index: state.order[state.orderPos + 1], pos: state.orderPos + 1 };
            }
            if (state.repeat !== 'off') {
                buildOrder(-1);                      /* every track played: reshuffle */
                if (n > 1 && state.order[0] === cur) {
                    tmp = state.order[0];
                    state.order[0] = state.order[1];
                    state.order[1] = tmp;            /* never repeat the same track back to back */
                }
                return { index: state.order[0], pos: 0 };
            }
            return null;
        }
        if (cur + 1 < n) {
            return { index: cur + 1 };
        }
        return state.repeat !== 'off' ? { index: 0 } : null;
    }

    function prevTrack() {
        if (state.shuffle) {
            if (state.orderPos > 0 && state.order[state.orderPos] === state.currentIndex) {
                return { index: state.order[state.orderPos - 1], pos: state.orderPos - 1 };
            }
            return null;
        }
        return state.currentIndex > 0 ? { index: state.currentIndex - 1 } : null;
    }

    /* Button handlers receive the click event, so only a literal `true` means "ended by itself". */
    function playNext(auto) {
        var next;
        if (auto !== true && airplaySourceActive()) {
            return;                       /* the phone controls a cast's queue */
        }
        next = nextTrack(auto === true);
        if (next) {
            playIndex(next.index, next.pos);
        }
    }

    function playPrev() {
        var prev;
        if (airplaySourceActive()) {
            return;
        }
        prev = prevTrack();
        if (prev) {
            playIndex(prev.index, prev.pos);
        }
    }

    function toggleShuffle() {
        state.shuffle = !state.shuffle;
        if (state.shuffle && state.currentIndex >= 0) {
            buildOrder(state.currentIndex);
        }
        savePlayMode();
        renderPlayMode();
        if (queueOpen()) {
            refreshQueue();
        }
    }

    function cycleRepeat() {
        state.repeat = state.repeat === 'off' ? 'all' : (state.repeat === 'all' ? 'one' : 'off');
        savePlayMode();
        renderPlayMode();
        if (queueOpen()) {
            refreshQueue();
        }
    }

    var REPEAT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>';
    var REPEAT_ONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z"/></svg>';

    function renderPlayMode() {
        el.npShuffle.className = state.shuffle ? 'on' : '';
        el.npShuffle.setAttribute('aria-label', state.shuffle ? 'Shuffle on' : 'Shuffle off');
        el.npRepeat.className = state.repeat === 'off' ? '' : 'on';
        el.npRepeat.innerHTML = state.repeat === 'one' ? REPEAT_ONE_ICON : REPEAT_ICON;
        el.npRepeat.setAttribute('aria-label', state.repeat === 'one' ? 'Repeat one' :
            (state.repeat === 'all' ? 'Repeat all' : 'Repeat off'));
    }

    /* ---------- Favorites ---------- */

    var HEART_FILLED = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';
    var HEART_OUTLINE = 'M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z';

    function renderFav() {
        var song = state.currentSong;
        var on = !!(song && song.starred);
        $('np-fav-path').setAttribute('d', on ? HEART_FILLED : HEART_OUTLINE);
        $('np-fav-label').innerHTML = on ? 'Favorited' : 'Favorite';
        el.npFav.className = on ? 'on' : '';
        el.npFav.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
    }

    /* Star or unstar the playing track on the server; the heart flips at once and rolls back on failure. */
    function toggleFavorite() {
        var song = state.currentSong;
        var on;
        if (!song || !state.client) {
            setStatus('Play a song first.', false);
            return;
        }
        on = !song.starred;
        if (on) {
            song.starred = new Date().toISOString();
        } else {
            delete song.starred;
        }
        renderFav();
        state.client.star(song.id, on, function () {
            refreshFavorites();
            setStatus(on ? 'Added to favorites.' : 'Removed from favorites.', false);
        }, function (err) {
            if (on) {
                delete song.starred;
            } else {
                song.starred = new Date().toISOString();
            }
            renderFav();
            setStatus('Could not update favorite: ' + err.message, true);
        });
    }

    /* ---------- Up Next ---------- */

    /*
     * What will play after the current track, in the order it will play: the shuffled
     * order when shuffle is on, otherwise the rest of the queue (and, with repeat-all,
     * the start of it again). Each item is { index, pos } like nextTrack().
     */
    function upNext() {
        var n = state.songs.length;
        var cur = state.currentIndex;
        var items = [];
        var i;

        if (!n || cur < 0) {
            return items;
        }
        if (state.shuffle) {
            if (state.order.length === n && state.order[state.orderPos] === cur) {
                for (i = state.orderPos + 1; i < n; i++) {
                    items.push({ index: state.order[i], pos: i });
                }
            }
        } else {
            for (i = cur + 1; i < n; i++) {
                items.push({ index: i });
            }
            if (state.repeat === 'all') {
                for (i = 0; i < cur; i++) {
                    items.push({ index: i });
                }
            }
        }
        return items.slice(0, 60);
    }

    function queueOpen() {
        return $('screen-now').className.indexOf('queue-open') >= 0;
    }

    function queueRows() {
        return $('queue-list').querySelectorAll('.queue-row');
    }

    function renderQueue() {
        var items = upNext();
        var html = [];
        var i, song;

        if (!items.length) {
            $('queue-list').innerHTML = '<li class="queue-empty">' +
                (state.repeat === 'one' ? 'Repeating this track.' : 'Nothing queued after this track.') + '</li>';
            return;
        }
        for (i = 0; i < items.length; i++) {
            song = state.songs[items[i].index];
            html.push('<li class="queue-row" tabindex="0" data-index="' + items[i].index + '"' +
                (typeof items[i].pos === 'number' ? ' data-pos="' + items[i].pos + '"' : '') + '>' +
                '<span class="q-title">' + escapeHtml(song.title) + '</span>' +
                '<span class="q-artist">' + escapeHtml(song.artist) + '</span>' +
                '<span class="q-dur">' + formatDuration(song.duration) + '</span></li>');
        }
        $('queue-list').innerHTML = html.join('');
    }

    /* Re-render after the queue changed under the user, keeping focus inside the list if it was there. */
    function refreshQueue() {
        var hadFocus = document.activeElement &&
            document.activeElement.className.indexOf('queue-row') >= 0;
        var first;
        renderQueue();
        if (hadFocus) {
            first = queueRows()[0];
            focusNode(first || el.npQueue);
        }
    }

    function toggleQueue(open) {
        var screen = $('screen-now');
        var on = typeof open === 'boolean' ? open : !queueOpen();
        var first;

        screen.className = screen.className.replace(/\s*queue-open\b/g, '') + (on ? ' queue-open' : '');
        setHidden($('np-queuepanel'), !on);
        el.npQueue.className = on ? 'on' : '';
        if (on) {
            renderQueue();
            first = queueRows()[0];
            if (first) {
                focusNode(first);
            }
        }
    }

    function playQueueRow(row) {
        var pos = row.getAttribute('data-pos');
        playIndex(parseInt(row.getAttribute('data-index'), 10), pos === null ? undefined : parseInt(pos, 10));
    }

    function isNowExtra(node) {
        return !!(node && (node.id === 'np-fav' || node.id === 'np-queue'));
    }

    /* The Now Playing screen's own buttons (they carry no class, only an id). */
    function isNowAction(node) {
        return !!(node && /^np-(shuffle|prev|play|next|repeat)$/.test(node.id));
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

    /* Played time counts only while the track really plays, so seeking cannot fake a play. */
    function trackPlayTime() {
        var now = new Date().getTime();
        if (state.lastTickAt && !el.audio.paused && now - state.lastTickAt < 2000) {
            state.playedMs += now - state.lastTickAt;
        }
        state.lastTickAt = now;
    }

    /* A track counts as played after half its length (at most 4 minutes), per the Subsonic convention. */
    function maybeScrobble() {
        var duration, needed;
        if (state.scrobbled || !state.currentSong || !state.client) {
            return;
        }
        duration = seekerDuration();
        needed = duration > 0 ? Math.max(10, Math.min(240, duration / 2)) : 60;
        if (state.playedMs / 1000 >= needed) {
            state.scrobbled = true;
            state.client.scrobble(state.currentSong.id, true, new Date().getTime());
        }
    }

    /* Write to the page only when the value changed. */
    function setTextIf(node, text) {
        if (node.__text !== text) {
            node.__text = text;
            node.innerHTML = text;
        }
    }

    function setWidthIf(node, pct) {
        var w = (Math.round(pct * 5) / 5) + '%';
        if (node.__width !== w) {
            node.__width = w;
            node.style.width = w;
        }
    }

    /* Back to 0:00, through the same helpers so their cache of what is on screen stays true. */
    function resetSeekerDisplay() {
        setWidthIf(el.seekFill, 0);
        setTextIf(el.seekElapsed, '0:00');
        setTextIf(el.seekTotal, '0:00');
        setWidthIf(el.npSeekFill, 0);
        setTextIf(el.npElapsed, '0:00');
        setTextIf(el.npTotal, '0:00');
    }

    function updateSeeker() {
        var audio = el.audio;
        trackPlayTime();
        maybeScrobble();
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
        setTextIf(el.seekTotal, total);
        setTextIf(el.seekElapsed, elapsed);
        setWidthIf(el.seekFill, pct);

        /* The Now Playing screen mirrors the same state on its own bar. */
        setTextIf(el.npTotal, total);
        setTextIf(el.npElapsed, elapsed);
        setWidthIf(el.npSeekFill, pct);

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

    /* The cover on Now Playing / AirPlay shrinks while paused and swells back on play. */
    function setPausedClass(id, paused) {
        var node = $(id);
        if ((node.className.indexOf('paused') >= 0) === paused) {
            return;
        }
        node.className = node.className.replace(/\s*paused\b/g, '') + (paused ? ' paused' : '');
    }

    function setPlayIcon(playing) {
        var label = playing ? 'Pause' : 'Play';
        /* The bar redraws every second; rebuilding two SVG buttons each time is pure waste. */
        if (state.playIcon === playing) {
            return;
        }
        state.playIcon = playing;
        setPausedClass('screen-now', !playing);
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
            /* A Subsonic track took over; stop listening to the AirPlay stream. */
            AirPlay.release();
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
            state.failStreak = 0;
            setStatus('Playing.', false);
            startSeekerTimer();
        }, false);

        /* `stalled` fires during normal buffering; real failures arrive as `error`. */
        audio.addEventListener('stalled', function () {
            setStatus('Waiting for data ...', false);
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
            skipAfterError(reason);
            setPlayIcon(false);
            stopSeekerTimer();
            resetSeekerDisplay();
        }, false);

        audio.addEventListener('ended', function () {
            stopSeekerTimer();
            playNext(true);
        }, false);
    }

    /*
     * A track that cannot play should not stop the queue. Move on after a moment, but
     * give up after a few failures in a row (server down, nothing will play) instead
     * of cycling through the whole album.
     */
    function skipAfterError(reason) {
        var failed = state.currentSong;
        state.failStreak++;
        if (state.failStreak >= MAX_FAIL_STREAK || !nextTrack(false)) {
            return;
        }
        setStatus(reason + ' Skipping ...', true);
        global.setTimeout(function () {
            if (state.currentSong === failed && el.audio.error) {
                playNext(false);
            }
        }, 1500);
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
    /*
     * Scroll an element's scrollTop/scrollLeft to `to` with an ease-out instead of jumping.
     * Each call replaces any animation already running on the same element and property,
     * so holding an arrow key keeps retargeting smoothly. `from` lets the caller say where
     * the scroll was before the browser's own focus scrolling moved it.
     */
    var SCROLL_MS = 280;
    var SMOOTH_KEY = 'subtizen.smoothscroll';
    var LITE_KEY = 'subtizen.lite';

    /*
     * A glide only helps if frames keep up. On a slow TV each step repaints a whole row of cards
     * and the glide turns into stutter, so it measures itself: if the first steps arrive late, it
     * switches itself off (and remembers that) and scrolling is instant again, as before.
     */
    var smoothScroll = true;
    try {
        smoothScroll = global.localStorage.getItem(SMOOTH_KEY) !== 'off';
    } catch (e) {
        smoothScroll = true;
    }

    /*
     * Lite mode: when the device shows it cannot keep up, the optional motion goes (glide, background
     * tint, art fades, entrance and flight animations) and the app behaves like the plain version.
     * It is switched on by evidence (a stuttering scroll, or two slow list renders) and remembered.
     * `localStorage.removeItem('subtizen.lite')` and reload turns the motion back on.
     */
    var lite = false;
    var slowScore = 0;
    try {
        lite = global.localStorage.getItem(LITE_KEY) === 'on';
    } catch (e2) {
        lite = false;
    }
    if (lite) {
        smoothScroll = false;
    }

    function enableLite() {
        if (lite) {
            return;
        }
        lite = true;
        smoothScroll = false;
        try {
            global.localStorage.setItem(LITE_KEY, 'on');
            global.localStorage.setItem(SMOOTH_KEY, 'off');
        } catch (e) {
            /* non-fatal */
        }
        setBodyFlag('lite', true);
    }

    function markSlow(weight) {
        slowScore += weight;
        if (slowScore >= 2) {
            enableLite();
        }
    }

    function disableSmoothScroll() {
        markSlow(2);
    }
    var ROW_PAD = 36;                   /* matches `.grid { padding: ... 36px }` */

    /*
     * Timers, not requestAnimationFrame: frames are paused when the page is hidden and can be
     * throttled by a TV's browser, which would leave a scroll stuck half-way. ~60 steps a
     * second is smooth enough for a 280 ms glide.
     */
    function frameLater(fn) {
        global.setTimeout(fn, 16);
    }

    function animateScroll(elm, prop, to, from) {
        var key = '__anim_' + prop;
        var start = new Date().getTime();
        var token;

        if (typeof from !== 'number') {
            from = elm[prop];
        }
        to = Math.round(to);
        if (!smoothScroll) {
            elm[prop] = to;
            return;
        }
        if (Math.abs(to - from) < 2) {
            /*
             * Nothing to scroll for this focus. If an earlier move is still gliding, leave it
             * alone (a Left/Right press must not freeze a vertical scroll half-way).
             */
            if (!elm[key + '_on']) {
                elm[prop] = to;
            }
            return;
        }

        elm[key] = (elm[key] || 0) + 1;
        token = elm[key];
        elm[key + '_on'] = true;
        elm[prop] = from;

        /* Whatever happens to the stepping, the scroll always ends exactly on target. */
        global.setTimeout(function () {
            if (elm[key] === token && elm[key + '_on']) {
                elm[prop] = to;
                elm[key + '_on'] = false;
            }
        }, SCROLL_MS + 90);

        var steps = 0, late = 0, lastAt = start;

        function frame() {
            var t, eased, now;
            if (elm[key] !== token) {
                return;                 /* a newer scroll took over */
            }
            now = new Date().getTime();
            if (steps > 0 && now - lastAt > 45) {
                late++;
            }
            lastAt = now;
            steps++;
            if (steps >= 4 && late >= 3) {
                /* Under ~22 frames a second: give up on gliding on this device. */
                disableSmoothScroll();
                elm[prop] = to;
                elm[key + '_on'] = false;
                return;
            }
            t = Math.min(1, (now - start) / SCROLL_MS);
            eased = 1 - Math.pow(1 - t, 3);
            elm[prop] = Math.round(from + (to - from) * eased);
            if (t < 1) {
                frameLater(frame);
            } else {
                elm[key + '_on'] = false;
            }
        }
        frame();
    }

    function revealInScreen(node, screen) {
        var r = node.getBoundingClientRect();
        var s = screen.getBoundingClientRect();
        var margin = 20;
        var delta = 0;

        if (r.top < s.top + margin) {
            delta = r.top - (s.top + margin);
        } else if (r.bottom > s.bottom - margin) {
            delta = r.bottom - (s.bottom - margin);
        }
        if (delta) {
            screen.scrollTop += delta;
        }
    }

    function focusNode(node) {
        var screen = node.parentNode;
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

        /*
         * Walk up by parentNode, not offsetParent: `.screen` is not positioned,
         * so it is never an offsetParent, and the chain from a card reaches
         * `#app` (whose own offsetParent is null) without ever passing through
         * the screen. Found before focusing so its scroll position can be recorded.
         */
        while (screen && (!screen.className ||
                screen.className.indexOf('screen') < 0)) {
            screen = screen.parentNode;
        }
        node.focus();
        rememberRowPosition(node);

        if (!screen || !screen.className) {
            return;
        }

        /*
         * The browser's focus-reveal scrolls the nearest scrollable ancestor,
         * which is the screen. That drags every row sideways together, so the
         * screen is pinned and the row is scrolled by hand instead.
         */
        screen.scrollLeft = 0;

        /*
         * Keep the focused element inside the screen with a 20 px margin, judged from where it
         * actually is now (after whatever scrolling the browser did itself). That makes the result
         * the same whichever of us scrolled first, and running it twice changes nothing, so the
         * list cannot be pushed one way by us and pulled back by the browser. It runs again on the
         * next tick for engines that do their own focus scrolling after this function returns.
         */
        revealInScreen(node, screen);
        global.setTimeout(function () {
            revealInScreen(node, screen);
        }, 0);

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
         * already been shifted by the browser's scroll and is scaled while
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
        /* The row has ROW_PAD of padding before its first card, so a card sits ROW_PAD further in. */
        var rowLeft = ROW_PAD + index * step;
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
            var to;

            if (rowLeft < rowViewLeft + 20) {
                to = Math.max(0, rowLeft - ROW_PAD);
            } else if (rowRight > rowViewRight - 20) {
                /* Scroll just far enough to reveal the card, not a page. */
                to = rowRight - row.clientWidth + ROW_PAD;
            } else {
                to = rowViewLeft;
            }
            animateScroll(row, 'scrollLeft', to, rowViewLeft);
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
        /*
         * Used to slide the whole row in (opacity + transform on a container holding every card and its
         * shadow), which is among the most expensive things the page did when moving between rows. The
         * focus transform on the card itself is all the motion that move needs.
         */
        return;
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
        var nodes, i;
        if ($('screen-now').className.indexOf('active') >= 0 && el.npPlay) {
            focusNode(el.npPlay);           /* the first button is now Shuffle; start on Play */
            return;
        }
        nodes = focusables();
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
            if (delta > 0 && target >= cards.length - PREFETCH_AHEAD) {
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
    /*
     * Each row keeps its own place. Going down from one row and back up used to put focus on the
     * same *column* of the row above rather than on the card you had been at, so browsing a few
     * cards in the next row and returning lost your position.
     */
    function rememberRowPosition(node) {
        var list = node.getAttribute ? node.getAttribute('data-list') : null;
        var index = node.getAttribute ? parseInt(node.getAttribute('data-index'), 10) : NaN;
        if (list && !isNaN(index)) {
            state.rowMemory[list] = index;
        }
    }

    function neighbourGrid(currentList, delta, column) {
        var lists = SECTION_ORDER;
        var pos = -1;
        var i, cards, index, remembered;
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
        /* Rows with no cards (hidden because empty) are skipped, not treated as the end. */
        pos += delta;
        while (pos >= 0 && pos < lists.length) {
            cards = visible(document.querySelectorAll(
                '.screen.active .card[data-list="' + lists[pos] + '"]'
            ));
            if (cards.length) {
                /* A row you have been in before comes back at the card you left it on. */
                remembered = state.rowMemory[lists[pos]];
                if (typeof remembered === 'number' && cards[remembered]) {
                    return [cards[remembered]];
                }
                if (typeof column === 'number' && column > 0) {
                    index = column < cards.length ? column : cards.length - 1;
                    return [cards[index]];
                }
                return cards;
            }
            pos += delta;
        }
        return null;
    }

    /* The nav bar buttons, in visual order, for the Up handoff. */
    /* Tabs, the avatar and the theme button are all `.tab` buttons inside #nav. */
    function isNavControl(node) {
        return !!(node && node.className && /(^|\s)tab(\s|$)/.test(node.className) &&
            node.parentNode && (node.parentNode.id === 'nav' ||
            (node.parentNode.parentNode && node.parentNode.parentNode.id === 'nav')));
    }

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

    /*
     * The row next to the focused one, found directly. The lists can be hundreds of rows long, and
     * scanning every row (and reading each one's layout) on every key press was a cost the keys
     * should not pay. Returns null when `node` is not a row of `list` or there is no neighbour.
     */
    function neighbourRow(node, list, delta) {
        var sib;
        if (!node || node.parentNode !== list) {
            return undefined;
        }
        sib = delta > 0 ? node.nextElementSibling : node.previousElementSibling;
        return sib && sib.tabIndex >= 0 ? sib : null;
    }

    function moveArtistList(delta) {
        var next = neighbourRow(document.activeElement, el.artistList, delta);
        var rows, index, target;

        if (next) {
            focusNode(next);
            return;
        }
        if (next === null) {
            if (delta < 0) {
                /* Above the first artist is the A-Z strip. */
                focusArtistIndex();
            }
            return;
        }
        rows = artistRows();
        index = indexIn(rows, document.activeElement);

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
        var next = neighbourRow(document.activeElement, el.playlistList, delta);
        var rows, index, target;

        if (next) {
            focusNode(next);
            return;
        }
        if (next === null) {
            if (delta < 0) {
                /* Above the first playlist is the nav bar. */
                focusNav();
            }
            return;
        }
        rows = playlistRows();
        index = indexIn(rows, document.activeElement);

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
        var next = neighbourRow(document.activeElement, el.playlistSongs, delta);
        var rows, index, target;

        if (next) {
            focusNode(next);
            return;
        }
        if (next === null) {
            return;
        }
        rows = visible(el.playlistSongs.querySelectorAll('.track'));
        index = indexIn(rows, document.activeElement);

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
        var i;
        /*
         * Land on the tab for the screen the user is on, so going up from Search
         * reaches Search and Left/Right walk away from there. Fall back to the first
         * real tab (the avatar, for settings, sits one step left of it).
         */
        for (i = 0; i < nodes.length; i++) {
            if (nodes[i].getAttribute('data-tab') && nodes[i].className.indexOf('active') >= 0) {
                focusNode(nodes[i]);
                return true;
            }
        }
        for (i = 0; i < nodes.length; i++) {
            if (nodes[i].getAttribute('data-tab')) {
                focusNode(nodes[i]);
                return true;
            }
        }
        if (nodes.length) {
            focusNode(nodes[0]);
            return true;
        }
        return false;
    }

    /* Walk the Now Playing transport buttons, wrapping at the ends. */
    function moveNowActions(delta) {
        var nodes = [el.npShuffle, el.npPrev, el.npPlay, el.npNext, el.npRepeat];
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
                openAlbum(item, 'screen-artist', card);
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
            openAlbum(item, undefined, card);
        }
    }

    /* Global D-pad handling: arrows move focus, Enter activates. */
    function bindRemote() {
        document.addEventListener('keydown', function (event) {
            var key = event.keyCode;
            var target = document.activeElement;
            var cards, next, rowsQ, idxQ;

            /*
             * A list handler already acted on this keypress. Activating a card
             * can move focus onto a button on the screen it opens, and acting
             * again here would fire that button with the same key.
             */
            if (event.__subtizenHandled) {
                return;
            }

            /*
             * The nav bar behaves the same on every screen. Each screen below walks its
             * own content with the arrow keys (the search keyboard, the A-Z strip, ...) and
             * used to take Left/Right/Up while a tab was focused, which threw focus back into
             * the content or onto the first tab. Left/Right move along the bar and Up stays;
             * Down and Back are still decided by the screen.
             */
            if (isNavControl(target)) {
                if (key === 37 || key === 39) {
                    event.preventDefault();
                    moveNav(key === 39 ? 1 : -1);
                    return;
                }
                if (key === 38) {
                    event.preventDefault();
                    return;
                }
                if (key === 13 || key === 29443) {
                    event.preventDefault();
                    target.click();
                    return;
                }
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
             * The connect form doubles as the settings screen once connected.
             * Up/Down walk the fields, and Back returns to where it came from.
             */
            if ($('screen-connect').className.indexOf('active') >= 0 && state.client) {
                if (key === 10009 || key === 461) {
                    event.preventDefault();
                    closeSettings();
                    return;
                }
            }

            /*
             * The AirPlay screen has a single button (mute/unmute the stream),
             * so the D-pad mostly moves between it and the nav bar.
             */
            if ($('screen-airplay').className.indexOf('active') >= 0) {
                if (key === 37 || key === 39) {
                    event.preventDefault();
                    if (target && target.className.indexOf('tab') >= 0) {
                        moveNav(key === 39 ? 1 : -1);
                    }
                } else if (key === 38) {
                    event.preventDefault();
                    focusNav();
                } else if (key === 40) {
                    event.preventDefault();
                    focusNode(el.apPlay);
                } else if (key === 13 || key === 29443) {
                    if (target && target.tagName === 'BUTTON') {
                        event.preventDefault();
                        target.click();
                    }
                } else if (key === 10009 || key === 461) {
                    event.preventDefault();
                    if (target && target.id === 'ap-play') {
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
                /* Up Next list: Up/Down walk it, Enter plays a track, Back closes it. */
                if (target && target.className.indexOf('queue-row') >= 0) {
                    rowsQ = queueRows();
                    idxQ = indexIn(rowsQ, target);
                    if (key === 38 || key === 40) {
                        event.preventDefault();
                        if (key === 38 && idxQ === 0) {
                            focusNode(el.npQueue);
                        } else if (rowsQ[idxQ + (key === 40 ? 1 : -1)]) {
                            focusNode(rowsQ[idxQ + (key === 40 ? 1 : -1)]);
                        }
                    } else if (key === 13 || key === 29443) {
                        event.preventDefault();
                        playQueueRow(target);
                    } else if (key === 10009 || key === 461) {
                        event.preventDefault();
                        toggleQueue(false);
                        focusNode(el.npQueue);
                    }
                    return;
                }
                /* Favorite and Up Next sit in a row under the cover, above the transport buttons. */
                if (isNowExtra(target)) {
                    event.preventDefault();
                    if (key === 37 || key === 39) {
                        focusNode(target === el.npFav ? el.npQueue : el.npFav);
                    } else if (key === 38 || key === 10009 || key === 461) {
                        focusNav();
                    } else if (key === 40) {
                        if (target === el.npQueue && queueOpen() && queueRows().length) {
                            focusNode(queueRows()[0]);
                        } else {
                            focusNode(el.npPlay);
                        }
                    } else if (key === 13 || key === 29443) {
                        target.click();
                    }
                    return;
                }
                if (key === 37 || key === 39) {
                    event.preventDefault();
                    moveNowActions(key === 39 ? 1 : -1);
                } else if (key === 38) {
                    event.preventDefault();
                    focusNode(el.npFav);
                } else if (key === 40) {
                    event.preventDefault();
                    if (!isNowAction(target)) {
                        focusNode(el.npPlay);
                    }
                } else if (key === 13 || key === 29443) {
                    if (target && isNowAction(target)) {
                        event.preventDefault();
                        target.click();
                    }
                } else if (key === 10009 || key === 461) {
                    event.preventDefault();
                    if (target && isNowAction(target)) {
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
                    if (key === 38 && target && target.className.indexOf('index-letter') >= 0) {
                        /* Up from the A-Z strip reaches the nav bar (it used to jump into the list). */
                        focusNav();
                    } else {
                        moveArtistList(key === 40 ? 1 : -1);
                    }
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
                    } else if (target && target.className.indexOf('index-letter') >= 0) {
                        /* ... and out of the strip to the nav bar, as on the other screens. */
                        focusNav();
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
                } else if ((next = neighbourRow(target, el.songList, key === 40 ? 1 : -1))) {
                    focusNode(next);
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
                    leaveAlbum();
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

    function airplayOwnsPlayback() {
        return airplaySourceActive();
    }

    function togglePlayPause() {
        if (airplayOwnsPlayback()) {
            AirPlay.toggle();
            return;
        }
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

            /*
             * While an AirPlay cast owns the audio, play/pause/stop mute and
             * unmute the stream on the TV. Skipping and seeking belong to the
             * phone, so those keys are ignored rather than moving the album
             * queue underneath the cast.
             */
            if (airplayOwnsPlayback()) {
                if (action === 'play' || action === 'pause' ||
                        action === 'toggle' || action === 'stop') {
                    AirPlay.toggle();
                }
                return;
            }

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

    /* ---------- Player bar ---------- */

    function setBodyFlag(name, on) {
        var has = (' ' + document.body.className + ' ').indexOf(' ' + name + ' ') >= 0;
        if (has === on) {
            return;                       /* rewriting the class would restyle the whole page */
        }
        document.body.className = document.body.className
            .replace(new RegExp('(^|\\s)' + name + '(?=\\s|$)', 'g'), '') + (on ? ' ' + name : '');
    }

    function setClassIf(node, cls) {
        if (node.className !== cls) {
            node.className = cls;
        }
    }

    /* True while an AirPlay cast is the thing playing on the TV (not displaced by a Subsonic track). */
    function airplaySourceActive() {
        var snap = AirPlay.snapshot();
        return !!(snap.reachable && snap.status && snap.status.state !== 'idle' && !snap.suppressed);
    }

    function setBarArt(url) {
        if (url) {
            el.npArt.className = el.npArt.className.replace(/\s*empty\b/g, '');
            setCoverImage(el.npArt, url);
        } else {
            el.npArt.className = 'np-art empty';
            setCoverImage(el.npArt, '');
        }
    }

    /*
     * The player bar shows whichever source is playing: a Subsonic track, or an AirPlay
     * cast (tagged "AirPlay", with the skip buttons dimmed because the phone controls the
     * queue). It is hidden entirely until something has played or is being cast.
     */
    function renderBar() {
        var casting = airplaySourceActive();
        var snap, s, song, dur, pos, sig, tab, art;

        state.casting = casting;
        tab = $('tab-airplay');
        if (tab && (tab.className.indexOf('casting') >= 0) !== casting) {
            tab.className = tab.className.replace(/\s*casting\b/g, '') + (casting ? ' casting' : '');
        }
        setBodyFlag('no-player', !casting && !state.currentSong);
        setClassIf($('btn-prev'), casting ? 'disabled' : '');
        setClassIf($('btn-next'), casting ? 'disabled' : '');

        if (casting) {
            snap = AirPlay.snapshot();
            s = snap.status;
            art = AirPlay.coverUrl();
            sig = 'a|' + s.title + '|' + s.artist + '|' + art;
            if (sig !== state.barSig) {
                state.barSig = sig;
                el.nowPlaying.innerHTML = escapeHtml(s.title || 'AirPlay') +
                    '<span class="np-artist"><b class="np-tag">AirPlay</b>' +
                    escapeHtml(s.artist || s.client || '') + '</span>';
                setBarArt(art);
            }
            setPlayIcon(snap.streaming);
            dur = s.duration || 0;
            pos = dur ? AirPlay.position() : 0;
            setTextIf(el.seekElapsed, formatDuration(pos));
            setTextIf(el.seekTotal, formatDuration(dur));
            setWidthIf(el.seekFill, dur ? Math.min(100, pos / dur * 100) : 0);
            return;
        }

        song = state.currentSong;
        sig = 's|' + (song ? song.id : '');
        if (sig !== state.barSig) {
            state.barSig = sig;
            if (song) {
                el.nowPlaying.innerHTML = escapeHtml(song.title) +
                    '<span class="np-artist">' + escapeHtml(song.artist) + '</span>';
                setBarArt(song.coverArt && state.client ?
                    state.client.coverArtUrl(song.coverArt, NP_ART_SIZE) : '');
            } else {
                el.nowPlaying.innerHTML = 'Nothing playing';
                setBarArt('');
            }
        }
        if (song) {
            setPlayIcon(!el.audio.paused);
            updateSeeker();
        }
    }

    /* ---------- Connection settings ---------- */

    /*
     * The avatar in the nav bar reopens the connect form, pre-filled, so the
     * server and the AirPlay bridge address can be changed after first setup.
     * Cancel / Back return to the screen the user came from.
     */
    function activeScreenId() {
        var node = document.querySelector('.screen.active');
        return node ? node.id : 'screen-albums';
    }

    function openSettings() {
        var saved = loadConnection();
        if (!state.client || activeScreenId() === 'screen-connect') {
            return;
        }
        if (saved) {
            $('server-url').value = saved.url || '';
            $('username').value = saved.user || '';
            $('password').value = saved.pass || '';
            $('bridge-url').value = saved.bridge || '';
        }
        state.settingsReturn = activeScreenId();
        $('connect-hint').innerHTML = 'Connection settings';
        $('btn-connect').innerHTML = 'Save';
        $('btn-cancel').className = '';
        show('screen-connect');
    }

    function resetSettingsForm() {
        $('connect-hint').innerHTML = 'Connect to your Subsonic server';
        $('btn-connect').innerHTML = 'Connect';
        $('btn-cancel').className = 'hidden';
    }

    function closeSettings(returnTo) {
        resetSettingsForm();
        show(returnTo || state.settingsReturn || 'screen-albums');
    }

    /*
     * Submitting the form. If only the bridge address changed there is no need
     * to log in again (and a server that is down must not block fixing the
     * bridge), so the new address is just saved and applied.
     */
    function submitConnection() {
        var url = $('server-url').value.trim();
        var user = $('username').value.trim();
        var pass = $('password').value;
        var bridge = $('bridge-url').value.trim();
        var saved = loadConnection();

        if (state.client && saved && saved.url === url &&
                saved.user === user && saved.pass === pass) {
            saveConnection({ url: url, user: user, pass: pass, bridge: bridge, auth: saved.auth });
            AirPlay.configure(bridge, url);
            AirPlay.start();
            closeSettings('screen-airplay');
            selectTab('airplay');
            renderAirPlay();
            AirPlay.poll();
            setStatus('AirPlay bridge saved.', false);
            return;
        }
        /* Stay on the form until the new server answers, so a typo is fixable. */
        connect(url, user, pass, bridge);
    }

    /* ---------- AirPlay ---------- */

    /*
     * Audio, metadata and cover art come from the SubTizen bridge (see
     * /bridge and airplay.js); this section only draws them. The screen reuses
     * the Now Playing stage layout so a cast looks like any other track.
     */
    var airplayTint = null;
    var airplayCover = '';
    var airplayTintSeq = 0;

    function setAirPlayCover(url) {
        var img;
        var seq = ++airplayTintSeq;

        if (url === airplayCover) {
            return;
        }
        airplayCover = url;
        airplayTint = null;

        if (!url) {
            el.apCover.className = 'np-cover empty';
            setCoverImage(el.apCover, '');
            if ($('screen-airplay').className.indexOf('active') >= 0) {
                applyNowTint(null);
            }
            return;
        }

        el.apCover.className = el.apCover.className.replace(/\s*empty\b/g, '');
        setCoverImage(el.apCover, url);

        img = new Image();
        /* The bridge sends CORS headers, which lets the canvas read pixels. */
        img.crossOrigin = 'anonymous';
        img.onload = function () {
            if (seq !== airplayTintSeq) {
                return;
            }
            airplayTint = tintFromImage(img);
            if ($('screen-airplay').className.indexOf('active') >= 0) {
                applyNowTint(airplayTint, 'screen-airplay');
            }
        };
        img.src = url;
    }

    function updateAirPlaySeek() {
        var snap, s, pos, dur;
        if ($('screen-airplay').className.indexOf('active') < 0) {
            return;
        }
        snap = AirPlay.snapshot();
        s = snap.status;
        dur = s && s.duration ? s.duration : 0;
        pos = dur ? AirPlay.position() : 0;
        el.apElapsed.innerHTML = formatDuration(pos);
        el.apTotal.innerHTML = formatDuration(dur);
        el.apSeekFill.style.width = (dur ? Math.min(100, pos / dur * 100) : 0) + '%';
    }

    function renderAirPlay() {
        var snap = AirPlay.snapshot();
        var s = snap.status;
        var sig = [snap.base, snap.reachable, snap.streaming, snap.muted, snap.mode,
                   s ? [s.state, s.title, s.artist, s.album, s.client, s.cover].join('|') : '',
                   snap.mode === 'webaudio' ? Math.round(snap.bufferAhead * 4) : ''].join('~');

        /* This runs on every poll and every second; rebuilding the screen for an identical state is waste. */
        if (sig === state.apSig) {
            updateAirPlaySeek();
            renderBar();
            return;
        }
        state.apSig = sig;
        var live = snap.reachable && s && s.state !== 'idle';
        var headline, hint, label;

        if (!snap.base) {
            headline = 'No AirPlay bridge';
            hint = 'Add the bridge address on the connect screen.';
        } else if (!snap.reachable) {
            headline = 'Bridge not reachable';
            hint = 'Could not reach ' + snap.base + '. Is subtizen-bridge running?';
        } else if (!live) {
            headline = 'Ready for AirPlay';
            hint = 'Choose \u201C' + (s && s.name ? s.name : 'SubTizen') +
                '\u201D in the AirPlay menu on your iPhone, iPad or Mac.';
        } else if (snap.muted) {
            headline = 'Muted on TV';
            hint = 'Press play to listen again.';
        } else {
            headline = s.state === 'paused' ?
                (s.title ? 'Paused' : 'Connected' + (s.client ? ' to ' + s.client : '')) :
                (s.client ? 'Playing from ' + s.client : 'AirPlay');
            /* Shows how far behind the phone the TV's player is running. */
            hint = !snap.streaming ? '' :
                (snap.mode === 'webaudio' ?
                    'Low-latency player, delay ' + Math.round(snap.bufferAhead * 1000) + ' ms' :
                    (snap.mode === 'avplay' ?
                        'Samsung AVPlay player' + (snap.avInfo ? ' (' + snap.avInfo + ')' : '') :
                        'Standard player (' + snap.probe + ')'));
        }
        el.apHeadline.innerHTML = escapeHtml(headline);
        el.apHint.innerHTML = escapeHtml(hint);

        el.apTitle.innerHTML = live ? escapeHtml(s.title) : '';
        el.apArtist.innerHTML = live ? escapeHtml(s.artist) : '';
        el.apAlbum.innerHTML = live ? escapeHtml(s.album) : '';
        setAirPlayCover(live ? AirPlay.coverUrl() : '');

        label = snap.streaming ? 'Pause' : 'Play';
        el.apPlay.innerHTML = playIconMarkup(snap.streaming);
        el.apPlay.setAttribute('aria-label', label);
        updateAirPlaySeek();
        setPausedClass('screen-airplay', !snap.streaming);
        renderBar();
    }

    function bindAirPlay() {
        AirPlay.bindAudio($('audio-airplay'));

        AirPlay.on('begin', function (snap) {
            /* Casting is a deliberate act, so it takes over from the queue. */
            el.audio.pause();
            selectTab('airplay');
            renderAirPlay();
            show('screen-airplay');
            setStatus('AirPlay' + (snap.status && snap.status.client ?
                ' from ' + snap.status.client : '') + '.', false);
        });
        AirPlay.on('end', function () {
            setStatus('AirPlay ended.', false);
        });
        AirPlay.on('update', renderAirPlay);

        el.apPlay.addEventListener('click', function () {
            AirPlay.toggle();
        }, false);

        global.setInterval(function () {
            updateAirPlaySeek();
            renderBar();
        }, 1000);
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
                (tabs[i].getAttribute('data-tab') === tab ? ' active' : '') +
                (tabs[i].getAttribute('data-tab') === 'airplay' && state.casting ? ' casting' : '');
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
                        /*
                         * Coming back to Albums need not refetch the whole library each
                         * time; reload only when it is stale or was never loaded.
                         */
                        if (state.homeLoadedAt &&
                                new Date().getTime() - state.homeLoadedAt < HOME_REFRESH_MS) {
                            show('screen-albums');
                            refreshRecent();
                        } else {
                            loadHome();
                        }
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
                } else if (tab === 'airplay') {
                    renderAirPlay();
                    show('screen-airplay');
                    AirPlay.poll();
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
        el.albumCover = $('album-cover');
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
        el.npFav = $('np-fav');
        el.npQueue = $('np-queue');
        el.npShuffle = $('np-shuffle');
        el.npRepeat = $('np-repeat');
        el.npPrev = $('np-prev');
        el.npPlay = $('np-play');
        el.npNext = $('np-next');
        el.apCover = $('ap-cover');
        el.apHeadline = $('ap-headline');
        el.apHint = $('ap-hint');
        el.apTitle = $('ap-title');
        el.apArtist = $('ap-artist');
        el.apAlbum = $('ap-album');
        el.apElapsed = $('ap-elapsed');
        el.apTotal = $('ap-total');
        el.apSeekFill = $('ap-seek-fill');
        el.apPlay = $('ap-play');

        $('connect-form').addEventListener('submit', function (event) {
            event.preventDefault();
            submitConnection();
        }, false);
        $('btn-cancel').addEventListener('click', function () {
            closeSettings();
        }, false);
        el.avatar.addEventListener('click', openSettings, false);

        $('back-to-albums').addEventListener('click', leaveAlbum, false);

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
        el.npFav.addEventListener('click', toggleFavorite, false);
        el.npQueue.addEventListener('click', function () { toggleQueue(); }, false);
        $('queue-list').addEventListener('click', function (event) {
            var node = event.target;
            while (node && node !== this && (!node.className || node.className.indexOf('queue-row') < 0)) {
                node = node.parentNode;
            }
            if (node && node !== this) {
                playQueueRow(node);
            }
        }, false);
        el.npShuffle.addEventListener('click', toggleShuffle, false);
        el.npRepeat.addEventListener('click', cycleRepeat, false);
        el.npPlay.addEventListener('click', togglePlayPause, false);

        if (lite) {
            setBodyFlag('lite', true);
        }
        loadPlayMode();
        renderPlayMode();
        bindAudio();
        bindAirPlay();

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
            $('bridge-url').value = saved.bridge || '';
            connect(saved.url, saved.user, saved.pass, saved.bridge);
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
