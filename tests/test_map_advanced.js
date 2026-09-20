const { test } = require("node:test"),
  assert = require("node:assert/strict");
const C = require("../map_assets/core"),
  G = require("../map_assets/advanced-core");
const point = (x, y, p = {}) =>
  C.feature("Point", [x, y], "Point", { attributes: p });
const polygon = C.feature(
  "Polygon",
  [
    [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ],
  ],
  "Mask",
);
test("thematic styles retain numeric zero, missing values and original geometry", () => {
  const fs = [
    point(0, 0, { value: 0, type: "A" }),
    point(1, 0, { value: 10, type: "B" }),
    point(2, 0, { value: null, type: "B" }),
  ];
  const styled = G.styleFeatures(fs, { mode: "graduated", field: "value" });
  assert.equal(styled[0].properties._radius, 4);
  assert.equal(styled[1].properties._radius, 16);
  assert.equal(styled[2].properties.color, "#999999");
  assert.equal(fs[0].properties._radius, undefined);
  const categories = G.styleFeatures(fs, {
    mode: "categorized",
    field: "type",
  });
  assert.notEqual(
    categories[0].properties.color,
    categories[1].properties.color,
  );
  assert.equal(categories[1].properties.color, categories[2].properties.color);
});
test("labels enforce margin and duplicate distance across layers", () => {
  const candidates = [
    { text: "A", x: 0, y: 0, width: 20 },
    { text: "B", x: 23, y: 0, width: 20 },
    { text: "A", x: 70, y: 0, width: 20 },
    { text: "A", x: 200, y: 0, width: 20 },
  ];
  assert.equal(
    G.labelLayout(candidates, { margin: 6, deduplicate: true, distance: 120 })
      .length,
    2,
  );
  assert.equal(
    G.labelLayout(candidates, { margin: 0, deduplicate: false }).length,
    4,
  );
});
test("field customization checks keys and case collisions without changing geometry", () => {
  const fs = [
    point(0, 0, { ID: 1, Value: 0 }),
    point(1, 0, { ID: 2, Value: 3 }),
  ];
  const out = G.configureFields(fs, {
    fields: ["ID", "Value"],
    primaryKey: "ID",
    caseMode: "lower",
  });
  assert.equal(out[0].properties.attributes.value, 0);
  assert.deepEqual(out[0].geometry, fs[0].geometry);
  assert.throws(
    () => G.configureFields([fs[0], fs[0]], { primaryKey: "ID" }),
    /duplicates/,
  );
  assert.throws(
    () =>
      G.configureFields([point(0, 0, { A: 1, a: 2 })], {
        fields: ["A", "a"],
        caseMode: "lower",
      }),
    /duplicate field/,
  );
});
test("buffer, clip, intersection, dissolve and centroid produce real geometries", () => {
  const buffered = G.analyze("buffer", [point(78, 30)], null, 100);
  assert.equal(buffered[0].geometry.type, "Polygon");
  const first = buffered[0].geometry.coordinates[0][0];
  assert.ok(Math.abs(C.inverse([78, 30], first).distance - 100) < 1);
  assert.equal(
    G.analyze("clip", [point(1, 1), point(3, 3)], polygon).length,
    1,
  );
  const overlap = C.feature("Polygon", [
    [
      [1, 1],
      [3, 1],
      [3, 3],
      [1, 3],
      [1, 1],
    ],
  ]);
  assert.equal(
    G.analyze("intersection", [overlap], polygon)[0].geometry.type,
    "Polygon",
  );
  assert.equal(G.analyze("dissolve", [overlap, polygon]).length, 1);
  assert.deepEqual(
    G.analyze("centroid", [polygon])[0].geometry.coordinates,
    [1, 1],
  );
  assert.throws(
    () => G.analyze("buffer", [point(0, 0)], null, NaN),
    /distance/,
  );
});
test("import splits multi-geometries and preserves useful attributes safely", () => {
  const fs = G.normalize(
    {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "MultiPoint",
            coordinates: [
              [1, 2],
              [3, 4],
            ],
          },
          properties: { value: 0, name: "name", html: "<script>bad</script>" },
        },
      ],
    },
    "Layer",
  );
  assert.equal(fs.length, 2);
  assert.equal(fs[0].properties.attributes.value, 0);
  assert.equal(fs[0].properties.folder, "Layer");
  const cleaned = G.attributes(
    JSON.parse('{"__proto__":{"polluted":true},"constructor":"bad","value":1}'),
  );
  assert.equal(cleaned.value, 1);
  assert.equal(cleaned.constructor, undefined);
});
test("WMS uses explicit Mercator axis order and refuses embedded credentials", () => {
  const u = G.wmsURL(
    "https://example.test/wms?request=GetCapabilities",
    "land",
  );
  assert.match(u, /VERSION=1.1.1/);
  assert.match(u, /BBOX=\{bbox-epsg-3857\}/);
  assert.match(u, /SRS=EPSG%3A3857/);
  assert.throws(() => G.wmsURL("http://example.test", "x"), /HTTPS/);
  assert.throws(() => G.wmsURL("https://u:p@example.test", "x"), /credentials/);
});
test("scale references change with latitude and reject globe or tilt", () => {
  const map = {
    getPitch: () => 0,
    getProjection: () => ({ type: "mercator" }),
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }),
    getZoom: () => 10,
    unproject: (p) => ({ lng: p[0] / 100, lat: 60 - p[1] / 10 }),
  };
  assert.ok(G.scaleAt(map, "top") < G.scaleAt(map, "bottom"));
  assert.ok(G.scaleAt(map, "average") > 0);
  map.getProjection = () => ({ type: "globe" });
  assert.equal(G.scaleAt(map), null);
});
