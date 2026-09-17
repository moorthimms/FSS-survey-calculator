// Run with node tests/test_browser_scan.js. No browser hardware is simulated as real GPS.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'own_position.py'), 'utf8');
const scan = source.match(/BROWSER_SCAN = """([\s\S]*?)"""/)[1];

function harness(supported = true) {
    const timers = new Map(), cleared = [];
    let position, failure;
    const navigator = supported ? {geolocation: {
        watchPosition(ok, error, options) {
            position = ok; failure = error;
            assert.equal(options.maximumAge, 0);
            assert.equal(options.enableHighAccuracy, true);
            return 0;
        },
        clearWatch(id) { cleared.push(id); }
    }} : {};
    const result = vm.runInNewContext(scan, {
        navigator, Date: {now: () => 100000},
        setTimeout(fn) { timers.set(1, fn); return 1; },
        clearTimeout(id) { timers.delete(id); }
    });
    return {result, timers, cleared,
        emit(accuracy, timestamp = 100000, altitude = 120, altitudeAccuracy = 3) {
            position({coords: {latitude: 30, longitude: 78, accuracy, altitude, altitudeAccuracy}, timestamp});
        }, fail(code) { failure({code, message: 'denied'}); },
        timeout() { for (const fn of [...timers.values()]) fn(); }
    };
}

(async () => {
    let h = harness();
    h.emit(0.9);
    assert.equal((await h.result).coords.accuracy, 0.9);
    assert.deepEqual(h.cleared, [0]);
    assert.equal(h.timers.size, 0);

    h = harness();
    h.emit(8); h.emit(3); h.emit(6); h.timeout();
    assert.equal((await h.result).coords.accuracy, 3);
    assert.deepEqual(h.cleared, [0]);

    h = harness();
    h.fail(1);
    assert.equal((await h.result).error.code, 1);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.cleared, [0]);

    h = harness();
    h.emit(NaN); h.emit(0.01, 0); h.timeout();
    assert.equal((await h.result).error.code, 3);

    h = harness(false);
    assert.equal((await h.result).error.code, 2);
    assert.equal(h.timers.size, 0);

    h = harness();
    h.emit(0.5, 100000, null, null);
    assert.equal(h.timers.size, 1); // Do not stop before altitude becomes available.
    h.emit(0.8, 100100, 55, 2);
    let result = await h.result;
    assert.equal(result.coords.altitude, 55);
    assert.equal(result.coords.altitudeAccuracy, 2);
    assert.equal(result.timestamp, 100100);

    h = harness();
    h.emit(2, 100000, null, null);
    h.emit(8, 100100, 80, 4);
    h.emit(3, 100200, null, null);
    h.timeout();
    result = await h.result;
    assert.equal(result.coords.altitude, 80);
    assert.equal(result.coords.accuracy, 8);
    assert.equal(result.timestamp, 100100); // Keep a complete sample, never mix epochs.

    h = harness();
    h.emit(0.4, 100000, null, null);
    h.timeout();
    result = await h.result;
    assert.equal(result.coords.altitude, null);
    assert.equal(result.coords.altitudeAccuracy, null);
    assert.equal(result.coords.accuracy, 0.4);

    for (const height of [0, -12.5]) {
        h = harness();
        h.emit(0.9, 100000, height, 0);
        result = await h.result;
        assert.equal(result.coords.altitude, height);
        assert.equal(result.coords.altitudeAccuracy, 0);
    }

    h = harness();
    h.emit(0.9, 100000, Infinity, NaN);
    h.timeout();
    result = await h.result;
    assert.equal(result.coords.altitude, null);
    assert.equal(result.coords.altitudeAccuracy, null);
    console.log('11 browser scan scenarios passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
