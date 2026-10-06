const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  { JSDOM } = require("jsdom"),
  C = require("../map_assets/core");
const tick = () => new Promise((r) => setTimeout(r, 10));
async function setup() {
  const dom = new JSDOM(fs.readFileSync("map_assets/simple.html", "utf8"), {
      url: "https://fss.test",
      runScripts: "outside-only",
    }),
    w = dom.window,
    $ = (id) => w.document.getElementById(id),
    state = { maps: [], markers: [] };
  class Map {
    constructor(o) {
      this.center = o.center || [80, 30];
      this.zoom = o.zoom || 7;
      this.sources = {};
      this.events = {};
      state.maps.push(this);
    }
    addControl() {}
    on(n, fn) {
      this.events[n] = fn;
      if (n === "load") setTimeout(fn, 0);
      return this;
    }
    getCenter() {
      const p = this.center;
      return { lng: p[0], lat: p[1], toArray: () => p };
    }
    getZoom() {
      return this.zoom;
    }
    remove() {
      this.removed = true;
    }
    getSource(id) {
      return this.sources[id];
    }
    addSource(id, s) {
      this.sources[id] = {
        ...s,
        setData(d) {
          this.data = d;
        },
      };
    }
    addLayer() {}
    flyTo(o) {
      this.center = o.center;
    }
    easeTo() {}
    setTerrain() {}
    setView(p, z) {
      this.center = [p[1], p[0]];
      this.zoom = z;
      return this;
    }
  }
  class Marker {
    constructor(o) {
      this.element = o.element;
      state.markers.push(this);
    }
    setLngLat(p) {
      this.p = p;
      return this;
    }
    addTo() {
      return this;
    }
    remove() {
      this.removed = true;
    }
  }
  const layer = () => ({
    addTo() {
      return this;
    },
    on() {
      return this;
    },
    remove() {},
  });
  w.maplibregl = {
    Map,
    Marker,
    NavigationControl: class {},
    ScaleControl: class {},
  };
  w.L = {
    map: () => new Map({}),
    tileLayer: layer,
    layerGroup: layer,
    polyline: layer,
    control: { scale: layer },
    divIcon: (o) => o,
    marker: (p, o) => new Marker({ element: o.icon.html }),
  };
  w.FSS = C;
  w.SIMPLE_CONFIG = {
    grids: {},
    routingUrl: "https://router.project-osrm.org/route/v1/driving",
    vectorStyle: "https://tiles.openfreemap.org/styles/liberty",
  };
  w.AbortController = AbortController;
  w.URL.createObjectURL = () => "";
  w.URL.revokeObjectURL = () => {};
  w.eval(fs.readFileSync("map_assets/simple.js", "utf8"));
  await tick();
  return {
    w,
    $,
    state,
    click: async (id) => {
      $(id).click();
      await tick();
    },
    change: async (id, v) => {
      $(id).value = v;
      $(id).dispatchEvent(new w.Event("change"));
      await tick();
    },
    tap: async (p) => {
      const map = state.maps.at(-1);
      map.events.click({
        lngLat: { lng: p[0], lat: p[1] },
        latlng: { lng: p[0], lat: p[1] },
      });
      await tick();
    },
    close: () => dom.window.close(),
  };
}
test("compact page removes legacy panels and measures true forward/reverse bearings", async () => {
  const t = await setup();
  try {
    for (const id of [
      "map-toolbar",
      "panel-select",
      "tool-draw",
      "tool-print",
      "tools",
    ])
      assert.equal(t.$(id), null);
    await t.click("measure");
    await t.tap([0, 0]);
    await t.tap([1, 0]);
    assert.match(t.$("measurement").textContent, /111319.49 m/);
    assert.match(t.$("measurement").textContent, /90.00° true/);
    assert.match(t.$("measurement").textContent, /270.00° true/);
    t.$("to").value = "100,0";
    await t.click("calculate");
    assert.match(t.$("status").textContent, /Coordinates/);
    t.$("to").value = "0,0";
    await t.click("calculate");
    assert.match(t.$("measurement").textContent, /undefined for coincident/);
  } finally {
    t.close();
  }
});
test("markers use safe labels, can hide them and survive Leaflet/MapLibre switching", async () => {
  const t = await setup();
  try {
    t.$("name").value = "<img src=x onerror=alert(1)>";
    await t.click("mark");
    await t.tap([80, 30]);
    assert.equal(t.$("count").textContent, "1");
    assert.equal(t.state.markers.at(-1).element.querySelector("img"), null);
    t.$("labels").checked = false;
    t.$("labels").dispatchEvent(new t.w.Event("change"));
    assert.equal(
      t.state.markers.at(-1).element.querySelector("span").hidden,
      true,
    );
    await t.change("provider", "leaflet");
    assert.equal(t.$("count").textContent, "1");
    assert.equal(t.$("tilt").disabled, true);
    await t.change("provider", "vector");
    assert.equal(t.$("count").textContent, "1");
    assert.equal(t.$("tilt").disabled, false);
    const data = JSON.parse(t.w.localStorage.getItem("fss-simple-marks-v1"));
    assert.equal(data[0].p[0], 80);
    await t.change("provider", "mapbox-streets");
    assert.match(t.$("status").textContent, /MAPBOX_PUBLIC_TOKEN/);
    assert.equal(t.$("provider").value, "vector");
  } finally {
    t.close();
  }
});
test("driving route is distinct from direct measurement and stale replies are ignored", async () => {
  const t = await setup();
  try {
    t.$("from").value = "30,80";
    t.$("to").value = "30.1,80.1";
    let resolve;
    t.w.fetch = () => new Promise((r) => (resolve = r));
    await t.click("directions");
    await t.click("clear");
    resolve({
      ok: true,
      text: async () =>
        JSON.stringify({
          code: "Ok",
          routes: [
            {
              geometry: {
                type: "LineString",
                coordinates: [
                  [80, 30],
                  [80.1, 30.1],
                ],
              },
              distance: 20000,
              duration: 900,
              legs: [],
            },
          ],
        }),
    });
    await tick();
    assert.equal(t.$("route-details").hidden, true);
    assert.equal(t.$("from").value, "");
  } finally {
    t.close();
  }
  const n = await setup();
  try {
    n.$("from").value = "30,80";
    n.$("to").value = "30.1,80.1";
    let request;
    n.w.fetch = async (u) => {
      request = String(u);
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            code: "Ok",
            routes: [
              {
                geometry: {
                  type: "LineString",
                  coordinates: [
                    [80, 30],
                    [80.1, 30.1],
                  ],
                },
                distance: 20000,
                duration: 900,
                legs: [
                  {
                    steps: [
                      {
                        maneuver: { type: "turn", modifier: "left" },
                        name: "Road",
                      },
                    ],
                  },
                ],
              },
            ],
          }),
      };
    };
    await n.click("directions");
    assert.match(request, /80,30;80.1,30.1/);
    assert.match(n.$("route-summary").textContent, /20.00 km/);
    assert.match(n.$("measurement").textContent, /Direct distance/);
    assert.equal(n.$("steps").children.length, 1);
    assert.equal(n.$("route-details").hidden, false);
  } finally {
    n.close();
  }
});

test("My location creates one blue marker, updates it and survives provider switching", async () => {
  const t = await setup();
  try {
    let p = [80.2, 29.6];
    Object.defineProperty(t.w.navigator, 'geolocation', {value: {
      getCurrentPosition(ok) { ok({coords:{longitude:p[0],latitude:p[1],accuracy:4,altitude:1200}, timestamp:Date.now()}); }
    }});
    const own = () => t.state.markers.filter(m => !m.removed && m.element.classList.contains('own-position'));
    await t.click('own');
    assert.equal(own().length, 1);
    assert.deepEqual(Array.from(own()[0].p), p);
    assert.equal(own()[0].element.textContent, '●My location');
    assert.deepEqual(Array.from(t.state.maps.at(-1).center), p);
    p = [80.3,29.7];
    await t.click('own');
    assert.equal(own().length, 1);
    assert.deepEqual(Array.from(own()[0].p), p);
    await t.change('provider','leaflet');
    assert.equal(own().length, 1);
    t.$('labels').checked = false;
    t.$('labels').dispatchEvent(new t.w.Event('change'));
    assert.equal(own()[0].element.querySelector('span').hidden, true);
    assert.equal(t.$('count').textContent, '0');
  } finally { t.close(); }
});

test("My location permission errors and invalid fixes do not create a marker", async () => {
  const t = await setup();
  try {
    let denied = true;
    Object.defineProperty(t.w.navigator, 'geolocation', {value: {
      getCurrentPosition(ok, fail) {
        if (denied) fail({message:'Permission denied'});
        else ok({coords:{longitude:80,latitude:100,accuracy:4},timestamp:Date.now()});
      }
    }});
    await t.click('own');
    assert.match(t.$('status').textContent, /Permission denied/);
    denied = false;
    await t.click('own');
    assert.equal(t.state.markers.filter(m=>!m.removed).length, 0);
  } finally { t.close(); }
});
