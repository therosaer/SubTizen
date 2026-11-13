#!/usr/bin/env node
'use strict';
/*
 * subtizen-bridge - AirPlay receiver for the SubTizen TV app.
 *
 * The TV's web runtime cannot advertise or serve AirPlay, so this small
 * service does it on another machine on the same network:
 *
 *   iPhone/Mac --AirPlay--> shairport-sync --PCM--> ffmpeg --MP3--> GET /stream.mp3
 *                                   `--metadata--> GET /status, GET /cover
 *
 * Requires: node >= 16, shairport-sync, ffmpeg (with libmp3lame), and a running
 * Avahi/Bonjour daemon. No npm dependencies.
 *
 * Serves two streams at once: /stream.mp3 (small) and /stream.wav (uncompressed PCM, which the
 * TV app plays through the Web Audio API for the lowest delay).
 *
 * Usage:  node subtizen-bridge.js [--port 5100] [--name SubTizen] [--demo]
 *                                [--airplay-port 7001]   (if 7000 is taken)
 *                                [--device-id-offset 7]  (distinct AirPlay 2 ID)
 *                                [--tv-buffer 1s]        (TV player buffer: 1s, 0.5s, 32768b, 16kb)
 *                                [--tv-format mp3|wav]   (what the TV's AVPlay is given)
 *                                [--debug]               (log audio rate, metadata, listener backlog)
 * Env:    BRIDGE_PORT, BRIDGE_NAME, BRIDGE_AIRPLAY_PORT, BRIDGE_BITRATE (default 192k),
 *         SHAIRPORT_BIN, FFMPEG_BIN
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const { MetadataParser, AirPlayState } = require('./metadata');

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    if (i >= 0 && process.argv[i + 1] && process.argv[i + 1].slice(0, 2) !== '--') {
        return process.argv[i + 1];
    }
    return fallback;
}

const PORT = parseInt(arg('port', process.env.BRIDGE_PORT || '5100'), 10);
const NAME = arg('name', process.env.BRIDGE_NAME || 'SubTizen');
const AIRPLAY_PORT = parseInt(arg('airplay-port', process.env.BRIDGE_AIRPLAY_PORT || '0'), 10);
/*
 * AirPlay 2 derives a receiver's device ID from the machine's MAC address. Two
 * receivers on one computer (for example a system shairport-sync) would share
 * it and confuse senders, so the bridge shifts its own ID. Raise this if you
 * run more than one bridge on the same machine.
 */
const DEVICE_ID_OFFSET = parseInt(arg('device-id-offset', process.env.BRIDGE_DEVICE_ID_OFFSET || '7'), 10);
/*
 * Tuning for the TV's Samsung AVPlay player, sent to the app in /status so it can be
 * changed here without reinstalling the app. --tv-buffer sets how much AVPlay buffers
 * before it starts playing: seconds ("1s", "500ms") or bytes ("32768b", "16kb"). Less
 * buffer = less delay but more risk of stutter. --tv-format picks what AVPlay is given:
 * mp3 (small) or wav (uncompressed, nothing to decode).
 */
function parseBuffer(text) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|b|bytes|kb)?\s*$/i.exec(String(text));
    if (!m) {
        return { unit: 'second', amount: 1 };
    }
    const n = parseFloat(m[1]);
    const u = (m[2] || 's').toLowerCase();
    if (u === 'ms') {
        return { unit: 'second', amount: n / 1000 };
    }
    if (u === 'kb') {
        return { unit: 'byte', amount: Math.round(n * 1024) };
    }
    return u.charAt(0) === 'b' ? { unit: 'byte', amount: Math.round(n) } : { unit: 'second', amount: n };
}
const TV_BUFFER = parseBuffer(arg('tv-buffer', process.env.BRIDGE_TV_BUFFER || '1s'));
const TV_FORMAT = arg('tv-format', process.env.BRIDGE_TV_FORMAT || 'mp3').toLowerCase() === 'wav' ? 'wav' : 'mp3';
const DEBUG = process.argv.indexOf('--debug') >= 0 || !!process.env.BRIDGE_DEBUG;
const BITRATE = process.env.BRIDGE_BITRATE || '192k';
const DEMO = process.argv.indexOf('--demo') >= 0;
const SHAIRPORT = process.env.SHAIRPORT_BIN || 'shairport-sync';
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';

const RATE = 44100;
const BYTES_PER_SEC = RATE * 2 * 2;          /* s16le stereo */
const SILENCE_TICK_MS = 100;
const MAX_CLIENT_BACKLOG = 1024 * 1024;

const state = new AirPlayState({ sampleRate: RATE });
const clients = new Set();      /* /stream.mp3 listeners */
const wavClients = new Set();   /* /stream.wav listeners */
let ffmpeg = null;
let shuttingDown = false;

/* Every child process, so none is left running when the bridge exits. */
const children = new Set();
function track(proc) {
    children.add(proc);
    proc.on('exit', function () { children.delete(proc); });
    return proc;
}
process.on('exit', function () {
    /* shairport-sync can ignore SIGTERM while blocked on its metadata pipe. */
    children.forEach(function (proc) { proc.kill('SIGKILL'); });
});

function log() {
    console.log.apply(console, [new Date().toISOString()].concat([].slice.call(arguments)));
}

/* ---------- Encoder: PCM in, MP3 out, fanned out to HTTP listeners ---------- */

function broadcast(chunk, set) {
    (set || clients).forEach(function (res) {
        if (res.writableLength > MAX_CLIENT_BACKLOG) {
            res.destroy();          /* a stalled TV must not stall everyone */
            (set || clients).delete(res);
            return;
        }
        res.write(chunk);
    });
}

/*
 * Uncompressed WAV for a live stream: a header that claims "unknown length"
 * (0xFFFFFFFF), then raw 16-bit stereo PCM. Every listener needs its own copy
 * of the header, so this path bypasses ffmpeg, and PCM is only forwarded in
 * whole 4-byte frames so a listener that joins mid-stream stays in sync.
 */
function wavHeader() {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(0xffffffff, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
    h.writeUInt16LE(2, 22); h.writeUInt32LE(RATE, 24); h.writeUInt32LE(BYTES_PER_SEC, 28);
    h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(0xffffffff, 40);
    return h;
}

let wavCarry = Buffer.alloc(0);
function broadcastWav(chunk) {
    const all = wavCarry.length ? Buffer.concat([wavCarry, chunk]) : chunk;
    const whole = all.length - (all.length % 4);
    wavCarry = all.slice(whole);
    if (whole) {
        broadcast(all.slice(0, whole), wavClients);
    }
}

function startEncoder() {
    const proc = track(spawn(FFMPEG, [
        '-loglevel', 'error',
        '-f', 's16le', '-ar', String(RATE), '-ac', '2', '-i', 'pipe:0',
        '-c:a', 'libmp3lame', '-b:a', BITRATE,
        '-write_xing', '0', '-id3v2_version', '0',
        '-flush_packets', '1',
        '-f', 'mp3', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'inherit'] }));

    proc.stdin.on('error', function () { /* encoder died; exit handler restarts */ });
    proc.stdout.on('data', function (chunk) { broadcast(chunk, clients); });
    proc.on('error', function (err) {
        log('ffmpeg failed to start:', err.message);
        process.exit(1);
    });
    proc.on('exit', function (code) {
        if (ffmpeg === proc) {
            ffmpeg = null;
        }
        if (!shuttingDown) {
            log('ffmpeg exited (' + code + '), restarting');
            setTimeout(function () { ffmpeg = startEncoder(); }, 500);
        }
    });
    return proc;
}

let lastPcmAt = 0;
let pcmBytes = 0;

function feedPcm(chunk, real) {
    if (real) {
        pcmBytes += chunk.length;
        lastPcmAt = Date.now();
        state.audio(chunk.length);
    }
    if (wavClients.size) {
        broadcastWav(chunk);
    }
    if (ffmpeg && ffmpeg.stdin.writable) {
        ffmpeg.stdin.write(chunk);
    }
}

/*
 * The HTTP stream must never stall while nothing is being cast, or the TV's
 * audio element gives up on it. Whenever real audio is absent the encoder is
 * fed silence at real-time pace, so a listener can stay connected through
 * pauses and between tracks.
 */
function startSilenceFeeder() {
    const silence = Buffer.alloc(Math.round(BYTES_PER_SEC * SILENCE_TICK_MS / 1000 / 4) * 4);
    return setInterval(function () {
        if (Date.now() - lastPcmAt > SILENCE_TICK_MS * 2) {
            feedPcm(silence, false);
        }
    }, SILENCE_TICK_MS);
}

/* ---------- shairport-sync ---------- */

function startShairport() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtizen-bridge-'));
    const fifo = path.join(dir, 'metadata');
    const conf = path.join(dir, 'shairport-sync.conf');

    const mk = spawnSync('mkfifo', [fifo]);
    if (mk.status !== 0) {
        log('mkfifo failed; metadata will be unavailable');
    }

    fs.writeFileSync(conf, [
        'general = {',
        '  name = "' + NAME.replace(/"/g, '') + '";',
        '  output_backend = "stdout";',
        AIRPLAY_PORT ? '  port = ' + AIRPLAY_PORT + ';' : '',
        '  airplay_device_id_offset = ' + DEVICE_ID_OFFSET + ';',
        '};',
        'stdout = {',
        '  output_rate = ' + RATE + ';',
        '  output_format = "S16_LE";',
        '  output_channels = 2;',
        '};',
        'metadata = {',
        '  enabled = "yes";',
        '  include_cover_art = "yes";',
        '  pipe_name = "' + fifo + '";',
        '  pipe_timeout = 5000;',
        '};',
        ''
    ].join('\n'));

    function launch() {
        const proc = track(spawn(SHAIRPORT, ['-c', conf], { stdio: ['ignore', 'pipe', 'inherit'] }));
        proc.stdout.on('data', function (chunk) { feedPcm(chunk, true); });
        proc.on('error', function (err) {
            log('could not start ' + SHAIRPORT + ': ' + err.message);
            process.exit(1);
        });
        proc.on('exit', function (code) {
            if (!shuttingDown) {
                log('shairport-sync exited (' + code + '), restarting in 2s');
                setTimeout(launch, 2000);
            }
        });
        return proc;
    }

    /* `cat` re-opens cleanly each time shairport closes and reopens the pipe. */
    function readMetadata() {
        const parser = new MetadataParser(function (item) {
            if (DEBUG) {
                log('meta ' + item.type + '/' + item.code + ' len=' + (item.data ? item.data.length : 0) +
                    (item.type === 'core' && item.data ? ' "' + item.data.toString('utf8').slice(0, 40) + '"' : ''));
            }
            state.handle(item);
        });
        const cat = track(spawn('cat', [fifo], { stdio: ['ignore', 'pipe', 'ignore'] }));
        cat.stdout.on('data', function (chunk) { parser.write(chunk); });
        cat.on('exit', function () {
            if (!shuttingDown) {
                setTimeout(readMetadata, 500);
            }
        });
    }

    const proc = launch();
    readMetadata();
    process.on('exit', function () {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    });
    return proc;
}

/* ---------- Demo source (no AirPlay needed; for testing the TV app) ---------- */

function crc32(buf) {
    if (zlib.crc32) {
        return zlib.crc32(buf);
    }
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function demoPng(size) {
    function chunk(type, data) {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
        return Buffer.concat([len, body, crc]);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.alloc((size * 3 + 1) * size);
    for (let y = 0; y < size; y++) {
        const row = y * (size * 3 + 1);
        for (let x = 0; x < size; x++) {
            raw[row + 1 + x * 3] = Math.round(255 * x / size);
            raw[row + 2 + x * 3] = Math.round(120 + 100 * y / size);
            raw[row + 3 + x * 3] = 220;
        }
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
    ]);
}

function startDemo() {
    function item(type, code, text) {
        state.handle({ type: type, code: code, data: text === null ? null : Buffer.from(text) });
    }
    const total = 30 * RATE;
    let phase = 0;
    let frames = 0;
    log('demo mode: playing a test tone as "Demo Tone / SubTizen Bridge"');
    item('ssnc', 'pbeg', null);
    item('ssnc', 'snam', 'Demo Device');
    item('ssnc', 'mdst', null);
    item('core', 'minm', 'Demo Tone');
    item('core', 'asar', 'SubTizen Bridge');
    item('core', 'asal', 'Test Signals');
    item('ssnc', 'mden', null);
    state.handle({ type: 'ssnc', code: 'PICT', data: demoPng(300) });

    const tick = 0.1;
    const samples = Math.round(RATE * tick);
    setInterval(function () {
        const buf = Buffer.alloc(samples * 4);
        for (let i = 0; i < samples; i++) {
            const v = Math.round(Math.sin(phase) * 8000);
            buf.writeInt16LE(v, i * 4);
            buf.writeInt16LE(v, i * 4 + 2);
            phase += 2 * Math.PI * 440 / RATE;
        }
        frames = (frames + samples) % total;
        item('ssnc', 'prgr', '0/' + frames + '/' + total);
        feedPcm(buf, true);
    }, tick * 1000);
}

/* ---------- HTTP ---------- */

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

const seenClients = new Set();

const server = http.createServer(function (req, res) {
    const url = req.url.split('?')[0];
    cors(res);

    /* Log each device the first time it shows up, to make "not reachable" debuggable. */
    const who = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (who && !seenClients.has(who) && who !== '127.0.0.1' && who !== '::1') {
        seenClients.add(who);
        log('first request from ' + who + ' (' + req.method + ' ' + url + ')');
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (url === '/status') {
        const body = JSON.stringify(Object.assign({
            name: NAME,
            tv: { bufferUnit: TV_BUFFER.unit, bufferAmount: TV_BUFFER.amount, format: TV_FORMAT }
        }, state.snapshot()));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(body);
        return;
    }

    if (url === '/cover') {
        if (!state.cover) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, {
            'Content-Type': state.cover.type,
            'Content-Length': state.cover.buf.length,
            'Cache-Control': 'max-age=3600'
        });
        res.end(state.cover.buf);
        return;
    }

    if (url === '/stream.mp3' || url === '/stream.wav') {
        const wav = url === '/stream.wav';
        res.writeHead(200, {
            'Content-Type': wav ? 'audio/wav' : 'audio/mpeg',
            'Cache-Control': 'no-store',
            'Accept-Ranges': 'none',
            'Connection': 'keep-alive',
            'icy-name': NAME
        });
        const set = wav ? wavClients : clients;
        if (wav) {
            res.write(wavHeader());
        }
        set.add(res);
        req.on('close', function () { set.delete(res); });
        return;
    }

    if (url === '/' || url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('subtizen-bridge "' + NAME + '" ok\n/status  /stream.mp3  /cover\n');
        return;
    }

    res.writeHead(404);
    res.end();
});

/* ---------- Main ---------- */

function shutdown() {
    shuttingDown = true;
    clients.forEach(function (res) { res.destroy(); });
    server.close();
    children.forEach(function (proc) { proc.kill('SIGTERM'); });
    /* Give shairport-sync a moment to withdraw its AirPlay advert, then force. */
    setTimeout(function () { process.exit(0); }, 1000).unref();
    if (!children.size) {
        process.exit(0);
    }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

ffmpeg = startEncoder();
startSilenceFeeder();
if (DEMO) {
    startDemo();
} else {
    startShairport();
}

if (DEBUG) {
    setInterval(function () {
        const snap = state.snapshot();
        log('debug pcm=' + Math.round(pcmBytes / 2 / 1024) + 'KB/s(realtime=172) state=' + snap.state +
            ' cover=' + (snap.cover ? 'yes' : 'no') +
            ' listeners=' + Array.from(clients).map(function (r) {
                return Math.round(r.writableLength / 1024) + 'KB-backlog';
            }).join(','));
        pcmBytes = 0;
    }, 2000);
}

server.listen(PORT, '0.0.0.0', function () {
    log('subtizen-bridge listening on :' + PORT + (DEMO ? ' (demo)' : ', AirPlay name "' + NAME + '"') + '');
});
