(function () {
  "use strict";
  const C = window.FSS,
    cfg = window.SIMPLE_CONFIG || {},
    $ = (id) => document.getElementById(id),
    fc = (features) => ({ type: "FeatureCollection", features }),
    symbols = { pin: "●", flag: "⚑", survey: "⊕", camp: "▲" };
  let map,
    kind = "gl",
    lib = window.maplibregl,
    mode = "pan",
    a = null,
    b = null,
    route = null,
    marks = [],
    rendered = [],
    overlay,
    provider = "soi",
    switchTicket = 0,
    routeTicket = 0,
    routeController,
    ready = false,
    loading = false,
    lastRoute = 0,
    terrain = false;
  const status = (t) => ($("status").textContent = t),
    fmt = (p) => `${p[1].toFixed(6)}, ${p[0].toFixed(6)}`;
  function on(id, event, fn) {
    $(id).addEventListener(event, async () => {
      try {
        await fn();
      } catch (e) {
        status(e.message || "Operation failed.");
      }
    });
  }
  function parse(s) {
    const parts = s
      .trim()
      .split(/\s*,\s*|\s+/)
      .filter(Boolean);
    if (
      parts.length !== 2 ||
      parts.some((x) => !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(x))
    )
      throw Error("Enter decimal latitude, longitude for A and B.");
    return C.coord([Number(parts[1]), Number(parts[0])]);
  }
  function refs(p) {
    try {
      $("reference").textContent =
        `WGS84 ${fmt(p)}\n${C.autoReferences(p, "DSM", cfg.grids)}\n${C.autoReferences(p, "Kalianpur", cfg.grids)}`;
    } catch (e) {
      $("reference").textContent = fmt(p);
    }
  }
  function persist() {
    try {
      localStorage.setItem("fss-simple-marks-v1", JSON.stringify(marks));
    } catch (e) {
      status(
        "Browser storage unavailable. Download your locations to keep a copy.",
      );
    }
  }
  try {
    const saved = JSON.parse(
      localStorage.getItem("fss-simple-marks-v1") || "[]",
    );
    if (Array.isArray(saved))
      marks = saved
        .slice(0, 500)
        .map((m) => ({
          id: String(m.id),
          p: C.coord(m.p),
          name: String(m.name || "Location").slice(0, 80),
          symbol: Object.hasOwn(symbols, m.symbol) ? m.symbol : "pin",
        }));
  } catch (e) {
    status("Saved locations could not be restored.");
  }
  function setMode(v) {
    mode = v;
    for (const id of ["pan", "mark", "measure"])
      $(id).setAttribute("aria-pressed", String(id === v));
    status(
      v === "mark"
        ? "Tap a location to save a marker."
        : v === "measure"
          ? "Tap point A, then point B."
          : "Drag to move the map.",
    );
  }
  function clearRoute() {
    routeTicket++;
    routeController?.abort();
    routeController = null;
    route = null;
    $("route-details").hidden = true;
    $("steps").replaceChildren();
    $("route-summary").textContent = "";
  }
  function links() {
    const u = new URL("https://www.google.com/maps/dir/");
    u.search = new URLSearchParams({
      api: "1",
      origin: $("from").value.trim(),
      destination: $("to").value.trim(),
      travelmode: "driving",
    });
    $("navigate").href = u;
  }
  function measure() {
    if (!a || !b) {
      $("measurement").textContent = a
        ? "Point A selected. Tap point B."
        : "Choose Measure A → B, then tap two places.";
      return;
    }
    const f = C.inverse(a, b),
      r = C.inverse(b, a);
    $("measurement").textContent =
      `Direct distance: ${f.distance.toFixed(2)} m (${(f.distance / 1000).toFixed(3)} km) · ${f.distance < 0.001 ? "Bearing undefined for coincident points" : `A → B: ${f.bearing.toFixed(2)}° true · B → A: ${r.bearing.toFixed(2)}° true`}`;
  }
  function syncEndpoints() {
    $("from").value = a ? fmt(a) : "";
    $("to").value = b ? fmt(b) : "";
    links();
    measure();
    draw();
  }
  function setInputs() {
    const x = parse($("from").value),
      y = parse($("to").value);
    clearRoute();
    a = x;
    b = y;
    syncEndpoints();
  }
  function selectPoint(p) {
    if (loading) return;
    p = C.coord([C.wrap(p[0]), p[1]]);
    refs(p);
    if (mode === "mark") {
      if (marks.length >= 500) throw Error("Limit: 500 saved locations.");
      marks.push({
        id: C.cryptoId(),
        p,
        name: $("name").value.trim() || `Location ${marks.length + 1}`,
        symbol: $("symbol").value,
      });
      persist();
      draw();
      status("Location saved.");
    } else if (mode === "measure") {
      clearRoute();
      if (!a || b) {
        a = p;
        b = null;
      } else b = p;
      syncEndpoints();
      if (b) setMode("pan");
    }
  }
  function elements(m) {
    const el = document.createElement("div");
    el.className = "marker";
    const icon = document.createElement("b");
    icon.textContent = symbols[m.symbol] || m.symbol || "●";
    const label = document.createElement("span");
    label.textContent = m.name;
    label.hidden = !$("labels").checked;
    el.append(icon, label);
    el.title = m.name;
    return el;
  }
  function allMarkers() {
    return [
      ...marks,
      ...(a ? [{ p: a, name: "A / From", symbol: "A" }] : []),
      ...(b ? [{ p: b, name: "B / To", symbol: "B" }] : []),
    ];
  }
  function geodesic() {
    if (!a || !b) return [];
    const inv = C.inverse(a, b);
    if (inv.distance < 0.001) return [a, b];
    const n = Math.max(2, Math.min(256, Math.ceil(inv.distance / 10000)));
    return Array.from({ length: n + 1 }, (_, i) =>
      C.direct(a, inv.bearing, (inv.distance * i) / n),
    );
  }
  function unroll(points) {
    let previous;
    return points.map((p) => {
      let lon = p[0];
      if (previous !== undefined) lon = previous + C.wrap(lon - previous);
      previous = lon;
      return [lon, p[1]];
    });
  }
  function draw() {
    $("count").textContent = marks.length;
    $("marks").replaceChildren();
    for (const m of marks) {
      const row = document.createElement("div");
      row.className = "mark-row";
      const go = document.createElement("button");
      go.textContent = `${symbols[m.symbol]} ${m.name}`;
      go.onclick = () => fly(m.p);
      const del = document.createElement("button");
      del.textContent = "×";
      del.setAttribute("aria-label", "Delete " + m.name);
      del.onclick = () => {
        marks = marks.filter((x) => x.id !== m.id);
        persist();
        draw();
      };
      row.append(go, del);
      $("marks").append(row);
    }
    if (!map || !ready) return;
    rendered.forEach((x) => x.remove());
    rendered = [];
    if (kind === "leaflet") {
      overlay?.remove();
      overlay = L.layerGroup().addTo(map);
    }
    for (const m of allMarkers()) {
      const el = elements(m);
      if (kind === "leaflet") {
        const mark = L.marker([m.p[1], m.p[0]], {
          icon: L.divIcon({
            html: el,
            className: "",
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          }),
        }).addTo(map);
        rendered.push(mark);
      } else
        rendered.push(
          new lib.Marker({ element: el, anchor: "left", offset: [-15, 0] })
            .setLngLat(m.p)
            .addTo(map),
        );
    }
    const paths = [];
    if (a && b)
      paths.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: unroll(geodesic()) },
        properties: { color: "#126e80" },
      });
    if (route)
      paths.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: unroll(route.geometry.coordinates),
        },
        properties: { color: "#d15b19" },
      });
    if (kind === "leaflet") {
      for (const f of paths)
        L.polyline(
          f.geometry.coordinates.map((p) => [p[1], p[0]]),
          { color: f.properties.color, weight: 4 },
        ).addTo(overlay);
    } else {
      const source = map.getSource("fss-lines");
      if (source) source.setData(fc(paths));
      else {
        map.addSource("fss-lines", { type: "geojson", data: fc(paths) });
        map.addLayer({
          id: "fss-lines",
          type: "line",
          source: "fss-lines",
          paint: { "line-color": ["get", "color"], "line-width": 4 },
        });
      }
    }
  }
  function fly(p) {
    if (!map) return;
    if (kind === "leaflet") map.setView([p[1], p[0]], 15);
    else map.flyTo({ center: p, zoom: 15 });
    refs(p);
  }
  function raster(url, attribution) {
    return {
      version: 8,
      sources: {
        basemap: {
          type: "raster",
          tiles: [url],
          tileSize: 256,
          maxzoom: 14,
          attribution,
        },
      },
      layers: [{ id: "basemap", type: "raster", source: "basemap" }],
    };
  }
  let mapboxLoader;
  function mapboxSDK() {
    if (window.mapboxgl) return Promise.resolve(window.mapboxgl);
    if (mapboxLoader) return mapboxLoader;
    mapboxLoader = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "https://api.mapbox.com/mapbox-gl-js/v3.30.0/mapbox-gl.css";
      document.head.append(css);
      const script = document.createElement("script");
      script.src = "https://api.mapbox.com/mapbox-gl-js/v3.30.0/mapbox-gl.js";
      const timer = setTimeout(() => {
        mapboxLoader = null;
        reject(Error("Mapbox SDK timed out. Choose another map."));
      }, 20000);
      script.onload = () => {
        clearTimeout(timer);
        resolve(window.mapboxgl);
      };
      script.onerror = () => {
        clearTimeout(timer);
        mapboxLoader = null;
        reject(Error("Mapbox SDK could not load."));
      };
      document.head.append(script);
    });
    return mapboxLoader;
  }
  async function changeProvider() {
    const next = $("provider").value,
      ticket = ++switchTicket;
    loading = true;
    status("Loading selected map…");
    try {
      let sdk = window.maplibregl;
      if (next.startsWith("mapbox-")) {
        if (!cfg.mapboxToken?.startsWith("pk."))
          throw Error(
            "Mapbox needs MAPBOX_PUBLIC_TOKEN on the host (a public pk. token).",
          );
        sdk = await mapboxSDK();
      }
      if (ticket !== switchTicket) return;
      const center = map
          ? kind === "leaflet"
            ? [map.getCenter().lng, map.getCenter().lat]
            : map.getCenter().toArray()
          : [80.218, 29.583],
        zoom = map ? map.getZoom() : 7;
      rendered.forEach((x) => x.remove());
      rendered = [];
      overlay = null;
      map?.remove();
      $("map").replaceChildren();
      ready = false;
      terrain = false;
      $("tilt").setAttribute("aria-pressed", "false");
      provider = next;
      if (next === "leaflet") {
        kind = "leaflet";
        map = L.map("map", { worldCopyJump: true }).setView(
          [center[1], center[0]],
          zoom,
        );
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution:
            '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        })
          .addTo(map)
          .on("tileerror", () =>
            status("Map tile unavailable. Try another provider."),
          );
        L.control.scale().addTo(map);
        ready = true;
        map.on("click", (e) => {
          try {
            selectPoint([e.latlng.lng, e.latlng.lat]);
          } catch (x) {
            status(x.message);
          }
        });
        map.on("mousemove", (e) => refs([C.wrap(e.latlng.lng), e.latlng.lat]));
        draw();
      } else {
        kind = "gl";
        lib = sdk;
        const style =
          next === "soi"
            ? raster(
                "https://indianopenmaps.fly.dev/soi/osm/{z}/{x}/{y}.webp",
                'Survey of India · <a href="https://github.com/ramSeraph/india_topo_maps">India topo maps</a>',
              )
            : next === "vector"
              ? cfg.vectorStyle
              : `mapbox://styles/mapbox/${{ "mapbox-streets": "streets-v12", "mapbox-outdoors": "outdoors-v12", "mapbox-satellite": "satellite-v9", "mapbox-hybrid": "satellite-streets-v12" }[next]}`;
        map = new sdk.Map({
          container: "map",
          style,
          center,
          zoom,
          accessToken: next.startsWith("mapbox-") ? cfg.mapboxToken : undefined,
        });
        map.addControl(new sdk.NavigationControl());
        map.addControl(new sdk.ScaleControl());
        map.on("load", () => {
          if (ticket !== switchTicket) return;
          ready = true;
          draw();
        });
        map.on("click", (e) => {
          try {
            selectPoint([e.lngLat.lng, e.lngLat.lat]);
          } catch (x) {
            status(x.message);
          }
        });
        map.on("mousemove", (e) => refs([C.wrap(e.lngLat.lng), e.lngLat.lat]));
        map.on("error", () =>
          status(
            "Map data could not load. Check provider access or choose another map.",
          ),
        );
      }
      $("tilt").disabled = next === "leaflet";
      $("provider-note").textContent =
        next === "leaflet"
          ? "OpenStreetMap public tiles: attribution and usage policy apply; no bulk/offline download."
          : next.startsWith("mapbox-")
            ? "Mapbox: public token and current account pricing apply. Maps, terrain and directions can be billed separately."
            : next === "vector"
              ? "MapLibre vector rendering · OpenFreeMap or host-configured style. Tile-provider availability applies."
              : "India topo · Survey of India / ramSeraph community map service. Coverage and availability vary.";
      status("Map selected. Choose Mark location or Measure A → B.");
    } catch (e) {
      if (ticket === switchTicket) $("provider").value = provider;
      throw e;
    } finally {
      if (ticket === switchTicket) loading = false;
    }
  }
  on("provider", "change", changeProvider);
  for (const id of ["pan", "mark", "measure"])
    on(id, "click", () => {
      if (id === "measure") {
        clearRoute();
        a = b = null;
        syncEndpoints();
      }
      setMode(id);
    });
  on("labels", "change", draw);
  on("calculate", "click", setInputs);
  on("swap", "click", () => {
    [$("from").value, $("to").value] = [$("to").value, $("from").value];
    setInputs();
  });
  on("clear", "click", () => {
    a = b = null;
    clearRoute();
    syncEndpoints();
    setMode("pan");
  });
  for (const id of ["from", "to"])
    on(id, "input", () => {
      a = b = null;
      clearRoute();
      draw();
      measure();
      links();
    });
  on("directions", "click", async () => {
    if (Date.now() - lastRoute < 5000)
      throw Error("Wait a few seconds before requesting another route.");
    setInputs();
    lastRoute = Date.now();
    const ticket = ++routeTicket;
    routeController = new AbortController();
    const controller = routeController;
    const timer = setTimeout(() => controller.abort(), 20000);
    status("Requesting driving route…");
    try {
      const isMapbox = provider.startsWith("mapbox-"),
        base = isMapbox
          ? "https://api.mapbox.com/directions/v5/mapbox/driving"
          : cfg.routingUrl;
      const url = new URL(
        base.replace(/\/$/, "") + "/" + a.join(",") + ";" + b.join(","),
      );
      if (url.protocol !== "https:" || url.username || url.password)
        throw Error(
          "Routing requires an HTTPS endpoint without embedded credentials.",
        );
      url.search = new URLSearchParams({
        overview: "full",
        geometries: "geojson",
        steps: "true",
        ...(isMapbox ? { access_token: cfg.mapboxToken } : {}),
      });
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok)
        throw Error(
          "Routing service unavailable (" +
            res.status +
            "). Use Navigate or try later.",
        );
      const text = await res.text();
      if (text.length > 5000000) throw Error("Route response too large.");
      const data = JSON.parse(text);
      if (ticket !== routeTicket) return;
      const r = data.routes?.[0];
      if (
        data.code !== "Ok" ||
        r?.geometry?.type !== "LineString" ||
        !Array.isArray(r.geometry.coordinates) ||
        r.geometry.coordinates.length < 2 ||
        r.geometry.coordinates.length > 50000
      )
        throw Error("No usable driving route found.");
      r.geometry.coordinates.forEach(C.coord);
      route = r;
      draw();
      $("route-summary").textContent =
        `${Number.isFinite(r.distance) ? (r.distance / 1000).toFixed(2) + " km" : "Distance unavailable"} · ${Number.isFinite(r.duration) ? Math.round(r.duration / 60) + " min estimated" : "Time unavailable"} · ${isMapbox ? "Mapbox" : "OSRM / OpenStreetMap"}`;
      for (const s of (r.legs || [])
        .flatMap((l) => l.steps || [])
        .slice(0, 500)) {
        const li = document.createElement("li");
        li.textContent =
          s.maneuver?.instruction ||
          [s.maneuver?.type, s.maneuver?.modifier, s.name]
            .filter(Boolean)
            .join(" ");
        $("steps").append(li);
      }
      $("route-details").hidden = false;
      status(
        "Driving route shown in orange. Direct geodesic measurement remains in teal.",
      );
    } catch (e) {
      if (ticket === routeTicket)
        throw Error(
          e.name === "AbortError"
            ? "Route timed out. Try again or use Navigate."
            : e.message,
        );
    } finally {
      clearTimeout(timer);
    }
  });
  on("north", "click", () => {
    if (kind === "gl" && map) map.easeTo({ bearing: 0 });
    status("North is up.");
  });
  on("tilt", "click", () => {
    if (kind !== "gl" || !ready)
      throw Error("Wait for a MapLibre or Mapbox map to load.");
    terrain = !terrain;
    if (terrain) {
      if (!map.getSource("fss-dem")) {
        const box = provider.startsWith("mapbox-");
        map.addSource(
          "fss-dem",
          box
            ? {
                type: "raster-dem",
                url: "mapbox://mapbox.mapbox-terrain-dem-v1",
                tileSize: 512,
                maxzoom: 14,
              }
            : {
                type: "raster-dem",
                tiles: [
                  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
                ],
                encoding: "terrarium",
                tileSize: 256,
                maxzoom: 15,
                attribution:
                  'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">Tilezen / AWS</a>',
              },
        );
      }
      map.setTerrain({ source: "fss-dem", exaggeration: 1 });
    } else map.setTerrain(null);
    map.easeTo({ pitch: terrain ? 55 : 0 });
    $("tilt").setAttribute("aria-pressed", String(terrain));
  });
  on(
    "own",
    "click",
    () =>
      new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(Error("This browser does not support location."));
          return;
        }
        status("Finding your position…");
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const c = pos.coords,
              p = [c.longitude, c.latitude];
            fly(p);
            status(
              `Device position · accuracy ±${c.accuracy.toFixed(1)} m · height ${Number.isFinite(c.altitude) ? c.altitude.toFixed(1) + " m (device datum)" : "unavailable"}`,
            );
            resolve();
          },
          (e) => reject(Error("Location unavailable: " + e.message)),
          { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
        );
      }),
  );
  on("export", "click", () => {
    const features = marks.map((m) =>
        C.feature("Point", m.p, m.name, { symbol: m.symbol }),
      ),
      blob = new Blob([JSON.stringify(fc(features), null, 2)], {
        type: "application/geo+json",
      }),
      url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = "fss-locations.geojson";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  links();
  draw();
  changeProvider().catch((e) => status(e.message));
})();
