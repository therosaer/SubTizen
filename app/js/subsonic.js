/*
 * subsonic.js - Subsonic REST API client for Tizen 2.4.
 *
 * Uses XMLHttpRequest (no fetch). Requests authenticate with a salted token
 * (`t=md5(password + salt)`, `s=salt`, API 1.13+), so the password itself never
 * appears in a URL (server logs, proxies, on-screen errors). Servers that do not
 * support tokens get the legacy plaintext `p=` instead; the app picks the mode
 * (see connect() in app.js) and passes it in as `auth`.
 */
(function (global) {
    'use strict';

    var API_VERSION = '1.16.1';
    var CLIENT_NAME = 'SubTizen';

    function randomSalt() {
        var chars = '0123456789abcdef';
        var salt = '';
        var i;
        for (i = 0; i < 12; i++) {
            salt += chars.charAt(Math.floor(Math.random() * 16));
        }
        return salt;
    }

    function Subsonic(baseUrl, username, password, auth) {
        this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
        this.username = username || '';
        this.password = password || '';
        this.auth = (auth === 'plain' || !global.md5) ? 'plain' : 'token';
        this.salt = randomSalt();
        this.token = this.auth === 'token' ? global.md5(this.password + this.salt) : '';
    }

    Subsonic.prototype.buildUrl = function (method, params) {
        var url = this.baseUrl + '/rest/' + method + '.view';
        var query = [];
        var key;

        params = params || {};
        params.u = this.username;
        if (this.auth === 'token') {
            params.t = this.token;
            params.s = this.salt;
        } else {
            params.p = this.password;
        }
        params.v = API_VERSION;
        params.c = CLIENT_NAME;
        params.f = 'json';

        for (key in params) {
            if (Object.prototype.hasOwnProperty.call(params, key) && params[key] !== undefined && params[key] !== null) {
                query.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
            }
        }
        return url + '?' + query.join('&');
    };

    Subsonic.prototype.request = function (method, params, onSuccess, onError) {
        var xhr = new XMLHttpRequest();
        var url = this.buildUrl(method, params);
        var base = this.baseUrl;     /* the URL carries credentials; never put it in a message */

        xhr.open('GET', url, true);
        xhr.timeout = 15000;

        xhr.onreadystatechange = function () {
            var payload, err;
            if (xhr.readyState !== 4) {
                return;
            }
            if (xhr.status === 0) {
                onError(new Error('Network unreachable (CORS or offline). Server: ' + base));
                return;
            }
            if (xhr.status < 200 || xhr.status >= 300) {
                err = new Error('HTTP ' + xhr.status + ' from ' + method);
                err.http = xhr.status;
                onError(err);
                return;
            }
            try {
                payload = JSON.parse(xhr.responseText);
            } catch (e) {
                onError(new Error('Invalid JSON from ' + method + ': ' + e.message));
                return;
            }
            if (!payload || !payload['subsonic-response']) {
                onError(new Error('Not a Subsonic response from ' + method));
                return;
            }
            if (payload['subsonic-response'].status === 'failed') {
                /* `api` marks a Subsonic-level refusal (bad login, unsupported auth), not a network fault. */
                err = new Error(payload['subsonic-response'].error ?
                    payload['subsonic-response'].error.message : 'Subsonic error');
                err.api = true;
                err.code = payload['subsonic-response'].error ?
                    payload['subsonic-response'].error.code : 0;
                onError(err);
                return;
            }
            onSuccess(payload['subsonic-response']);
        };

        xhr.ontimeout = function () {
            onError(new Error('Request timed out: ' + method));
        };
        xhr.onerror = function () {
            onError(new Error('Request failed: ' + method));
        };

        xhr.send(null);
    };

    Subsonic.prototype.ping = function (onSuccess, onError) {
        this.request('ping', {}, onSuccess, onError);
    };

    Subsonic.prototype.getAlbumList = function (type, size, offset, onSuccess, onError) {
        this.request('getAlbumList2', {
            type: type || 'alphabeticalByArtist',
            size: size || 50,
            offset: offset || 0
        }, onSuccess, onError);
    };

    /*
     * There is no Subsonic endpoint for "most played songs" across the whole
     * library: getTopSongs requires an artist. Navidrome does expose playCount
     * on every song, so we pull a pool via search3 (an empty query matches
     * everything) and rank it client-side. The pool is capped because the
     * response is parsed on a TV with limited memory.
     */
    Subsonic.prototype.getSongPool = function (size, offset, onSuccess, onError) {
        this.request('search3', {
            query: '',
            songCount: size || 500,
            songOffset: offset || 0,
            albumCount: 0,
            artistCount: 0
        }, onSuccess, onError);
    };

    Subsonic.prototype.getAlbum = function (id, onSuccess, onError) {
        this.request('getAlbum', { id: id }, onSuccess, onError);
    };

    /*
     * getArtists returns the whole artist list grouped into index buckets
     * (`artists.index[].artist[]`). The app flattens and re-sorts it, so the
     * server's bucketing is only used as the source of the list.
     */
    Subsonic.prototype.getArtists = function (onSuccess, onError) {
        this.request('getArtists', {}, onSuccess, onError);
    };

    Subsonic.prototype.getArtist = function (id, onSuccess, onError) {
        this.request('getArtist', { id: id }, onSuccess, onError);
    };

    /*
     * getPlaylists returns every playlist on the server, each with its name,
     * song count, and a coverArt id when the server has one. The list is not
     * paged: Subsonic has no offset parameter for it, so the whole set arrives
     * in one response.
     */
    Subsonic.prototype.getPlaylists = function (onSuccess, onError) {
        this.request('getPlaylists', {}, onSuccess, onError);
    };

    /*
     * getPlaylist returns the playlist's entries. Servers disagree on the
     * shape: most return `playlist.entry[]`, but some older ones return a bare
     * `playlist` array. The caller normalises both.
     */
    Subsonic.prototype.getPlaylist = function (id, onSuccess, onError) {
        this.request('getPlaylist', { id: id }, onSuccess, onError);
    };

    /*
     * Tell the server a track is playing (submission=false) or has been played
     * (submission=true). Navidrome uses this for play counts and its own
     * Recently Played. Fire-and-forget: a failure must never disturb playback.
     */
    Subsonic.prototype.scrobble = function (id, submission, time) {
        this.request('scrobble', {
            id: id,
            submission: submission ? 'true' : 'false',
            time: time
        }, function () {}, function () {});
    };

    /* Favorites: the starred songs, and star/unstar for one item. */
    Subsonic.prototype.getStarred = function (onSuccess, onError) {
        this.request('getStarred2', {}, onSuccess, onError);
    };

    Subsonic.prototype.star = function (id, on, onSuccess, onError) {
        this.request(on ? 'star' : 'unstar', { id: id }, onSuccess, onError);
    };

    Subsonic.prototype.search3 = function (query, onSuccess, onError) {
        this.request('search3', {
            query: query,
            songCount: 50,
            albumCount: 20,
            artistCount: 20
        }, onSuccess, onError);
    };

    /*
     * Stream URL for <audio src>. No XHR, so no CORS preflight involved.
     *
     * Tizen 2.4's WebKit decodes MP3/AAC but not FLAC or Ogg/Opus. Servers
     * transcode to Ogg when only maxBitRate is given, so we request MP3
     * explicitly. Servers that cannot transcode ignore `format` and serve
     * the original file, which is the best we can do for those tracks.
     */
    Subsonic.prototype.streamUrl = function (id, maxBitRate) {
        var params = { id: id, format: 'mp3' };
        if (maxBitRate) {
            params.maxBitRate = maxBitRate;
        }
        return this.buildUrl('stream', params);
    };

    Subsonic.prototype.coverArtUrl = function (id, size) {
        return this.buildUrl('getCoverArt', { id: id, size: size || 300 });
    };

    global.Subsonic = Subsonic;
}(this));
