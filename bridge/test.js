'use strict';
/* Run with: node bridge/test.js */
const assert = require('assert');
const { MetadataParser, AirPlayState } = require('./metadata');

const hex = (s) => Buffer.from(s).toString('hex');
const item = (t, c, d) => {
    const data = d == null ? null : (Buffer.isBuffer(d) ? d : Buffer.from(d));
    return '<item><type>' + hex(t) + '</type><code>' + hex(c) + '</code><length>' +
        (data ? data.length : 0) + '</length>' +
        (data ? '\n<data encoding="base64">\n' + data.toString('base64') + '\n</data>' : '') +
        '</item>\n';
};
const SECOND = 44100 * 4;                    /* PCM bytes per second */

function fresh() {
    const clock = { t: 1000000 };
    const state = new AirPlayState({ now: () => clock.t });
    const parser = new MetadataParser((i) => state.handle(i));
    return { clock, state, parser, feed: (text) => parser.write(text) };
}

/* ---- a full session, fed in tiny chunks: parsing and basic state ---- */
{
    const { clock, state, parser } = fresh();
    assert.strictEqual(state.snapshot().state, 'idle');

    const stream =
        item('ssnc', 'conn', '192.168.0.20') + item('ssnc', 'snam', 'My iPhone') +
        item('ssnc', 'pbeg') + item('ssnc', 'prgr', '1000/1000/442000') +
        item('ssnc', 'mdst') + item('core', 'minm', 'Song') + item('core', 'asar', 'Artist') +
        item('core', 'asal', 'Album') + item('ssnc', 'mden');
    for (let i = 0; i < stream.length; i += 7) {          /* arbitrary chunking */
        parser.write(stream.slice(i, i + 7));
    }
    state.audio(SECOND * 3);

    let s = state.snapshot();
    assert.strictEqual(s.state, 'playing');
    assert.strictEqual(s.title, 'Song');
    assert.strictEqual(s.client, 'My iPhone', 'client name survives the play-begin message');
    assert.strictEqual(s.duration, 10, 'duration is kept although the tags arrive after prgr');
    assert.strictEqual(s.position, 3);

    /* ---- pause: position must freeze, not jump back to 0 ---- */
    clock.t += 5000;
    parser.write(item('ssnc', 'pfls'));
    s = state.snapshot();
    assert.strictEqual(s.state, 'paused');
    assert.strictEqual(s.position, 3, 'position stays where playback stopped');

    /* ---- the sender ends the play session, but stays connected ---- */
    parser.write(item('ssnc', 'pend'));
    clock.t += 120000;                                    /* two minutes paused */
    s = state.snapshot();
    assert.strictEqual(s.state, 'paused', 'a pause is not a disconnect');
    assert.strictEqual(s.title, 'Song', 'track info is kept while paused');
    assert.strictEqual(s.position, 3);

    /* ---- resume: position continues from where it was ---- */
    state.audio(SECOND * 2);
    s = state.snapshot();
    assert.strictEqual(s.state, 'playing');
    assert.strictEqual(s.position, 5);

    /* ---- a real disconnect goes idle (after a short grace period) ---- */
    clock.t += 3000;
    parser.write(item('ssnc', 'disc', '192.168.0.20'));
    assert.strictEqual(state.snapshot().state, 'paused', 'grace period right after disc');
    clock.t += 2500;
    s = state.snapshot();
    assert.strictEqual(s.state, 'idle');
    assert.strictEqual(s.title, '');

    /* ---- a new connection starts clean ---- */
    parser.write(item('ssnc', 'conn', '192.168.0.50') + item('ssnc', 'snam', 'iPad'));
    s = state.snapshot();
    assert.strictEqual(s.state, 'paused', 'connected, nothing playing yet');
    assert.strictEqual(s.client, 'iPad');
    assert.strictEqual(s.title, '');
}

/* ---- safety net: a lost disconnect eventually goes idle ---- */
{
    const { clock, state, parser } = fresh();
    parser.write(item('ssnc', 'conn', '1.2.3.4') + item('ssnc', 'pbeg'));
    state.audio(SECOND);
    clock.t += 31 * 60 * 1000;
    assert.strictEqual(state.snapshot().state, 'idle');
}

/* ---- a disc that straddles a reconnect must not kill the new session ---- */
{
    const { clock, state, parser } = fresh();
    parser.write(item('ssnc', 'conn', '1.2.3.4') + item('ssnc', 'pbeg'));
    state.audio(SECOND);
    clock.t += 10000;
    parser.write(item('ssnc', 'conn', '1.2.3.4'));         /* reconnect ... */
    clock.t += 100;
    parser.write(item('ssnc', 'disc', '1.2.3.4'));         /* ... then the old session's disc */
    clock.t += 5000;
    assert.strictEqual(state.snapshot().state, 'paused');
}

/* ---- cover art arrives just BEFORE the track tags and must survive ---- */
{
    const { clock, state, parser } = fresh();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    parser.write(
        item('ssnc', 'pbeg') + item('ssnc', 'PICT', jpeg) +
        item('ssnc', 'mdst') + item('core', 'minm', 'Track A') + item('ssnc', 'mden'));
    state.audio(SECOND);
    const first = state.snapshot();
    assert.ok(first.cover, 'cover sent just before the tags is kept');

    clock.t += 60000;                                      /* next track, no new artwork */
    state.audio(SECOND);
    parser.write(item('ssnc', 'mdst') + item('core', 'minm', 'Track B') + item('ssnc', 'mden'));
    assert.strictEqual(state.snapshot().cover, null, 'stale cover is dropped for a new track');

    parser.write(item('ssnc', 'pbeg') + item('ssnc', 'PICT', jpeg));
    state.audio(SECOND);
    assert.notStrictEqual(state.snapshot().cover, first.cover, 'cover URL changes so the TV refetches');
}

console.log('bridge tests passed');
