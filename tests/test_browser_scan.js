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
        emit(accuracy, timestamp = 100000) {
            position({coords: {latitude: 30, longitude: 78, accuracy}, timestamp});
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
    console.log('5 browser scan checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
