'use strict';
/*
 * metadata.js - parse shairport-sync's metadata pipe and keep AirPlay state.
 *
 * shairport-sync writes pseudo-XML items to a named pipe:
 *
 *   <item><type>636f7265</type><code>6d696e6d</code><length>5</length>
 *   <data encoding="base64">
 *   SGVsbG8=
 *   </data></item>
 *
 * `type` and `code` are four ASCII characters, hex encoded. `core` items carry
 * track tags (minm = title, asar = artist, asal = album); `ssnc` items carry
 * session events (pbeg/pend = play session begin/end, PICT = cover art,
 * prgr = progress, snam = name of the sending device, mdst/mden = start/end of
 * a metadata bundle).
 */

const MAX_BUFFER = 16 * 1024 * 1024;
const COVER_LEAD_MS = 10000;
const ITEM_RE = new RegExp(
    '<item><type>([0-9a-fA-F]{8})</type><code>([0-9a-fA-F]{8})</code>' +
    '<length>(\\d+)</length>(?:\\s*<data encoding="base64">([\\s\\S]*?)</data>)?</item>',
    'g'
);

function hexToAscii(hex) {
    return Buffer.from(hex, 'hex').toString('latin1');
}

/** Incrementally parses the pipe's byte stream into { type, code, data } items. */
class MetadataParser {
    constructor(onItem) {
        this.onItem = onItem;
        this.buffer = '';
    }

    write(chunk) {
        this.buffer += chunk.toString('latin1');
        if (this.buffer.length > MAX_BUFFER) {
            this.buffer = '';
            return;
        }
        let consumed = 0;
        let match;
        ITEM_RE.lastIndex = 0;
        while ((match = ITEM_RE.exec(this.buffer)) !== null) {
            consumed = ITEM_RE.lastIndex;
            const data = match[4] ? Buffer.from(match[4].replace(/\s+/g, ''), 'base64') : null;
            this.onItem({
                type: hexToAscii(match[1]),
                code: hexToAscii(match[2]),
                data: data
            });
        }
        if (consumed) {
            this.buffer = this.buffer.slice(consumed);
        } else if (this.buffer.indexOf('<item>') < 0) {
            /* Junk with no item start can never complete; drop it. */
            this.buffer = '';
        } else if (this.buffer.indexOf('<item>') > 0) {
            this.buffer = this.buffer.slice(this.buffer.indexOf('<item>'));
        }
    }
}

function sniffImage(buf) {
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
        return 'image/jpeg';
    }
    if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return 'image/png';
    }
    return null;
}

/*
 * What the TV needs to know: is a phone connected, is audio flowing, and what
 * is the track.
 *
 * A pause is not a disconnect. AirPlay senders end the "play session" (pend)
 * and stop sending audio when paused, but stay connected, and the TV screen
 * should keep showing the paused track. So the state only becomes idle after
 * a real disconnect (ssnc/disc), or after a very long silence as a safety net
 * in case a disconnect message is ever lost.
 */
const DISC_GRACE_MS = 2000;        /* a disc this soon after a conn belongs to the old session */
const RECONNECT_GRACE_MS = 1500;

class AirPlayState {
    constructor(opts) {
        opts = opts || {};
        this.sampleRate = opts.sampleRate || 44100;
        this.idleAfterMs = opts.idleAfterMs || 30 * 60 * 1000;
        this.now = opts.now || Date.now;
        this.coverVersion = 0;      /* only ever increases, so the TV never reuses a stale cover URL */
        this.disconnect();
    }

    /** Forget the connection and the track. */
    disconnect() {
        this.connected = false;
        this.connectedAt = 0;
        this.discAt = 0;
        this.client = '';
        this.clearTrack();
    }

    /** Forget the track only (a new track or play session begins). */
    clearTrack() {
        this.session = false;
        this.title = '';
        this.artist = '';
        this.album = '';
        this.duration = 0;
        this.basePosition = 0;      /* seconds, from the last progress (prgr) message */
        this.playedBytes = 0;       /* PCM received since then; the position clock */
        if (this.cover) {
            this.coverVersion++;
        }
        this.cover = null;
        this.coverAt = 0;
        this.bundleAt = 0;
        this.pending = null;
        this.lastAudioAt = 0;
    }

    /** Called whenever real PCM arrives from the receiver. */
    audio(bytes) {
        this.lastAudioAt = this.now();
        this.playedBytes += bytes || 0;
    }

    handle(item) {
        const text = item.data ? item.data.toString('utf8') : '';
        const t = this.now();

        if (item.type === 'ssnc') {
            switch (item.code) {
            case 'conn':
                this.disconnect();
                this.connected = true;
                this.connectedAt = t;
                break;
            case 'disc':
                if (t - this.connectedAt >= RECONNECT_GRACE_MS) {
                    this.discAt = t;
                }
                break;
            case 'snam':
                this.client = text;
                break;
            case 'pbeg':
                this.clearTrack();
                this.session = true;
                this.connected = true;
                this.connectedAt = this.connectedAt || t;
                this.discAt = 0;
                break;
            case 'pend':
                this.session = false;      /* paused or stopped; the sender is still connected */
                break;
            case 'mdst':
                this.pending = {};
                this.bundleAt = t;
                break;
            case 'mden':
                this.commitBundle();
                break;
            case 'PICT':
                if (item.data && item.data.length) {
                    const type = sniffImage(item.data);
                    if (type) {
                        this.cover = { buf: item.data, type: type };
                        this.coverVersion++;
                        this.coverAt = t;
                    }
                }
                break;
            case 'prgr': {
                const parts = text.split('/').map(Number);
                if (parts.length === 3 && parts.every(isFinite)) {
                    this.duration = Math.max(0, (parts[2] - parts[0]) / this.sampleRate);
                    this.basePosition = Math.max(0, (parts[1] - parts[0]) / this.sampleRate);
                    this.playedBytes = 0;
                }
                break;
            }
            default:
                break;
            }
            return;
        }

        if (item.type === 'core') {
            /* Tags arrive between mdst and mden; tolerate stray ones too. */
            const bundle = this.pending || (this.pending = {});
            if (item.code === 'minm') { bundle.title = text; }
            if (item.code === 'asar') { bundle.artist = text; }
            if (item.code === 'asal') { bundle.album = text; }
            if (!this.bundleAt) { this.bundleAt = t; }
        }
    }

    commitBundle() {
        const b = this.pending;
        this.pending = null;
        if (!b) {
            return;
        }
        const title = b.title !== undefined ? b.title : this.title;
        if (title !== this.title) {
            /*
             * New track: drop cover art that is clearly left over from the
             * previous one. Senders deliver the artwork (PICT) a few
             * milliseconds BEFORE the track tags, so art that arrived just
             * ahead of this bundle belongs to it and must be kept. Duration and
             * position are not reset here: the progress message (prgr) for the
             * track can arrive before its tags, and a new prgr replaces them.
             */
            if (this.cover && this.coverAt < this.bundleAt - COVER_LEAD_MS) {
                this.cover = null;
                this.coverVersion++;
            }
        }
        this.title = title;
        if (b.artist !== undefined) { this.artist = b.artist; }
        if (b.album !== undefined) { this.album = b.album; }
        this.bundleAt = 0;
    }

    audioActive() {
        return this.lastAudioAt > 0 && this.now() - this.lastAudioAt < 1500;
    }

    /** idle | playing | paused */
    status() {
        const t = this.now();
        if (!this.connected && !this.session) {
            return 'idle';
        }
        if (this.discAt && t - this.discAt > DISC_GRACE_MS) {
            return 'idle';                 /* the phone disconnected */
        }
        if (this.audioActive()) {
            return 'playing';
        }
        const since = this.lastAudioAt || this.connectedAt || 0;
        if (since && t - since > this.idleAfterMs) {
            return 'idle';                 /* safety net: a disconnect was never reported */
        }
        return 'paused';
    }

    snapshot() {
        const state = this.status();
        if (state === 'idle') {
            return { state: 'idle', client: '', title: '', artist: '', album: '',
                     duration: 0, position: 0, cover: null };
        }
        /* The position clock is the audio actually received, so it freezes on pause. */
        let position = this.basePosition + this.playedBytes / (this.sampleRate * 4);
        if (this.duration && position > this.duration) {
            position = this.duration;
        }
        return {
            state: state,
            client: this.client,
            title: this.title,
            artist: this.artist,
            album: this.album,
            duration: Math.round(this.duration * 10) / 10,
            position: Math.round(position * 10) / 10,
            cover: this.cover ? '/cover?v=' + this.coverVersion : null
        };
    }
}

module.exports = { MetadataParser, AirPlayState, sniffImage };
