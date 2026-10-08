const { test } = require('node:test');
const assert = require('node:assert/strict');
const { XyzGrid, terrainProfile } = require('../map_assets/dem');
const C = require('../map_assets/core');
const opts = { crs: 'EPSG:4326', units: 'metres', reference: 'Test vertical datum' };
const text = '78 30 0\n78.01 30 10\n78 30.01 20\n78.01 30.01 30';
test('XYZ handles row order, interpolation, exact edges and source zero without extrapolation', () => {
  const g = new XyzGrid('grid.xyz', text.split('\n').reverse().join('\n'), opts);
  assert.equal(g.width, 2); assert.equal(g.heightCount, 2);
  assert.equal(g.height([78, 30]), 0);
  assert.ok(Math.abs(g.height([78.005, 30.005]) - 15) < 1e-8);
  assert.equal(g.height([78.01, 30.01]), 30);
  assert.equal(g.height([77.999, 30]), null);
  assert.equal(g.reference, 'Test vertical datum');
});
test('XYZ preserves voids, converts explicit feet and never assumes CRS or units', () => {
  const g = new XyzGrid('grid.xyz', text, { ...opts, nodata: '0' });
  assert.equal(g.height([78, 30]), null);
  assert.equal(g.height([78.005, 30.005]), null);
  assert.equal(g.height([78.01, 30.01]), 30);
  assert.equal(new XyzGrid('grid.xyz', text, { ...opts, units: 'feet' }).height([78.01, 30.01]), 9.144);
  assert.throws(() => new XyzGrid('g', text), /Confirm/);
  assert.throws(() => new XyzGrid('g', text, { ...opts, units: '' }), /units/);
  assert.throws(() => new XyzGrid('g', text, { ...opts, nodata: 'bad' }), /No-data/);
});
test('XYZ rejects malformed, non-finite, duplicate, incomplete and irregular grids', () => {
  for (const bad of ['78 30 NaN', '78 30 3 4', '78 30 2x', '500000 3300000 12']) {
    assert.throws(() => new XyzGrid('g', bad, opts));
  }
  assert.throws(() => new XyzGrid('g', text.split('\n').slice(0, 3).join('\n'), opts), /rectangular/);
  assert.throws(() => new XyzGrid('g', '78 30 0\n78 30 0\n78 30.01 20\n78.01 30.01 30', opts), /duplicate/);
  assert.throws(() => new XyzGrid('g', '0 0 1\n1 0 2\n3 0 3\n0 1 1\n1 1 2\n3 1 3', opts), /regular/);
  assert.throws(() => new XyzGrid('g', text.replace('30 0', '30 -99999'), opts), /renderer range/);
});
test('local terrain profile densifies the route and retains source geometry and datum', () => {
  const g = new XyzGrid('g', text, opts);
  const line = C.feature('LineString', [[78.001,30.001,999],[78.009,30.009,999]], 'Route');
  const before = JSON.stringify(line);
  const f = terrainProfile(line, [g], 100);
  assert.equal(JSON.stringify(line), before);
  assert.ok(f.geometry.coordinates.length > 2);
  assert.ok(Math.abs(f.geometry.coordinates[0][2] - 3) < 1e-8);
  assert.ok(Math.abs(f.geometry.coordinates.at(-1)[2] - 27) < 1e-8);
  assert.equal(f.properties.heightReference, opts.reference);
  assert.ok(C.profile(f).ascent > 23.99);
  assert.throws(() => terrainProfile(line, [], 100), /Import/);
  assert.throws(() => terrainProfile(C.feature('LineString', [[78,30],[80,31]]), [g], 100), /missing terrain/);
  assert.throws(() => terrainProfile(line, [g], 0), /spacing/);
  assert.throws(() => terrainProfile(C.feature('Point', [78,30]), [g], 100), /single route/);
});
