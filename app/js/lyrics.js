/*
 * lyrics.js - synced lyrics from LRCLIB (https://lrclib.net).
 *
 * LRCLIB is a free, open, keyless lyrics database that serves LRC text with
 * per-line timestamps, which is what the Now Playing screen needs to keep the
 * highlight on the right line. Subsonic's own `getLyrics` returns plain text
 * with no timing at all, so it is not used.
 *
 * Uses XMLHttpRequest (no fetch) for Tizen 2.4 WebKit. LRCLIB sends
 * `Access-Control-Allow-Origin: *`, so the TV can call it directly.
 */
(function (global) {
    'use strict';

    var BASE = 'https://lrclib.net/api';
    var TIMEOUT = 8000;

    /*
     * LRCLIB asks clients to identify themselves so it can spot abusive
     * traffic. The header is not required, but sending it is polite and keeps
     * the app from being rate-limited as an anonymous caller.
     */
    var CLIENT_HEADER = 'SubTizen/1.0 (https://github.com/subtizen)';

    function get(url, onSuccess, onError) {
        var xhr = new XMLHttpRequest();

        xhr.open('GET', url, true);
        xhr.timeout = TIMEOUT;
        xhr.setRequestHeader('x-user-agent', CLIENT_HEADER);

        xhr.onreadystatechange = function () {
            var payload;
            if (xhr.readyState !== 4) {
                return;
            }
            if (xhr.status === 0) {
                onError(new Error('LRCLIB unreachable'));
                return;
            }
            if (xhr.status === 404) {
                /* No entry for this track; not an error, just no lyrics. */
                onSuccess(null);
                return;
            }
            if (xhr.status < 200 || xhr.status >= 300) {
                onError(new Error('LRCLIB HTTP ' + xhr.status));
                return;
            }
            try {
                payload = JSON.parse(xhr.responseText);
            } catch (e) {
                onError(new Error('LRCLIB returned invalid JSON'));
                return;
            }
            onSuccess(payload);
        };
        xhr.onerror = function () {
            onError(new Error('LRCLIB request failed'));
        };
        xhr.ontimeout = function () {
            onError(new Error('LRCLIB request timed out'));
        };
        xhr.send();
    }

    function query(params) {
        var parts = [];
        var key;
        for (key in params) {
            if (Object.prototype.hasOwnProperty.call(params, key) &&
                    params[key] !== undefined && params[key] !== null &&
                    params[key] !== '') {
                parts.push(encodeURIComponent(key) + '=' +
                    encodeURIComponent(params[key]));
            }
        }
        return parts.join('&');
    }

    /*
     * Navidrome joins multiple artists with a bullet (`Bad Bunny • Dei V`),
     * which never matches LRCLIB's own naming. Splitting on the common
     * separators and retrying with the primary artist finds those tracks.
     */
    function primaryArtist(artist) {
        return String(artist || '')
            .split(/\s*(?:•|\||;|\/|,|&|\bfeat\.?\b|\bft\.?\b|\bwith\b)\s*/i)[0]
            .replace(/\s+/g, ' ')
            .trim();
    }

    /*
     * The exact-match endpoint needs the duration to agree within a couple of
     * seconds, so a track whose stored duration is slightly off misses. The
     * search endpoint is the fallback: it returns candidates, and the one
     * whose duration is closest to the track's is the best guess.
     */
    function pickClosest(results, duration) {
        var best = null;
        var bestDelta = Infinity;
        var i, delta;

        for (i = 0; i < results.length; i++) {
            if (!results[i].syncedLyrics) {
                continue;
            }
            delta = Math.abs((results[i].duration || 0) - duration);
            if (delta < bestDelta) {
                bestDelta = delta;
                best = results[i];
            }
        }
        return best;
    }

    function search(artist, title, duration, onSuccess, onError) {
        get(BASE + '/search?' + query({
            artist_name: artist,
            track_name: title
        }), function (results) {
            var best;
            if (!results || !results.length) {
                onSuccess(null);
                return;
            }
            best = pickClosest(results, duration);
            onSuccess(best ? best.syncedLyrics : null);
        }, onError);
    }

    /*
     * `song` is a Subsonic song object: title, artist, album, duration.
     * Calls back with the LRC text, or null when LRCLIB has nothing usable.
     */
    function fetchLyrics(song, onSuccess, onError) {
        var duration = parseInt(song.duration, 10) || 0;
        var artist = song.artist;
        var primary = primaryArtist(artist);
        var exact = BASE + '/get?' + query({
            artist_name: artist,
            track_name: song.title,
            album_name: song.album,
            duration: duration || undefined
        });

        get(exact, function (payload) {
            if (payload && payload.syncedLyrics) {
                onSuccess(payload.syncedLyrics);
                return;
            }
            /*
             * No exact hit (or the entry has no synced text). Fall back to a
             * search, first with the full artist string and then with just the
             * primary artist, which is what catches multi-artist tracks.
             */
            search(artist, song.title, duration, function (text) {
                if (text || primary === artist) {
                    onSuccess(text);
                    return;
                }
                search(primary, song.title, duration, onSuccess, onError);
            }, onError);
        }, onError);
    }

    global.Lyrics = {
        fetch: fetchLyrics
    };
}(this));
