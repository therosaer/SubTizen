/*
 * airplay.js - talks to the SubTizen AirPlay bridge (see /bridge).
 *
 * A Tizen 2.4 web app cannot be an AirPlay receiver itself, so a small service
 * on the local network receives the AirPlay audio and re-serves it as:
 *
 *   GET /status      JSON: { state: idle|playing|paused, title, artist, album,
 *                            duration, position, cover, client }
 *   GET /stream.mp3  endless MP3 stream of whatever is being cast
 *   GET /cover       cover art for the current track
 *
 * This module polls /status, plays the stream in its own <audio> element and
 * reports changes to app.js through callbacks. XHR only (no fetch/Promise),
 * like the rest of the app, because Tizen 2.4's WebKit predates both.
 */
(function (global) {
    'use strict';

    var DEFAULT_PORT = 5100;
    var POLL_MS = 2000;
    var POLL_TIMEOUT_MS = 4000;
    var RETRY_MS = 3000;
var RESUME_TAKEOVER_MS = 4000;   /* paused this long, then playing again = take the TV back */

/*
 * A TV's media player may hold many seconds of a live stream before (and while)
 * playing it, which shows up as a constant delay behind the phone. Whenever
 * more than CATCHUP_AHEAD seconds sit buffered ahead of the playhead, jump to
 * CATCHUP_TARGET seconds behind the live edge. Skips are rate-limited so a
 * player that ignores them is not hammered.
 */
var CATCHUP_AHEAD = 4;
var CATCHUP_TARGET = 1.5;
var CATCHUP_EVERY_MS = 5000;

    var base = '';
    var audio = null;
    var pollTimer = null;
    var retryTimer = null;
    var running = false;

    var last = null;            /* last good /status payload */
    var lastAt = 0;             /* when it arrived (ms) */
    var reachable = false;

    var catchupTimer = null;
var lastSkipAt = 0;
var bufferedAhead = 0;     /* seconds buffered beyond the playhead */
var skips = 0;

var mode = 'audio';         /* webaudio (low latency) or audio (<audio> element) */
var llBroken = false;       /* Web Audio failed once; use another player */
var llError = '';
var avBroken = false;       /* AVPlay failed once; use the <audio> element */
var streaming = false;      /* the <audio> element is attached to the stream */
    var suppressed = false;     /* another source took over; don't grab it back */
var notPlayingSince = 0;    /* when the cast stopped sending audio (0 = it is playing) */
    var muted = false;          /* the user paused the stream on the TV */

    var handlers = {
        begin: null,            /* a new cast session started */
        end: null,              /* the cast session ended */
        update: null            /* any status change, including reachability */
    };

    function trimSlash(url) {
        return String(url || '').replace(/\s+/g, '').replace(/\/+$/, '');
    }

    /* The bridge usually runs next to the music server, so default to its host. */
    function guessBase(serverUrl) {
        var m = /^(https?:\/\/)(\[[^\]]+\]|[^\/:?#]+)/i.exec(String(serverUrl || '').replace(/^\s+/, ''));
        return m ? m[1] + m[2] + ':' + DEFAULT_PORT : '';
    }

    function configure(bridgeUrl, serverUrl) {
        var wasRunning = running;
        var next = trimSlash(bridgeUrl) || guessBase(serverUrl);
        if (next && !/^https?:\/\//i.test(next)) {
            next = 'http://' + next;
        }
        if (next === base) {
            return;
        }
        if (wasRunning) {
            stop();
        }
        base = next;
        last = null;
        reachable = false;
        if (wasRunning) {
            start();
        }
    }

    function notify() {
        if (handlers.update) {
            handlers.update(snapshot());
        }
    }

    function snapshot() {
        return {
            base: base,
            reachable: reachable,
            streaming: streaming,
            muted: muted,
            suppressed: suppressed,
            bufferAhead: bufferedAhead,
            mode: mode,
            probe: probe(),
            avInfo: av.info,
            skips: skips,
            status: last
        };
    }

    /* ---------- Low-latency player (Web Audio) ---------- */

    /*
     * The TV's <audio> element hides a large buffer (about 20 s) that the page
     * can neither see nor skip. So when the runtime has the Web Audio API, the
     * app reads the bridge's /stream.wav (a 44-byte header, then raw 16-bit
     * stereo PCM) itself and schedules each chunk on an AudioContext with a
     * small jitter buffer. Delay is then the jitter buffer, not the player's.
     *
     * The stream is read with fetch() + ReadableStream where available, else
     * with XHR in "x-user-defined" text mode, the only way old WebKit exposes
     * partial binary data. The XHR path accumulates its whole response, so it
     * reconnects every XHR_RECYCLE_BYTES to bound memory.
     */
    var LL_RATE = 44100;
    var LL_JITTER = 0.35;          /* seconds scheduled ahead of the playhead */
    var LL_MAX_AHEAD = 1.2;        /* drop incoming audio rather than lag more than this */
    var LL_STALL_MS = 6000;        /* no data for this long = connection is dead */
    var WAV_HEADER = 44;
    var XHR_RECYCLE_BYTES = 6 * 1024 * 1024;

    var ll = {
        ctx: null,
        active: false,
        gen: 0,                    /* bumps on every start/stop to retire old readers */
        next: 0,                   /* AudioContext time the next chunk starts at */
        skip: 0,                   /* header bytes still to discard */
        carry: null,               /* partial frame left over from the last chunk */
        lastDataAt: 0,
        xhr: null,
        watchdog: null,
        onDead: null
    };

    function llSupported() {
        return !!(global.AudioContext || global.webkitAudioContext) &&
            typeof global.Uint8Array === 'function' &&
            typeof global.Float32Array === 'function';
    }

    function llEnsureContext() {
        var Ctor;
        if (!ll.ctx) {
            Ctor = global.AudioContext || global.webkitAudioContext;
            ll.ctx = new Ctor();
        }
        if (ll.ctx.state === 'suspended' && ll.ctx.resume) {
            ll.ctx.resume();
        }
        return ll.ctx;
    }

    function llAhead() {
        if (!ll.active || !ll.ctx) {
            return 0;
        }
        return Math.max(0, ll.next - ll.ctx.currentTime);
    }

    /* Schedule whole 4-byte frames of s16le stereo PCM. */
    function llPush(bytes) {
        var data = bytes;
        var frames, i, buf, left, right, src, view, ctx, now, when, o;

        ll.lastDataAt = new Date().getTime();

        if (ll.skip) {
            if (data.length <= ll.skip) {
                ll.skip -= data.length;
                return;
            }
            data = data.subarray(ll.skip);
            ll.skip = 0;
        }
        if (ll.carry && ll.carry.length) {
            o = new Uint8Array(ll.carry.length + data.length);
            o.set(ll.carry, 0);
            o.set(data, ll.carry.length);
            data = o;
            ll.carry = null;
        }
        frames = Math.floor(data.length / 4);
        if (!frames) {
            ll.carry = data;
            return;
        }
        if (data.length > frames * 4) {
            ll.carry = data.subarray(frames * 4);
        }

        ctx = llEnsureContext();
        now = ctx.currentTime;
        if (ll.next < now + 0.05) {
            ll.next = now + LL_JITTER;           /* start, or recover from an underrun */
        }
        if (ll.next - now > LL_MAX_AHEAD) {
            return;                              /* a burst arrived; keep the delay bounded */
        }

        buf = ctx.createBuffer(2, frames, LL_RATE);
        left = buf.getChannelData(0);
        right = buf.getChannelData(1);
        view = new DataView(data.buffer, data.byteOffset, frames * 4);
        for (i = 0; i < frames; i++) {
            left[i] = view.getInt16(i * 4, true) / 32768;
            right[i] = view.getInt16(i * 4 + 2, true) / 32768;
        }

        src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        when = ll.next;
        if (src.start) {
            src.start(when);
        } else {
            src.noteOn(when);
        }
        ll.next = when + frames / LL_RATE;
    }

    function llStop() {
        ll.active = false;
        ll.gen++;
        ll.carry = null;
        ll.next = 0;
        if (ll.watchdog) {
            global.clearInterval(ll.watchdog);
            ll.watchdog = null;
        }
        if (ll.xhr) {
            try { ll.xhr.abort(); } catch (e) { /* already done */ }
            ll.xhr = null;
        }
        if (ll.ctx) {
            /* Closing drops everything already scheduled, so audio stops at once. */
            try { ll.ctx.close(); } catch (e) { /* older engines have no close() */ }
            ll.ctx = null;
        }
    }

    function llDead() {
        if (ll.active && ll.onDead) {
            ll.onDead();
        }
    }

    function llReadFetch(url, gen) {
        global.fetch(url, { cache: 'no-store' }).then(function (res) {
            var reader = res.body.getReader();
            function pump() {
                return reader.read().then(function (result) {
                    if (gen !== ll.gen) {
                        try { reader.cancel(); } catch (e) { /* ignore */ }
                        return;
                    }
                    if (result.done) {
                        llDead();
                        return;
                    }
                    llPush(result.value);
                    return pump();
                });
            }
            return pump();
        })['catch'](function () {
            if (gen === ll.gen) {
                llDead();
            }
        });
    }

    function llReadXhr(url, gen) {
        var xhr = new XMLHttpRequest();
        var seen = 0;
        var chunk, i, n, text;

        ll.xhr = xhr;
        xhr.open('GET', url, true);
        xhr.overrideMimeType('text/plain; charset=x-user-defined');
        xhr.onprogress = function () {
            if (gen !== ll.gen) {
                return;
            }
            text = xhr.responseText;
            n = text.length - seen;
            if (n <= 0) {
                return;
            }
            chunk = new Uint8Array(n);
            for (i = 0; i < n; i++) {
                chunk[i] = text.charCodeAt(seen + i) & 0xff;
            }
            seen = text.length;
            llPush(chunk);
            if (seen > XHR_RECYCLE_BYTES) {
                /* Bound memory: drop this request and reconnect at the live edge. */
                ll.skip = WAV_HEADER;
                xhr.onprogress = null;
                xhr.abort();
                if (gen === ll.gen) {
                    llReadXhr(url, gen);
                }
            }
        };
        xhr.onerror = function () {
            if (gen === ll.gen) {
                llDead();
            }
        };
        xhr.onload = xhr.onerror;
        xhr.send();
    }

    function llStart(url, onDead) {
        var gen;
        llStop();
        ll.active = true;
        ll.onDead = onDead;
        ll.skip = WAV_HEADER;
        ll.lastDataAt = new Date().getTime();
        gen = ++ll.gen;
        llEnsureContext();
        ll.watchdog = global.setInterval(function () {
            if (ll.active && new Date().getTime() - ll.lastDataAt > LL_STALL_MS) {
                llDead();
            }
        }, 2000);
        if (typeof global.fetch === 'function' && global.ReadableStream) {
            llReadFetch(url, gen);
        } else {
            llReadXhr(url, gen);
        }
    }

    /* ---------- Samsung AVPlay ---------- */

    /*
     * Samsung TVs expose their native player as webapis.avplay (script
     * $WEBAPIS/webapis/webapis.js, privilege .../privilege/avplay). Unlike the
     * <audio> element it lets the app set how many seconds are buffered before
     * playing, which is what controls the delay of a live stream. Used when
     * Web Audio is not available.
     */
    var AV_BUFFER_PLAY_S = 1;      /* seconds buffered before playback starts */
        var AV_STALL_MS = 10000;       /* no play-time ticks for this long = dead */

    var av = {
        active: false,
        gen: 0,
        playing: false,
        lastTickAt: 0,
        watchdog: null,
        onDead: null,
        error: '',
        info: ''
    };

    function avSupported() {
        return !!(global.webapis && global.webapis.avplay);
    }

    function avStop() {
        var player;
        if (av.watchdog) {
            global.clearInterval(av.watchdog);
            av.watchdog = null;
        }
        if (!av.active) {
            return;
        }
        av.active = false;
        av.playing = false;
        av.gen++;
        player = global.webapis.avplay;
        try { player.stop(); } catch (e) { /* not playing */ }
        try { player.close(); } catch (e) { /* not open */ }
    }

    function avDead(why) {
        if (av.active) {
            av.error = why || '';
            if (av.onDead) {
                av.onDead();
            }
        }
    }

    /* Apply the bridge's buffer setting; fall back to whole seconds if refused. */
    function avApplyBuffer(player, tuning) {
        var unit = (tuning && tuning.bufferUnit === 'byte') ?
            'PLAYER_BUFFER_SIZE_IN_BYTE' : 'PLAYER_BUFFER_SIZE_IN_SECOND';
        var amount = (tuning && tuning.bufferAmount > 0) ? tuning.bufferAmount : AV_BUFFER_PLAY_S;
        var fallback;
        function set(u, a) {
            player.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', u, a);
            player.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', u, a);
        }
        try {
            set(unit, amount);
            av.info = (tuning && tuning.format === 'wav' ? 'wav' : 'mp3') + ', ' + amount +
                (unit === 'PLAYER_BUFFER_SIZE_IN_BYTE' ? ' B' : ' s');
        } catch (e) {
            /*
             * Refused (a unit or a fractional amount the TV does not take). Fall back to
             * whole seconds. A byte amount must NOT be reused as seconds: 16384 bytes
             * would become a 16384-second buffer.
             */
            fallback = (unit === 'PLAYER_BUFFER_SIZE_IN_BYTE') ?
                AV_BUFFER_PLAY_S : Math.min(10, Math.max(1, Math.round(amount)));
            try {
                set('PLAYER_BUFFER_SIZE_IN_SECOND', fallback);
                av.info = 'buffer ' + amount + (unit === 'PLAYER_BUFFER_SIZE_IN_BYTE' ? ' B' : ' s') +
                    ' refused, using ' + fallback + ' s';
            } catch (e2) {
                av.info = 'buffer settings refused';
            }
        }
    }

    function avStart(url, onDead, tuning) {
        var player = global.webapis.avplay;
        var gen;

        avStop();
        av.active = true;
        av.onDead = onDead;
        av.error = '';
        av.lastTickAt = new Date().getTime();
        gen = ++av.gen;

        player.open(url);
        try {
            player.setDisplayRect(0, 0, 1, 1);     /* audio only; no picture */
        } catch (e) { /* not needed for audio on some firmware */ }
        avApplyBuffer(player, tuning);
        player.setListener({
            oncurrentplaytime: function () {
                if (gen === av.gen) {
                    av.lastTickAt = new Date().getTime();
                    av.playing = true;
                }
            },
            onerror: function (type) {
                if (gen === av.gen) {
                    avDead('avplay error ' + type);
                }
            },
            onstreamcompleted: function () {
                if (gen === av.gen) {
                    avDead('stream ended');
                }
            }
        });
        player.prepareAsync(function () {
            if (gen !== av.gen) {
                return;
            }
            try {
                player.play();
            } catch (e3) {
                avDead('play failed');
            }
        }, function () {
            if (gen === av.gen) {
                avDead('prepare failed');
            }
        });
        av.watchdog = global.setInterval(function () {
            if (av.active && new Date().getTime() - av.lastTickAt > AV_STALL_MS) {
                avDead('stalled');
            }
        }, 2000);
    }

    /* What this runtime offers, shown on screen when a faster player can't be used. */
    function probe() {
        var parts = [];
        parts.push('webaudio ' + ((global.AudioContext || global.webkitAudioContext) ?
            (llBroken ? 'failed' + (llError ? ': ' + llError : '') : 'yes') : 'no'));
        parts.push('avplay ' + (avSupported() ? (avBroken ? 'failed' + (av.error ? ': ' + av.error : '') : 'yes') : 'no'));
        return parts.join(', ');
    }

    /* ---------- Stream element ---------- */

    function measureAhead() {
        var ranges;
        try {
            ranges = audio.buffered;
            if (!ranges || !ranges.length) {
                return 0;
            }
            return Math.max(0, ranges.end(ranges.length - 1) - audio.currentTime);
        } catch (e) {
            return 0;
        }
    }

    function catchUp() {
        var ahead, now, ranges;
        if (streaming && mode === 'webaudio') {
            bufferedAhead = llAhead();
            notify();
            return;
        }
        if (!streaming || !audio || audio.paused) {
            bufferedAhead = 0;
            return;
        }
        ahead = measureAhead();
        now = new Date().getTime();
        if (ahead > CATCHUP_AHEAD && now - lastSkipAt > CATCHUP_EVERY_MS) {
            lastSkipAt = now;
            try {
                ranges = audio.buffered;
                audio.currentTime = ranges.end(ranges.length - 1) - CATCHUP_TARGET;
                skips++;
            } catch (e) {
                /* the player refused; nothing more can be done from here */
            }
        }
        bufferedAhead = ahead;
        notify();
    }

    function openStream() {
        var tuning = null;
        if (!audio || !base || streaming) {
            return;
        }
        streaming = true;
        mode = 'audio';
        if (llSupported() && !llBroken) {
            try {
                llStart(base + '/stream.wav?t=' + new Date().getTime(), function () {
                    scheduleRetry();
                });
                mode = 'webaudio';
            } catch (e) {
                llBroken = true;       /* try the next player, and remember why */
                llError = String(e && e.message ? e.message : e).slice(0, 40);
                llStop();
            }
        }
        if (mode === 'audio' && avSupported() && !avBroken) {
            try {
                tuning = last && last.tv ? last.tv : null;
                avStart(base + '/stream.' + (tuning && tuning.format === 'wav' ? 'wav' : 'mp3') +
                    '?t=' + new Date().getTime(), function () {
                    scheduleRetry();
                }, tuning);
                mode = 'avplay';
            } catch (e2) {
                avBroken = true;
                av.error = String(e2 && e2.message ? e2.message : e2).slice(0, 40);
                avStop();
            }
        }
        if (mode === 'audio') {
            audio.src = base + '/stream.mp3?t=' + new Date().getTime();
            try {
                audio.play();
            } catch (e) {
                /* surfaced through the element's error event */
            }
        }
        notify();
    }

    function closeStream() {
        if (retryTimer) {
            global.clearTimeout(retryTimer);
            retryTimer = null;
        }
        if (!audio || !streaming) {
            return;
        }
        streaming = false;
        llStop();
        avStop();
        audio.pause();
        /* Removing src and reloading is what actually drops the connection. */
        audio.removeAttribute('src');
        try {
            audio.load();
        } catch (e) {
            /* non-fatal */
        }
        notify();
    }

    function scheduleRetry() {
        if (retryTimer || !streaming) {
            return;
        }
        retryTimer = global.setTimeout(function () {
            retryTimer = null;
            if (streaming && last && last.state !== 'idle') {
                streaming = false;
                openStream();
            }
        }, RETRY_MS);
    }

    /* ---------- Status polling ---------- */

    function handleStatus(status) {
        var previous = last;
        var wasLive = !!previous && previous.state !== 'idle';
        var isLive = status.state !== 'idle';

        last = status;
        lastAt = new Date().getTime();
        reachable = true;

        /*
         * The bridge stays "live" while the phone is merely paused, so `suppressed`
         * cannot wait for idle to clear. If the phone was paused for a while and
         * starts playing again, that is a deliberate act: take the TV back. A short
         * gap (a track change, a buffering hiccup) must not hijack a Subsonic track.
         */
        if (status.state === 'playing') {
            if (suppressed && wasLive && notPlayingSince &&
                    lastAt - notPlayingSince >= RESUME_TAKEOVER_MS) {
                suppressed = false;
                if (handlers.begin) {
                    handlers.begin(snapshot());
                }
                if (!suppressed && !muted) {
                    openStream();
                }
            }
            notPlayingSince = 0;
        } else if (!notPlayingSince) {
            notPlayingSince = lastAt;
        }

        if (!isLive) {
            suppressed = false;
            muted = false;
            closeStream();
            if (wasLive && handlers.end) {
                handlers.end();
            }
            notify();
            return;
        }

        if (!wasLive && !suppressed) {
            /* A new session: take over, unless the user is playing something else. */
            if (handlers.begin) {
                handlers.begin(snapshot());
            }
            if (!suppressed && !muted) {
                openStream();
            }
        } else if (!suppressed && !muted && !streaming) {
            openStream();
        }
        notify();
    }

    function poll() {
        var xhr;
        if (!base) {
            return;
        }
        xhr = new XMLHttpRequest();
        xhr.open('GET', base + '/status?_=' + new Date().getTime(), true);
        xhr.timeout = POLL_TIMEOUT_MS;
        xhr.onreadystatechange = function () {
            var payload;
            if (xhr.readyState !== 4) {
                return;
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    payload = JSON.parse(xhr.responseText);
                } catch (e) {
                    payload = null;
                }
            }
            if (payload && payload.state) {
                handleStatus(payload);
            } else if (reachable || !last) {
                reachable = false;
                if (last && last.state !== 'idle' && handlers.end) {
                    handlers.end();
                }
                last = null;
                closeStream();
                notify();
            }
        };
        try {
            xhr.send();
        } catch (e) {
            /* treated like an unreachable bridge on the next poll */
        }
    }

    function start() {
        if (running || !base) {
            return;
        }
        running = true;
        poll();
        pollTimer = global.setInterval(poll, POLL_MS);
    }

    function stop() {
        running = false;
        if (pollTimer) {
            global.clearInterval(pollTimer);
            pollTimer = null;
        }
        closeStream();
        last = null;
        reachable = false;
    }

    /* ---------- Controls used by the app ---------- */

    /* Mute/unmute the stream on the TV. The cast itself continues. */
    function toggle() {
        if (!last || last.state === 'idle') {
            return;
        }
        if (streaming) {
            muted = true;
            closeStream();
        } else {
            muted = false;
            suppressed = false;
            openStream();
        }
    }

    /* Another source (a Subsonic track) started; leave the cast alone. */
    function release() {
        if (!streaming && !(last && last.state !== 'idle')) {
            return;
        }
        suppressed = true;
        closeStream();
    }

    /* Position in seconds, advanced locally between polls while playing. */
    function position() {
        var p;
        if (!last) {
            return 0;
        }
        p = last.position || 0;
        if (last.state === 'playing' && last.duration) {
            p += (new Date().getTime() - lastAt) / 1000;
            if (p > last.duration) {
                p = last.duration;
            }
        }
        return p;
    }

    function bindAudio(element) {
        audio = element;
        if (!catchupTimer) {
            catchupTimer = global.setInterval(catchUp, 1000);
        }
        audio.addEventListener('error', function () {
            if (streaming) {
                scheduleRetry();
            }
        }, false);
        audio.addEventListener('ended', function () {
            if (streaming) {
                scheduleRetry();
            }
        }, false);
        audio.addEventListener('stalled', function () {
            if (streaming && audio.paused) {
                scheduleRetry();
            }
        }, false);
    }

    global.AirPlay = {
        bindAudio: bindAudio,
        configure: configure,
        start: start,
        stop: stop,
        poll: poll,
        toggle: toggle,
        release: release,
        position: position,
        snapshot: snapshot,
        isStreaming: function () { return streaming; },
        isLive: function () { return !!last && last.state !== 'idle'; },
        coverUrl: function () {
            return (base && last && last.cover) ? base + last.cover : '';
        },
        on: function (name, fn) { handlers[name] = fn; },
        guessBase: guessBase
    };
}(this));
