/*
 * subsonic.js - Subsonic REST API client for Tizen 2.4.
 *
 * Uses XMLHttpRequest (no fetch) and plaintext password auth (`p=`/`u=`),
 * which is the most broadly supported scheme across Subsonic-compatible
 * servers. See README for the security tradeoff and the token-auth upgrade.
 */
(function (global) {
    'use strict';

    var API_VERSION = '1.16.1';
    var CLIENT_NAME = 'SubTizen';

    function Subsonic(baseUrl, username, password) {
        this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
        this.username = username || '';
        this.password = password || '';
    }

    Subsonic.prototype.buildUrl = function (method, params) {
        var url = this.baseUrl + '/rest/' + method + '.view';
        var query = [];
        var key;

        params = params || {};
        params.u = this.username;
        params.p = this.password;
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

        xhr.open('GET', url, true);
        xhr.timeout = 15000;

        xhr.onreadystatechange = function () {
            var payload;
            if (xhr.readyState !== 4) {
                return;
            }
            if (xhr.status === 0) {
                onError(new Error('Network unreachable (CORS or offline). URL: ' + url));
                return;
            }
            if (xhr.status < 200 || xhr.status >= 300) {
                onError(new Error('HTTP ' + xhr.status + ' from ' + method));
                return;
            }
            try {
                payload = JSON.parse(xhr.responseText);
            } catch (e) {
                onError(new Error('Invalid JSON from ' + method + ': ' + e.message));
                return;
            }
            if (payload['subsonic-response'] && payload['subsonic-response'].status === 'failed') {
                onError(new Error(payload['subsonic-response'].error ?
                    payload['subsonic-response'].error.message : 'Subsonic error'));
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
