const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { JSDOM } = require("jsdom");
global.FSS = require("../map_assets/core");
global.DOMParser = new JSDOM("").window.DOMParser;
global.fflate = require("../map_assets/vendor/fflate");
global.initSqlJs = require("../map_assets/vendor/sql-asm");
require("../map_assets/files");
const C = FSS,
  IO = FSSFiles;
const sample = {
  time: Date.parse("2026-09-17T12:00:00Z"),
  accuracy: 3,
  verticalAccuracy: 5,
};
test("CSV handles quotes, line breaks, zero and invalid positions", () => {
  const f = IO.importCsv(
    'name,latitude,longitude,height\r\n"A, B",0,0,0\r\n"two\nlines",1,2,-10',
  );
  assert.equal(f[0].properties.name, "A, B");
  assert.equal(f[0].geometry.coordinates[2], 0);
  assert.equal(f[1].geometry.coordinates[2], -10);
  assert.throws(() => IO.importCsv("lat,lon\n,0"));
  assert.throws(() => IO.importCsv("lat,lon\nNaN,2"));
  assert.throws(() => IO.csvRows('"open'));
});
test("GeoJSON project roundtrip retains metadata and all geometry", async () => {
  const f = C.feature(
    "Polygon",
    [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
    "Area",
    { color: "#aa0000", folder: "Site" },
  );
  const blob = IO.exported([f], "geojson");
  const out = await IO.importLandmarks({
    name: "test.geojson",
    size: blob.size,
    text: () => blob.text(),
  });
  assert.deepEqual(out[0].geometry, f.geometry);
  assert.equal(out[0].properties.folder, "Site");
});
test("GPX preserves segment breaks and optional elevations and timestamps", async () => {
  const f = C.feature(
    "MultiLineString",
    [
      [
        [0, 0, 0],
        [0.001, 0, -2],
      ],
      [
        [1, 1],
        [1.001, 1, 5],
      ],
    ],
    "A & B",
    { samples: [sample, sample, sample, sample] },
  );
  const text = IO.toGpx([f]);
  const out = await IO.importLandmarks({
    name: "test.gpx",
    size: text.length,
    text: async () => text,
  });
  assert.deepEqual(out[0].geometry, f.geometry);
  assert.equal(out[0].properties.samples[0].time, sample.time);
  assert.equal(out[0].properties.samples[0].accuracy, 3);
  assert.equal(out[0].properties.name, "A & B");
});
test("KML preserves polygon holes, multi-lines and metadata without executing HTML", async () => {
  const f = C.feature(
    "Polygon",
    [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
      [
        [0.2, 0.2],
        [0.3, 0.2],
        [0.3, 0.3],
        [0.2, 0.2],
      ],
    ],
    "<script>alert(1)</script>",
    { heightReference: "WGS84 ellipsoid" },
  );
  const kml = IO.toKml([f]);
  assert.ok(!kml.includes("<script>"));
  const result = await IO.importLandmarks({
    name: "test.kml",
    size: kml.length,
    text: async () => kml,
  });
  assert.deepEqual(result[0].geometry, f.geometry);
  assert.equal(result[0].properties.name, f.properties.name);
  assert.equal(result[0].properties.heightReference, "WGS84 ellipsoid");
});
test("KMZ round trip and external XML entities reject", async () => {
  const f = C.feature("Point", [78, 30], "A");
  const blob = IO.exported([f], "kmz");
  const out = await IO.importLandmarks({
    name: "test.kmz",
    size: blob.size,
    arrayBuffer: () => blob.arrayBuffer(),
  });
  assert.deepEqual(out[0].geometry, f.geometry);
  const xml =
    '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><gpx></gpx>';
  await assert.rejects(
    IO.importLandmarks({
      name: "bad.gpx",
      size: xml.length,
      text: async () => xml,
    }),
    /entities/,
  );
});
test("CSV export mitigates spreadsheet formulas while retaining numerical heights", () => {
  const text = IO.toCsv([C.feature("Point", [0, 0, -20], "=SUM(1,2)")]);
  assert.match(text, /"'=SUM/);
  assert.match(text, /"-20"/);
});
test("raster MBTiles uses TMS row reversal and validates format", async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(
    "CREATE TABLE metadata (name TEXT,value TEXT);CREATE TABLE tiles (zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB);",
  );
  db.run("INSERT INTO metadata VALUES ('format','png')");
  db.run("INSERT INTO tiles VALUES (2,1,2,?)", [
    new Uint8Array([137, 80, 78, 71]),
  ]);
  const atlas = await IO.openMbtiles(db.export().buffer);
  assert.equal(atlas.min, 2);
  assert.deepEqual([...atlas.tile(2, 1, 1)], [137, 80, 78, 71]);
  assert.equal(atlas.tile(2, 1, 2), null);
  atlas.close();
  db.run("UPDATE metadata SET value='pbf'");
  await assert.rejects(IO.openMbtiles(db.export().buffer), /Only raster/);
  db.close();
});
test("malformed and oversized imports fail without a partial project", async () => {
  await assert.rejects(
    IO.importLandmarks({ name: "x.gpx", size: 50 * 1048576 }),
    /40 MB/,
  );
  await assert.rejects(
    IO.importLandmarks({
      name: "x.gpx",
      size: 10,
      text: async () => "<gpx><trk>",
    }),
    /Malformed/,
  );
  await assert.rejects(
    IO.importLandmarks({ name: "x.aqm", size: 2, text: async () => "" }),
    /Use GPX/,
  );
});

test("GPX orders waypoints before tracks and preserves explicit height reference", async () => {
  const track = C.feature(
    "LineString",
    [
      [0, 0, 1],
      [1, 0, 2],
    ],
    "Track",
    { heightReference: "WGS84 ellipsoid" },
  );
  const point = C.feature("Point", [0, 0, 3], "Point", {
    heightReference: "WGS84 ellipsoid",
  });
  const source = IO.toGpx([track, point]);
  assert.ok(source.indexOf("<wpt ") < source.indexOf("<trk>"));
  const doc = new DOMParser().parseFromString(source, "application/xml");
  const names = [...doc.getElementsByTagName("wpt")[0].children].map(
    (e) => e.localName,
  );
  assert.ok(names.indexOf("name") < names.indexOf("extensions"));
  const out = await IO.importLandmarks({
    name: "x.gpx",
    size: source.length,
    text: async () => source,
  });
  assert.ok(
    out.every((f) => f.properties.heightReference === "WGS84 ellipsoid"),
  );
});
