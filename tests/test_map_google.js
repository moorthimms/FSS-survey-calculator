const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  { JSDOM } = require("jsdom");
const tick = () => new Promise((r) => setTimeout(r, 10));
async function setup(config = { key: "test" }) {
  const dom = new JSDOM(fs.readFileSync("map_assets/google.html", "utf8"), {
      runScripts: "outside-only",
      url: "https://fss.test",
    }),
    w = dom.window,
    $ = (id) => w.document.getElementById(id);
  const state = {
    maps: [],
    requests: [],
    markers: [],
    polys: [],
    geocodes: [],
  };
  class Map {
    constructor(el, o) {
      Object.assign(this, o);
      state.maps.push(this);
    }
    getZoom() {
      return this.zoom;
    }
    setZoom(v) {
      this.zoom = v;
    }
    getCenter() {
      return this.center;
    }
    setCenter(p) {
      this.center = p;
    }
    setMapTypeId(v) {
      this.type = v;
    }
    setHeading(v) {
      this.heading = v;
    }
    addListener() {}
    fitBounds(v) {
      this.bounds = v;
    }
  }
  class Marker {
    constructor(o) {
      Object.assign(this, o);
      state.markers.push(this);
    }
  }
  class Layer {
    setMap(v) {
      this.map = v;
    }
  }
  class Bounds {
    constructor() {
      this.points = [];
    }
    extend(p) {
      this.points.push(p);
    }
  }
  const Route = {
    computeRoutes: async (request) => {
      state.requests.push(request);
      if (state.routePromise) return state.routePromise;
      return {
        routes: [
          {
            path: [
              { lat: 29, lng: 80 },
              { lat: 30, lng: 81 },
            ],
            distanceMeters: 1200,
            durationMillis: 120000,
            createPolylines() {
              const p = {
                setMap(m) {
                  this.map = m;
                },
              };
              state.polys.push(p);
              return [p];
            },
            async createWaypointAdvancedMarkers() {
              return [new Marker({}), new Marker({})];
            },
          },
        ],
      };
    },
  };
  class Geocoder {
    async geocode(q) {
      state.geocodes.push(q);
      return {
        results: [
          {
            formatted_address: "<b>Place</b>",
            geometry: { location: { lat: () => 30, lng: () => 80 } },
          },
        ],
      };
    }
  }
  w.customElements.define(
    "mock-map3d",
    class extends w.HTMLElement {
      constructor(o) {
        super();
        Object.assign(this, o);
      }
    },
  );
  w.google = {
    maps: {
      Map,
      TrafficLayer: Layer,
      TransitLayer: Layer,
      LatLngBounds: Bounds,
      importLibrary: async () => ({
        AdvancedMarkerElement: Marker,
        Route,
        Geocoder,
        Map3DElement: w.customElements.get("mock-map3d"),
      }),
    },
  };
  w.GOOGLE_CONFIG = config;
  w.eval(fs.readFileSync("map_assets/google.js", "utf8"));
  if (config.key) await w.initGoogleMap();
  const click = async (id) => {
      $(id).click();
      await tick();
    },
    change = async (id, v) => {
      $(id).value = v;
      $(id).dispatchEvent(new w.Event("change"));
      await tick();
    };
  return { w, $, state, click, change, close: () => dom.window.close() };
}
test("Google maps switch all four types and 3D camera; navigation requires configured ID", async () => {
  const t = await setup();
  try {
    for (const type of ["roadmap", "satellite", "hybrid", "terrain"]) {
      await t.change("map-type", type);
      assert.equal(t.state.maps[0].type, type);
    }
    assert.equal(
      t.$("map-type").querySelector("[value=navigation]").disabled,
      true,
    );
    await t.change("map-type", "3d-hybrid");
    assert.equal(t.$("map").hidden, true);
    t.$("heading").value = "90";
    await t.click("camera");
    assert.equal(t.$("earth").firstChild.heading, 90);
    await t.change("map-type", "roadmap");
    assert.equal(t.$("earth").hidden, true);
  } finally {
    t.close();
  }
});
test("coordinate validation and safe place choices; no-key external links", async () => {
  const t = await setup();
  try {
    t.$("query").value = "91,80";
    await t.click("search");
    assert.match(t.$("status").textContent, /Latitude/);
    assert.equal(t.state.geocodes.length, 0);
    t.$("query").value = "29.58,80.21";
    await t.click("search");
    assert.equal(t.state.maps[0].center.lat, 29.58);
    t.$("query").value = "Pithoragarh";
    await t.click("search");
    assert.equal(t.$("results").querySelectorAll("b").length, 0);
    t.$("results").firstChild.click();
    await tick();
    assert.equal(t.state.maps[0].center.lat, 30);
  } finally {
    t.close();
  }
  const n = await setup({});
  try {
    n.$("query").value = "0,0";
    await n.click("search");
    assert.match(n.$("status").textContent, /Valid coordinate/);
    assert.match(n.$("external-search").href, /query=0%2C0/);
    assert.equal(n.w.document.querySelectorAll("script[src]").length, 0);
  } finally {
    n.close();
  }
});
test("From/To routes use requested mode; clear removes overlays and rejects stale responses", async () => {
  const t = await setup();
  try {
    t.$("origin").value = "29,80";
    t.$("destination").value = "Pithoragarh";
    t.$("travel").value = "WALKING";
    await t.click("route");
    assert.equal(t.state.requests[0].travelMode, "WALKING");
    assert.equal(t.state.requests[0].origin.lat, 29);
    assert.match(t.$("route-summary").textContent, /1.20 km/);
    assert.equal(t.state.polys[0].map, t.state.maps[0]);
    await t.click("clear-route");
    assert.equal(t.state.polys[0].map, null);
    let resolve;
    t.state.routePromise = new Promise((r) => (resolve = r));
    await t.click("route");
    await t.click("clear-route");
    resolve({ routes: [] });
    await tick();
    assert.equal(t.$("route-summary").textContent, "");
    await t.click("swap");
    assert.equal(t.$("origin").value, "Pithoragarh");
    assert.match(t.$("external-route").href, /travelmode=walking/);
  } finally {
    t.close();
  }
});
test("navigation style creates configured map; key is sent only to Google SDK loader", async () => {
  const t = await setup({ key: "test&safe", navigationMapId: "navigation-id" });
  try {
    await t.change("map-type", "navigation");
    assert.equal(t.state.maps.at(-1).mapId, "navigation-id");
    const url = new URL(t.w.document.querySelector("script[src]").src);
    assert.equal(url.hostname, "maps.googleapis.com");
    assert.equal(url.searchParams.get("key"), "test&safe");
    t.w.gm_authFailure();
    assert.match(t.$("status").textContent, /authentication failed/);
  } finally {
    t.close();
  }
});
