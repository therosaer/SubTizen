/*
 * keys.js - Tizen remote key registration and keycode constants.
 *
 * Tizen only delivers media and number keys to the page if the app registers
 * them first via tizen.tvinputdevice. Without registration the keydown events
 * simply never arrive, so registration is not optional.
 *
 * The keycode a remote sends for a media key is NOT fixed across TV models.
 * Hardcoding 415 for "play" works on some sets and silently does nothing on
 * others. The reliable approach is to ask the device which keys it supports,
 * register them, and then map the code the device reports back to the key
 * name. `nameForCode()` exposes that mapping so the app can dispatch on the
 * name instead of a guessed number.
 *
 * Registration is best-effort: on a desktop browser (or any non-Tizen host)
 * `tizen` is undefined and we silently skip it, which keeps the app testable.
 */
(function (global) {
    'use strict';

    /* Fallback codes, used only when the device cannot tell us its own. */
    var KEYS = {
        ENTER: 13,
        TIZEN_ENTER: 29443,
        BACK: 10009,
        RETURN: 461,

        UP: 38,
        DOWN: 40,
        LEFT: 37,
        RIGHT: 39,

        MEDIA_PLAY: 415,
        MEDIA_PAUSE: 19,
        MEDIA_STOP: 413,
        MEDIA_REWIND: 412,
        MEDIA_FAST_FORWARD: 417,
        MEDIA_PLAY_PAUSE: 10252,
        MEDIA_TRACK_NEXT: 10253,
        MEDIA_TRACK_PREVIOUS: 10254,

        /*
         * Some Samsung remotes send the skip buttons as plain fast-forward and
         * rewind, or as the older KEY_NEXT / KEY_PREVIOUS codes, rather than as
         * MediaTrackNext / MediaTrackPrevious. These are accepted as aliases so
         * the skip buttons work on those sets too.
         */
        MEDIA_NEXT_ALT: 10255,
        MEDIA_PREV_ALT: 10256,
        MEDIA_NEXT_ALT2: 417,
        MEDIA_PREV_ALT2: 412,

        NUM_0: 48,
        NUM_9: 57
    };

    /*
     * Names accepted by tizen.tvinputdevice.registerKey(). These are the DOM
     * Level 3 media-controller key values. Not every model supports every
     * name, which is why registration is attempted individually.
     */
    var MEDIA_KEY_NAMES = [
        'MediaPlay',
        'MediaPause',
        'MediaPlayPause',
        'MediaStop',
        'MediaRewind',
        'MediaFastForward',
        'MediaTrackNext',
        'MediaTrackPrevious'
    ];

    var NUMBER_KEY_NAMES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

    /* name -> code, filled in from the device during registerAll(). */
    var codeByName = {};
    /* code -> name, the reverse lookup used when a key arrives. */
    var nameByCode = {};

    function manager() {
        if (!global.tizen) {
            return null;
        }
        /* Tizen 2.4 exposes tvinputdevice; newer firmware uses inputdevice. */
        return global.tizen.tvinputdevice || global.tizen.inputdevice || null;
    }

    function registerOne(mgr, name) {
        try {
            mgr.registerKey(name);
            return true;
        } catch (e) {
            /* Key unsupported on this model/firmware; harmless. */
            return false;
        }
    }

    /*
     * Register every media and number key the device reports as supported and
     * record the code it uses for each. Returns true when running on Tizen.
     *
     * On some sets `tizen.tvinputdevice` is not populated at window load, so
     * this is retried a few times before giving up.
     */
    function registerAll() {
        var mgr = manager();
        var supported, i, name, code;

        if (!mgr) {
            return false;
        }

        /* Preferred path: ask the device what it has and what codes it uses. */
        if (typeof mgr.getSupportedKeys === 'function') {
            try {
                supported = mgr.getSupportedKeys() || [];
            } catch (e) {
                supported = [];
            }
            for (i = 0; i < supported.length; i++) {
                name = supported[i].name;
                code = supported[i].code;
                if (name && typeof code === 'number') {
                    codeByName[name] = code;
                    nameByCode[code] = name;
                }
            }
        }

        /* Register the keys we care about, whether or not they were listed. */
        for (i = 0; i < MEDIA_KEY_NAMES.length; i++) {
            registerOne(mgr, MEDIA_KEY_NAMES[i]);
        }
        for (i = 0; i < NUMBER_KEY_NAMES.length; i++) {
            registerOne(mgr, NUMBER_KEY_NAMES[i]);
        }

        return true;
    }

    /*
     * The code this device uses for a media key name, or null when the device
     * did not report one. Callers should prefer matching on the name via
     * `nameForCode` and only fall back to a constant.
     */
    function codeFor(name) {
        return codeByName.hasOwnProperty(name) ? codeByName[name] : null;
    }

    /* The media key name for a keycode, or null if it is not a media key. */
    function nameForCode(code) {
        return nameByCode.hasOwnProperty(code) ? nameByCode[code] : null;
    }

    /*
     * Retry registration until the device API appears. Tizen 2.4 sometimes
     * exposes tizen.tvinputdevice a moment after window load, and registering
     * late is still better than never: the keys simply start arriving once the
     * call succeeds.
     */
    function registerWhenReady(attempts) {
        var left = typeof attempts === 'number' ? attempts : 10;
        if (registerAll()) {
            return;
        }
        if (left <= 0) {
            return;
        }
        global.setTimeout(function () {
            registerWhenReady(left - 1);
        }, 500);
    }

    /*
     * Re-register whenever the app becomes visible again. Tizen drops media
     * key registrations when the app is backgrounded (for example while the
     * TV's own player or the Smart Hub is in front), so without this the
     * remote's play/pause buttons stop working after the first app switch.
     * `viewshow` is the Tizen lifecycle event for "app is now on screen".
     */
    function bindLifecycle() {
        if (!global.tizen) {
            return;
        }
        global.addEventListener('viewshow', function () {
            registerAll();
        }, false);
        global.addEventListener('focus', function () {
            registerAll();
        }, false);
    }

    function isNumberKey(keyCode) {
        return keyCode >= KEYS.NUM_0 && keyCode <= KEYS.NUM_9;
    }

    function numberFromKey(keyCode) {
        return keyCode - KEYS.NUM_0;
    }

    global.RemoteKeys = {
        KEYS: KEYS,
        registerAll: registerAll,
        codeFor: codeFor,
        nameForCode: nameForCode,
        registerWhenReady: registerWhenReady,
        bindLifecycle: bindLifecycle,
        isNumberKey: isNumberKey,
        numberFromKey: numberFromKey
    };
}(this));
