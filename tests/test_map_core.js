const { test } = require("node:test");
const assert = require("node:assert/strict");
const C = require("../map_assets/core");
const near = (a, b, t = 0.001) =>
  assert.ok(Math.abs(a - b) < t, `${a} != ${b}`);
test("WGS84 inverse uses ellipsoid, including antipodal points", () => {
  near(C.inverse([0, 0], [1, 0]).distance, 111319.49079327357);
  near(C.inverse([0, 0], [1, 0]).bearing, 90);
  near(C.inverse([0, 0], [180, 0]).distance, 20003931.458625447);
});
test("ellipsoidal polygon area and holes", () => {
  const outer = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
    hole = [
      [0.2, 0.2],
      [0.3, 0.2],
      [0.3, 0.3],
      [0.2, 0.3],
      [0.2, 0.2],
    ];
  const m = C.measure(C.feature("Polygon", [outer]));
  near(m.area, 12308778361.469452, 0.1);
  near(m.distance, 443770.91724830196, 0.01);
  assert.ok(C.measure(C.feature("Polygon", [outer, hole])).area < m.area);
});
test("finite coordinate validation does not coerce null or strings to zero", () => {
  for (const p of [
    [null, 0],
    ["0", 0],
    [NaN, 0],
    [0, 91],
    [181, 0],
  ])
    assert.throws(() => C.coord(p));
  assert.deepEqual(C.coord([0, 0, -10]), [0, 0, -10]);
});
test("UTM zones, exceptions, polar rejection and MGRS round trip", () => {
  assert.equal(C.utmZone([180, 0]), 60);
  assert.equal(C.utmZone([6, 60]), 32);
  assert.equal(C.utmZone([20, 78]), 33);
  const value = C.formatCoord([78.0322, 30.3165], "MGRS");
  const p = C.parsePosition(value, "MGRS");
  assert.ok(C.inverse([78.0322, 30.3165], p).distance < 2);
  assert.throws(() => C.formatCoord([0, 89], "UTM"));
});
test("DSM uses supplied standard parallels and false origin", () => {
  const raw = require("../data/dsm_zones.json"),
    degrees = (t) =>
      t
        .split(" ")
        .map(Number)
        .reduce((n, x, i) => n + x / 60 ** i, 0);
  const dsm = Object.fromEntries(
    raw.zones.map((p) => [
      p.zone,
      {
        ...p,
        latitude_of_origin: degrees(p.latitude_of_origin_dms),
        longitude_of_origin: degrees(p.longitude_of_origin_dms),
        standard_parallel_1: degrees(p.standard_parallel_1_dms),
        standard_parallel_2: degrees(p.standard_parallel_2_dms),
      },
    ]),
  );
  for (const p of Object.values(dsm)) {
    const label = C.formatCoord(
      [p.longitude_of_origin, p.latitude_of_origin],
      "DSM " + p.zone,
      { dsm },
    );
    assert.match(label, /E 500000.000 · N 500000.000/);
  }
  const p = C.parsePosition("310676.546960736,203340.560", "DSM 6D", { dsm });
  near(p[0], 78.0322, 0.0000001);
  near(p[1], 30.3165, 0.0000001);
  assert.throws(
    () => C.formatCoord([88, 39], "DSM 7C", { dsm }),
    /parameters required/,
  );
});
test("segmented profiles never connect across GPS gaps", () => {
  const f = C.feature(
    "MultiLineString",
    [
      [
        [0, 0, 0],
        [0.001, 0, 10],
      ],
      [
        [10, 0, 20],
        [10.001, 0, 15],
      ],
    ],
    "Track",
    {
      samples: [
        { time: 0 },
        { time: 10000 },
        { time: 100000 },
        { time: 110000 },
      ],
    },
  );
  const p = C.profile(f);
  near(p.total, 222.63898159, 0.01);
  assert.equal(p.rows[2].segmentStart, true);
  assert.equal(p.rows[2].speed, null);
  assert.equal(p.ascent, 10);
  assert.equal(p.descent, 5);
  assert.ok(p.rows[1].speed > 11);
});
test("missing altitude is null while zero and negative altitude survive", () => {
  const now = 100000;
  const base = {
    timestamp: now,
    coords: {
      longitude: 78,
      latitude: 30,
      accuracy: 3,
      altitude: null,
      altitudeAccuracy: null,
    },
  };
  assert.equal(C.gpsSample(base, now).p.length, 2);
  base.coords.altitude = 0;
  assert.equal(C.gpsSample(base, now).p[2], 0);
  base.coords.altitude = -20;
  assert.equal(C.gpsSample(base, now).p[2], -20);
  assert.throws(() => C.gpsSample(base, now + 16000));
});
test("recorder filters speed, poor accuracy, duplicates, stationary fixes and gaps", () => {
  const settings = {
    maxAccuracy: 30,
    interval: 2,
    minDistance: 3,
    maxSpeed: 50,
    gapSeconds: 30,
  };
  const a = { p: [0, 0], time: 1000, accuracy: 5 };
  assert.equal(C.acceptSample(null, a, settings).accept, true);
  assert.equal(C.acceptSample(a, { ...a, time: 2000 }, settings).accept, false);
  assert.equal(
    C.acceptSample(a, { ...a, time: 4000, accuracy: 31 }, settings).accept,
    false,
  );
  assert.equal(
    C.acceptSample(a, { ...a, p: [10, 0], time: 4000 }, settings).reason,
    "Speed / jump filter",
  );
  assert.equal(
    C.acceptSample(a, { ...a, time: 4000 }, settings).reason,
    "Stationary filter",
  );
  assert.equal(C.acceptSample(a, { ...a, time: 40000 }, settings).gap, true);
});
test("path following computes remaining distance and off-path position", () => {
  const route = C.feature("LineString", [
    [0, 0],
    [0.01, 0],
    [0.02, 0],
  ]);
  const p = C.routeProgress([0.005, 0.001], route);
  near(p.off, 110.5743, 0.05);
  near(p.remaining, 1669.7924, 0.1);
  const end = C.routeProgress([0.03, 0], route);
  near(end.remaining, 0, 0.001);
});
test("tile plan limits resource use and rejects crossing date line", () => {
  assert.equal(C.tilePlan([-1, -1, 1, 1], 0, 0).length, 1);
  assert.throws(() => C.tilePlan([-180, -85, 180, 85], 0, 18));
  assert.throws(() => C.tilePlan([179, -1, -179, 1], 2, 2));
  assert.throws(() => C.tilePlan([0, 0, 1, 1], 2.2, 3));
  assert.deepEqual(C.tileXY([180, 90], 0), [0, 0]);
});
test("HGT decodes big endian signed heights and treats voids as unavailable", () => {
  const b = new ArrayBuffer(2884802),
    v = new DataView(b);
  for (let i = 0; i < b.byteLength; i += 2) v.setInt16(i, -20, false);
  const h = new C.Hgt("N30E078.hgt", b);
  assert.equal(h.height([78.5, 30.5]), -20);
  assert.equal(h.height([79.5, 30.5]), null);
  v.setInt16((600 * 1201 + 600) * 2, -32768, false);
  assert.equal(h.height([78.5, 30.5]), null);
  assert.throws(() => new C.Hgt("bad.hgt", b));
  assert.throws(() => new C.Hgt("N30E078.hgt", new ArrayBuffer(4)));
});
test("project validation preserves unknown height without inventing it", () => {
  const f = C.feature("Point", [0, 0], "test", {
    samples: [{ time: 0, accuracy: null }],
  });
  const [out] = C.validateFeatures({
    type: "FeatureCollection",
    features: [f],
  });
  assert.equal(out.properties.samples[0].time, 0);
  assert.equal(out.properties.samples[0].accuracy, null);
  assert.equal(out.geometry.coordinates.length, 2);
  assert.throws(() =>
    C.validateFeatures(
      C.feature("Polygon", [
        [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ],
      ]),
    ),
  );
});

test("self-crossing and zero-area boundaries cannot produce misleading property areas", () => {
  for (const ring of [
    [
      [0, 0],
      [1, 1],
      [0, 1],
      [1, 0],
      [0, 0],
    ],
    [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 0],
    ],
  ]) {
    assert.throws(
      () => C.validateFeatures(C.feature("Polygon", [ring])),
      /crosses|zero area/,
    );
  }
});

test("Terrarium sample is raw ground height with explicit missing tiles", () => {
  const image = {
    width: 2,
    height: 2,
    data: new Uint8Array([
      128, 0, 0, 255, 128, 0, 0, 255, 128, 0, 0, 255, 128, 0, 0, 255,
    ]),
  };
  assert.equal(C.terrariumHeight([0, 0], [0, 0, 0], image), 0);
  image.data = new Uint8Array([
    127, 246, 0, 255, 127, 246, 0, 255, 127, 246, 0, 255, 127, 246, 0, 255,
  ]);
  assert.equal(C.terrariumHeight([0, 0], [0, 0, 0], image), -10);
  image.data.fill(0);
  assert.equal(C.terrariumHeight([0, 0], [0, 0, 0], image), null);
});
