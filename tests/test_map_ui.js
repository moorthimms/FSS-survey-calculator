/* DOM integration with deterministic device/storage/map adapters.
   Real WebGL and physical sensor validation are separate field checks. */
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { JSDOM } = require("jsdom"),
  { IDBFactory } = require("fake-indexeddb");
const root = path.resolve(__dirname, "../map_assets");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await delay(10);
  }
  throw Error("Timed out waiting for UI state.");
}
async function setup(storage = new IDBFactory()) {
  const dom = new JSDOM(
    fs.readFileSync(path.join(root, "index.html"), "utf8"),
    {
      url: "https://fss.test",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  const w = dom.window;
  w.structuredClone = structuredClone;
  w.indexedDB = storage;
  w.TextDecoder = TextDecoder;
  w.TextEncoder = TextEncoder;
  w.URL.createObjectURL = () => "";
  w.URL.revokeObjectURL = () => {};
  const protocols = {};
  let currentMap,
    locationHandler,
    cleared = 0;
  class MapAdapter {
    constructor(options) {
      this.center = options.center;
      this.zoom = options.zoom;
      this.layers = {};
      this.sources = {};
      this.events = {};
      currentMap = this;
    }
    on(name, fn) {
      (this.events[name] ??= []).push(fn);
      if (name === "load") setTimeout(() => fn(), 0);
      return this;
    }
    addControl() {}
    getCenter() {
      return {
        lng: this.center[0],
        lat: this.center[1],
        toArray: () => this.center,
      };
    }
    getZoom() {
      return this.zoom;
    }
    setZoom(z) {
      this.zoom = z;
    }
    easeTo(o) {
      this.jumpTo(o);
    }
    jumpTo(o) {
      if (o.center)
        this.center = Array.isArray(o.center)
          ? o.center
          : [o.center.lng, o.center.lat];
      if (o.zoom) this.zoom = o.zoom;
      this.events.move?.forEach((fn) => fn());
    }
    getBounds() {
      return {
        getWest: () => this.center[0] - 0.01,
        getEast: () => this.center[0] + 0.01,
        getSouth: () => this.center[1] - 0.01,
        getNorth: () => this.center[1] + 0.01,
        contains: () => true,
      };
    }
    addSource(id, s) {
      this.sources[id] = {
        ...s,
        setData(d) {
          this.data = d;
        },
      };
    }
    getSource(id) {
      return this.sources[id];
    }
    removeSource(id) {
      delete this.sources[id];
    }
    addLayer(l) {
      this.layers[l.id] = l;
    }
    getLayer(id) {
      return this.layers[id];
    }
    removeLayer(id) {
      delete this.layers[id];
    }
    setPaintProperty() {}
    setTerrain(t) {
      this.terrain = t;
    }
    setPitch(v) {
      this.pitch = v;
    }
    setBearing(v) {
      this.bearing = v;
    }
    queryTerrainElevation() {
      return null;
    }
    resize() {}
    fitBounds() {}
    queryRenderedFeatures() {
      return [];
    }
  }
  class Marker {
    setLngLat(p) {
      this.p = p;
      return this;
    }
    addTo() {
      return this;
    }
    remove() {}
    on() {}
    getLngLat() {
      return { lng: this.p[0], lat: this.p[1] };
    }
  }
  w.maplibregl = {
    Map: MapAdapter,
    Marker,
    NavigationControl: class {},
    FullscreenControl: class {},
    ScaleControl: class {
      setUnit() {}
    },
    LngLatBounds: class {
      extend() {}
    },
    addProtocol: (name, fn) => (protocols[name] = fn),
  };
  w.HTMLCanvasElement.prototype.getContext = () => ({
    clearRect() {},
    fillText() {},
    strokeRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    createImageData: () => ({ data: new Uint8ClampedArray(256 * 256 * 4) }),
    putImageData() {},
  });
  Object.defineProperty(w.navigator, "geolocation", {
    value: {
      watchPosition(fn) {
        locationHandler = fn;
        return 42;
      },
      clearWatch() {
        cleared++;
      },
    },
  });
  const raw = JSON.parse(
      fs.readFileSync(path.resolve(root, "../data/dsm_zones.json")),
    ),
    degrees = (t) =>
      t
        .split(" ")
        .map(Number)
        .reduce((v, x, i) => v + x / 60 ** i, 0);
  w.FSS_CONFIG = {
    catalog: ["6D", "7C"],
    dsm: Object.fromEntries(
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
    ),
  };
  for (const name of [
    "vendor/geographiclib.js",
    "vendor/proj4.js",
    "vendor/mgrs.js",
    "core.js",
    "files.js",
    "app.js",
  ])
    w.eval(fs.readFileSync(path.join(root, name), "utf8"));
  const $ = (id) => w.document.getElementById(id),
    click = async (id) => {
      $(id).click();
      await delay(15);
    },
    change = async (id, value) => {
      $(id).value = value;
      $(id).dispatchEvent(new w.Event("change"));
      await delay(5);
    };
  await waitFor(() => $("message").textContent.startsWith("Ready."));
  return {
    w,
    $,
    click,
    change,
    map: currentMap,
    protocols,
    position: (p) => locationHandler(p),
    cleared: () => cleared,
    close: () => {
      w.dispatchEvent(new w.Event("pagehide"));
      w.close();
    },
  };
}
test("map initializes and all six tool panels are selectable", async () => {
  const t = await setup();
  try {
    for (const panel of [
      "draw",
      "landmarks",
      "gps",
      "layers",
      "terrain",
      "settings",
    ]) {
      await t.change("panel-select", panel);
      assert.equal(t.$("panel-" + panel).hidden, false);
    }
    assert.match(t.$("coord-primary").textContent, /30.3165000/);
    assert.ok(t.map.sources.landmarks);
    assert.ok(t.map.layers.basemap);
    assert.equal(t.$("basemap").value, "india-topo");
    assert.equal(
      t.map.sources.basemap.tiles[0],
      "https://indianopenmaps.fly.dev/soi/osm/{z}/{x}/{y}.webp",
    );
    assert.equal(t.map.sources.basemap.maxzoom, 14);
    assert.equal(t.map.sources.basemap.tileSize, 256);
    assert.match(t.map.sources.basemap.attribution, /Survey of India/);
    assert.equal(t.$("basemap-note").hidden, false);
    await t.change("basemap", "osm");
    assert.equal(t.$("basemap-note").hidden, true);
    assert.match(t.map.sources.basemap.tiles[0], /tile.openstreetmap.org/);
    await t.change("basemap", "india-topo");
    assert.equal(t.$("basemap-note").hidden, false);
  } finally {
    t.close();
  }
});
test("waypoint create, rename, visibility, delete and restore workflow", async () => {
  const t = await setup();
  try {
    await t.change("draw-mode", "Point");
    t.$("draw-name").value = "Control A";
    await t.click("add-center");
    await t.click("save-drawing");
    assert.match(t.$("message").textContent, /saved/);
    assert.equal(t.map.sources.landmarks.data.features.length, 1);
    t.$("landmark-list").querySelector("button").click();
    t.$("edit-name").value = "Control B";
    await t.click("save-edit");
    assert.equal(
      t.map.sources.landmarks.data.features[0].properties.name,
      "Control B",
    );
    await t.click("delete-selected");
    assert.equal(t.map.sources.landmarks.data.features.length, 0);
    await t.click("restore-delete");
    assert.equal(t.map.sources.landmarks.data.features.length, 1);
  } finally {
    t.close();
  }
});
test("route and area drawing preview, undo, edit and geodesic measurements", async () => {
  const t = await setup();
  try {
    await t.change("draw-mode", "Polygon");
    await t.click("add-center");
    t.map.center = [78.0332, 30.3165];
    await t.click("add-center");
    t.map.center = [78.0332, 30.3175];
    await t.click("add-center");
    assert.match(t.$("measure").textContent, /Area:/);
    await t.click("undo");
    await t.click("save-drawing");
    assert.match(t.$("message").textContent, /enough vertices/);
    t.map.center = [78.0322, 30.3175];
    await t.click("add-center");
    await t.click("save-drawing");
    assert.equal(
      t.map.sources.landmarks.data.features[0].geometry.type,
      "Polygon",
    );
    t.$("landmark-list").querySelector("button").click();
    await t.click("edit-vertices");
    assert.equal(t.$("draw-mode").value, "Polygon");
    await t.click("save-drawing");
    assert.equal(t.map.sources.landmarks.data.features.length, 1);
  } finally {
    t.close();
  }
});
test("device GPS recording saves heights and segments and stops its watcher", async () => {
  const t = await setup();
  try {
    await t.click("record-start");
    const base = Date.now() - 5000;
    const emit = (lon, time, alt) =>
      t.position({
        timestamp: time,
        coords: {
          longitude: lon,
          latitude: 30,
          accuracy: 3,
          altitude: alt,
          altitudeAccuracy: 5,
          speed: 1,
          heading: 90,
        },
      });
    emit(78, base, 0);
    emit(78.0001, base + 2000, -10);
    assert.match(
      t.$("gps-readout").textContent,
      /Height \(WGS84 ellipsoid\): -10.00/,
    );
    await t.click("record-pause");
    await t.click("record-pause");
    emit(78.0002, base + 4000, 5);
    await t.click("record-stop");
    assert.equal(t.map.sources.landmarks.data.features.length, 2);
    const line = t.map.sources.landmarks.data.features.find(
      (f) => f.geometry.type === "LineString",
    );
    assert.equal(line.geometry.coordinates[0][2], 0);
    assert.equal(line.geometry.coordinates[1][2], -10);
    assert.equal(line.properties.samples[0].accuracy, 3);
    await t.click("gps-stop");
    assert.equal(t.cleared(), 1);
    assert.match(t.$("gps-readout").textContent, /unavailable or stale/);
  } finally {
    t.close();
  }
});
test("unsupported DSM and unavailable offline / elevation sources report errors", async () => {
  const t = await setup();
  try {
    await t.change("primary-format", "DSM 7C");
    assert.match(t.$("coord-primary").textContent, /parameters required/);
    await t.change("basemap", "mbtiles");
    await t.click("apply-basemap");
    assert.match(t.$("message").textContent, /Import an MBTiles/);
    await t.change("terrain-source", "hgt");
    await t.click("apply-terrain");
    assert.match(t.$("message").textContent, /valid HGT/);
  } finally {
    t.close();
  }
});
test("offline download controls enforce provider permission and tile caps", async () => {
  const t = await setup();
  try {
    await t.click("download-tiles");
    assert.match(t.$("message").textContent, /permits offline/);
    t.$("offline-permitted").checked = true;
    t.$("tile-url").value = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
    await t.click("download-tiles");
    assert.match(t.$("message").textContent, /not permitted/);
    await t.click("select-area");
    await t.click("estimate-tiles");
    assert.match(t.$("download-estimate").textContent, /tiles/);
  } finally {
    t.close();
  }
});
test("GPS gap in visibility pauses recording and prevents false continuity", async () => {
  const t = await setup();
  try {
    await t.click("record-start");
    Object.defineProperty(t.w.document, "hidden", {
      value: true,
      configurable: true,
    });
    t.w.document.dispatchEvent(new t.w.Event("visibilitychange"));
    assert.match(t.$("record-state").textContent, /Paused/);
    assert.match(t.$("record-state").textContent, /Page hidden/);
  } finally {
    t.close();
  }
});

test("landmarks and paused recorder recover from device storage", async () => {
  const storage = new IDBFactory();
  const first = await setup(storage);
  await first.change("draw-mode", "Point");
  first.$("draw-name").value = "Persistent control";
  await first.click("add-center");
  await first.click("save-drawing");
  await first.click("record-start");
  first.position({
    timestamp: Date.now(),
    coords: { latitude: 30, longitude: 78, accuracy: 3, altitude: 0 },
  });
  await delay(300);
  first.close();
  await delay(30);
  const second = await setup(storage);
  try {
    assert.equal(
      second.map.sources.landmarks.data.features[0].properties.name,
      "Persistent control",
    );
    assert.match(second.$("record-state").textContent, /Paused/);
    assert.match(second.$("record-state").textContent, /Recovered recording/);
    assert.equal(second.map.sources.recording.data.features.length, 0);
  } finally {
    second.close();
  }
});

test("GIS toolbar, default grid readouts, cursor coordinates and corner controls", async () => {
  const t = await setup();
  try {
    assert.match(t.$("coord-dsm").textContent, /DSM 6D/);
    assert.match(t.$("coord-wgs").textContent, /WGS84.*MGRS/);
    assert.equal(t.$("coordinates").hidden, false);
    t.map.events.mousemove.forEach((fn) =>
      fn({ lngLat: { lng: 80, lat: 27 } }),
    );
    assert.match(t.$("coordinate-context").textContent, /Cursor/);
    assert.match(t.$("coord-primary").textContent, /27.0000000/);
    assert.match(t.$("coord-dsm").textContent, /DSM 6E/);
    t.map.events.mouseout.forEach((fn) => fn());
    assert.match(t.$("coordinate-context").textContent, /Map center/);
    await t.click("tool-line");
    assert.equal(t.$("draw-mode").value, "LineString");
    await t.click("corner-layers");
    assert.equal(t.$("panel-layers").hidden, false);
    await t.change("basemap", "satellite");
    assert.match(t.map.sources.basemap.tiles[0], /World_Imagery/);
    await t.change("basemap", "topographic");
    assert.match(t.map.sources.basemap.tiles[0], /World_Topo_Map/);
    t.$("orientation").value = "gps";
    t.$("perspective").checked = true;
    await t.click("corner-north");
    assert.equal(t.$("orientation").value, "north");
    assert.equal(t.$("perspective").checked, false);
    assert.equal(t.map.bearing, 0);
    assert.equal(t.map.pitch, 0);
  } finally {
    t.close();
  }
});

test("own position rejects inaccurate readings and jumps, preserving height and uncertainty", async () => {
  const t = await setup();
  try {
    await t.click("corner-own");
    const base = Date.now() - 5000;
    const emit = (longitude, accuracy, altitude, time) =>
      t.position({
        timestamp: time,
        coords: {
          longitude,
          latitude: 30,
          accuracy,
          altitude,
          altitudeAccuracy: 7,
          speed: 0,
          heading: null,
        },
      });
    emit(78, 100, 900, base);
    await t.click("mark-own");
    assert.equal(t.map.sources.landmarks.data.features.length, 0);
    emit(78, 3, 0, base + 1000);
    assert.match(t.$("own-summary").textContent, /Height: 0.0 m/);
    emit(85, 3, 999, base + 2000);
    assert.match(t.$("message").textContent, /rejected/);
    assert.match(t.$("own-summary").textContent, /Height: 0.0 m/);
    emit(78.00001, 2, -5, base + 3000);
    await t.click("mark-own");
    const saved = t.map.sources.landmarks.data.features[0];
    assert.equal(saved.geometry.coordinates[2], -5);
    assert.equal(saved.properties.samples[0].accuracy, 2);
    assert.equal(saved.properties.samples[0].verticalAccuracy, 7);
    await t.click("gps-stop");
    assert.match(t.$("own-summary").textContent, /stale/);
  } finally {
    t.close();
  }
});

test("map inverse auto lists competing DSM zones without moving to an arbitrary one", async () => {
  const t = await setup();
  try {
    const center = [...t.map.center];
    await t.change("entry-format", "DSM Auto");
    t.$("entry-coord").value = "500000,500000";
    await t.click("go-coordinate");
    assert.match(t.$("entry-candidates").textContent, /5C:/);
    assert.match(t.$("entry-candidates").textContent, /8H:/);
    assert.match(t.$("message").textContent, /ambiguous/);
    assert.deepEqual([...t.map.center], center);
  } finally {
    t.close();
  }
});

test("cursor elevation loads on demand, caches raw height and does not redraw geometry on idle", async () => {
  const t = await setup();
  try {
    let requests = 0;
    t.w.fetch = async () => {
      requests++;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
    };
    t.w.createImageBitmap = async () => ({
      width: 256,
      height: 256,
      close() {},
    });
    const rgba = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set([128, 120, 0, 255], i);
    t.w.HTMLCanvasElement.prototype.getContext = () => ({
      drawImage() {},
      getImageData() {
        return { width: 256, height: 256, data: rgba };
      },
    });
    t.map.events.mousemove.forEach((fn) =>
      fn({ lngLat: { lng: 78, lat: 30 } }),
    );
    await waitFor(() => t.$("center-height").textContent.includes("120.0 m"));
    assert.equal(requests, 1);
    t.map.events.mousemove.forEach((fn) =>
      fn({ lngLat: { lng: 78.00001, lat: 30 } }),
    );
    await delay(300);
    assert.equal(requests, 1);
    let updates = 0;
    t.map.sources.preview.setData = () => updates++;
    t.map.events.idle.forEach((fn) => fn());
    assert.equal(updates, 0);
    t.$("cursor-elevation").checked = false;
    t.$("cursor-elevation").dispatchEvent(new t.w.Event("change"));
    assert.match(t.$("center-height").textContent, /unavailable/);
  } finally {
    t.close();
  }
});
