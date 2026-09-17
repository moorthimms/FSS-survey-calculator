/* FSS map workspace. No location or landmark data is sent to the app server. */
(async function () {
  "use strict";
  const C = window.FSS,
    IO = window.FSSFiles,
    config = window.FSS_CONFIG;
  const $ = (id) => document?.getElementById(id),
    val = (id) => $(id).value,
    checked = (id) => $(id).checked;
  const say = (s, error = false) => {
    $("message").textContent = s;
    $("message").classList.toggle("error", error);
  };
  const safe =
    (fn) =>
    async (...args) => {
      try {
        return await fn(...args);
      } catch (e) {
        say(e.message || String(e), true);
      }
    };
  const on = (id, event, fn) => $(id).addEventListener(event, safe(fn));
  const set = (id, s) => {
    const element = $(id);
    if (element) element.textContent = s;
  };
  const collection = (features) => ({ type: "FeatureCollection", features });
  let state = {
    features: [],
    settings: {},
    view: { center: [78.0322, 30.3165], zoom: 12 },
    draft: [],
    record: null,
  };
  let db = null,
    selected = null,
    deleted = null,
    map,
    markers = [],
    vertices = [],
    profileMarker = null,
    profileData = null;
  let draft = [],
    editing = null,
    own = null,
    watch = null,
    record = null,
    nav = null,
    heading = null,
    compassStarted = false,
    navAlertAt = 0;
  let atlas = null,
    hgts = [],
    downloaded = null,
    areaBounds = null,
    downloadController = null,
    downloadBusy = false,
    terrainRevision = 0;
  const onlineElevation = new Map();
  let gridMarkers = [];
  let lastNavTime = null;
  let gpsTimer = null,
    ownMarker = null,
    saveTimer,
    saveQueue = Promise.resolve(),
    audioContext = null;
  const settingsIds = [
    "primary-format",
    "secondary-format",
    "show-coordinates",
    "primary-grid",
    "secondary-grid",
    "distance-unit",
    "area-unit",
    "show-labels",
    "gps-interval",
    "gps-accuracy",
    "gps-distance",
    "gps-speed",
    "gps-gap",
    "proximity",
    "off-path",
    "map-opacity",
  ];
  function dbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("fss-field-map-v1", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("data");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function dbOp(mode, key, value) {
    return new Promise((resolve, reject) => {
      if (!db) {
        reject(
          Error("Device storage unavailable. Export backups before leaving."),
        );
        return;
      }
      const tx = db.transaction(
          "data",
          mode === "get" || mode === "keys" ? "readonly" : "readwrite",
        ),
        store = tx.objectStore("data");
      const req =
        mode === "get"
          ? store.get(key)
          : mode === "keys"
            ? store.getAllKeys()
            : mode === "delete"
              ? store.delete(key)
              : store.put(value, key);
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error || Error("Storage transaction aborted."));
    });
  }
  function persistNow() {
    clearTimeout(saveTimer);
    if (!map) return;
    state.settings = Object.fromEntries(
      settingsIds.map((id) => [
        id,
        $(id).type === "checkbox" ? checked(id) : val(id),
      ]),
    );
    state.view = {
      center: map
        .getCenter()
        .toArray()
        .map((x, i) => (i ? x : C.wrap(x))),
      zoom: map.getZoom(),
    };
    state.draft = draft;
    state.draftMode = val("draw-mode");
    state.draftName = val("draw-name");
    state.record = record;
    const snapshot = structuredClone(state);
    saveQueue = saveQueue
      .catch(() => {})
      .then(() => dbOp("put", "project", snapshot))
      .then(() => set("save-status", "Saved on this device"))
      .catch(() => set("save-status", "Storage unavailable · export backup"));
  }
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 250);
  }
  function bounded(id, min, max) {
    const n = Number(val(id));
    if (!Number.isFinite(n) || val(id).trim() === "" || n < min || n > max)
      throw Error(
        `${$(id).parentElement.textContent.trim()}: choose ${min}–${max}.`,
      );
    return n;
  }
  function distance(m) {
    return val("distance-unit") === "imperial"
      ? m < 1609.344
        ? `${(m / 0.3048).toFixed(1)} ft`
        : `${(m / 1609.344).toFixed(3)} mi`
      : m < 1000
        ? `${m.toFixed(2)} m`
        : `${(m / 1000).toFixed(3)} km`;
  }
  function area(a) {
    return {
      m2: `${a.toFixed(2)} m²`,
      ha: `${(a / 10000).toFixed(4)} ha`,
      acres: `${(a / 4046.8564224).toFixed(4)} acres`,
      ft2: `${(a / 0.09290304).toFixed(2)} ft²`,
    }[val("area-unit")];
  }
  function stats(f) {
    const m = C.measure(f);
    if (f.geometry.type === "Point")
      return (
        C.formatCoord(f.geometry.coordinates, "DD") +
        (C.finite(f.geometry.coordinates[2])
          ? `\nHeight: ${f.geometry.coordinates[2].toFixed(2)} m · ${f.properties.heightReference || "Unspecified reference"}`
          : "\nHeight unavailable")
      );
    return `${f.geometry.type === "Polygon" ? "Perimeter" : "Length"}: ${distance(m.distance)}${f.geometry.type === "Polygon" ? `\nArea: ${area(m.area)}` : ""}\nWGS84 ellipsoid; horizontal measurement`;
  }
  function selectedFeature() {
    return state.features.find((f) => f.id === selected);
  }
  function showPanel(name) {
    $("panel-select").value = name;
    document
      .querySelectorAll(".panel")
      .forEach((e) => (e.hidden = e.id !== `panel-${name}`));
    $("tools").classList.remove("collapsed");
    $("toggle-tools").setAttribute("aria-expanded", "true");
    map?.resize();
  }
  function addFeatures(features) {
    const combined = C.validateFeatures(
      collection([...state.features, ...features]),
    );
    const ids = new Set();
    combined.forEach((f) => {
      if (ids.has(f.id)) f.id = C.cryptoId();
      ids.add(f.id);
    });
    state.features = combined;
    renderFeatures();
    renderList();
    persist();
  }
  function select(id) {
    selected = id;
    const f = selectedFeature();
    if (!f) return;
    $("editor").hidden = false;
    for (const p of ["name", "folder", "description", "color", "symbol"])
      $(`edit-${p}`).value = f.properties[p] || "";
    $("edit-visible").checked = f.properties.visible !== false;
    let summary = stats(f);
    if (f.geometry.type.includes("LineString")) {
      const p = C.profile(f),
        times = p.rows.map((r) => r.time).filter(C.finite),
        heights = p.rows.map((r) => r.height).filter(C.finite);
      summary += `\n${p.rows.length} vertices · ${C.segments(f).length} segments`;
      if (times.length > 1)
        summary += `\nElapsed span: ${((Math.max(...times) - Math.min(...times)) / 60000).toFixed(1)} min`;
      if (heights.length)
        summary += `\nHeight min / max: ${Math.min(...heights).toFixed(1)} / ${Math.max(...heights).toFixed(1)} m\nAscent / descent: ${p.ascent.toFixed(1)} / ${p.descent.toFixed(1)} m (unfiltered heights)`;
    }
    set("selected-stats", summary);
    renderList();
  }
  function zoomFeature(f) {
    const points =
      f.geometry.type === "Point"
        ? [f.geometry.coordinates]
        : C.segments(f).flat();
    if (points.length === 1)
      map.easeTo({ center: points[0], zoom: Math.max(14, map.getZoom()) });
    else {
      const b = new maplibregl.LngLatBounds(points[0], points[0]);
      points.forEach((p) => b.extend(p));
      map.fitBounds(b, { padding: 65, maxZoom: 17 });
    }
    if (innerWidth < 760) {
      $("tools").classList.add("collapsed");
      $("toggle-tools").setAttribute("aria-expanded", "false");
    }
  }
  function renderList() {
    const filter = val("search").toLowerCase(),
      folder = val("folder-filter");
    const list = $("landmark-list");
    list.replaceChildren();
    state.features
      .filter(
        (f) =>
          (!folder || f.properties.folder === folder) &&
          `${f.properties.name} ${f.properties.folder}`
            .toLowerCase()
            .includes(filter),
      )
      .forEach((f) => {
        const b = document.createElement("button");
        b.className = "landmark-item" + (f.id === selected ? " active" : "");
        b.textContent = `${f.properties.visible === false ? "◌" : "●"} ${f.properties.name} · ${f.geometry.type}`;
        b.onclick = () => select(f.id);
        list.append(b);
      });
    if (!list.childElementCount)
      list.textContent =
        "No landmarks yet. Create or import a point, route or area.";
    const folderVal = val("folder-filter");
    $("folder-filter").replaceChildren(new Option("All folders", ""));
    [...new Set(state.features.map((f) => f.properties.folder))]
      .sort()
      .forEach((f) => $("folder-filter").add(new Option(f, f)));
    $("folder-filter").value = folderVal;
    const navVal = val("nav-target");
    $("nav-target").replaceChildren(new Option("Choose a landmark", ""));
    state.features
      .filter((f) => f.geometry.type !== "Polygon")
      .forEach((f) => $("nav-target").add(new Option(f.properties.name, f.id)));
    $("nav-target").value = navVal;
  }
  function setGeo(id, features) {
    map.getSource(id)?.setData(collection(features));
  }
  function renderFeatures() {
    if (!map?.getSource("landmarks")) return;
    const features = state.features.filter(
      (f) => f.properties.visible !== false,
    );
    setGeo("landmarks", features);
    markers.forEach((m) => m.remove());
    markers = [];
    features
      .filter(
        (f) =>
          f.geometry.type === "Point" &&
          map.getBounds().contains(f.geometry.coordinates),
      )
      .slice(0, 250)
      .forEach((f) => {
        const el = document.createElement("div");
        el.className = "waypoint";
        el.style.background = f.properties.color;
        el.textContent =
          { pin: "•", flag: "⚑", camp: "▲", survey: "＋" }[
            f.properties.symbol
          ] || "•";
        if (checked("show-labels")) {
          const label = document.createElement("span");
          label.className = "waypoint-label";
          label.textContent = f.properties.name;
          el.append(label);
        }
        el.onclick = (e) => {
          e.stopPropagation();
          showPanel("landmarks");
          select(f.id);
        };
        markers.push(
          new maplibregl.Marker({ element: el })
            .setLngLat(f.geometry.coordinates)
            .addTo(map),
        );
      });
  }
  function drawFeature(points = draft) {
    const mode = val("draw-mode");
    if (mode === "browse" || !points.length) return null;
    if (mode === "Point") return C.feature("Point", points[0]);
    if (mode === "Polygon" && points.length >= 3)
      return C.feature("Polygon", [[...points, points[0]]]);
    if (points.length >= 2) return C.feature("LineString", points);
    return C.feature("Point", points[0]);
  }
  function refreshDraft() {
    vertices.forEach((m) => m.remove());
    vertices = [];
    const f = drawFeature();
    setGeo("draft", f ? [f] : []);
    set(
      "measure",
      f
        ? `${draft.length} vertices\n${stats(f)}${draft.length > 1 ? `\nLast leg bearing: ${C.inverse(draft.at(-2), draft.at(-1)).bearing.toFixed(2)}° true` : ""}`
        : "Choose a drawing tool to begin.",
    );
    draft.forEach((p, i) => {
      const el = document.createElement("div");
      el.className = "vertex";
      const marker = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat(p)
        .addTo(map);
      marker.on("dragend", () => {
        const q = marker.getLngLat();
        draft[i] = [C.wrap(q.lng), q.lat];
        refreshDraft();
        persist();
      });
      vertices.push(marker);
    });
    persist();
  }
  function addPoint(p) {
    const mode = val("draw-mode");
    if (mode === "browse") throw Error("Select Waypoint, Route or Area first.");
    if (draft.length >= 2000) throw Error("Drawing limit is 2,000 vertices.");
    p = C.coord(p);
    if (mode === "Point") draft = [p];
    else draft.push(p);
    refreshDraft();
  }
  function centerPoint() {
    const p = map.getCenter();
    return [C.wrap(p.lng), p.lat];
  }
  function groundHeight(p) {
    if (val("terrain-source") === "hgt") {
      for (const h of hgts) {
        const v = h.height(p);
        if (v !== null) return v;
      }
      return null;
    }
    if (val("terrain-source") === "online") {
      // Read the source DEM, never the exaggerated display mesh (which also
      // returns zero for some missing-tile cases in MapLibre).
      for (let z = Math.min(15, Math.floor(map.getZoom())); z >= 0; z--) {
        const [x, y] = C.tileXY(p, z),
          image = onlineElevation.get(`${z}/${x}/${y}`);
        if (image) return C.terrariumHeight(p, [z, x, y], image);
      }
    }
    return null;
  }
  function updateCenter() {
    const p = centerPoint();
    $("coordinates").hidden = !checked("show-coordinates");
    for (const [id, fmt] of [
      ["coord-primary", "primary-format"],
      ["coord-secondary", "secondary-format"],
    ]) {
      try {
        set(id, C.formatCoord(p, val(fmt), config));
      } catch (e) {
        set(id, e.message);
      }
    }
    const h = groundHeight(p);
    set(
      "center-height",
      h === null
        ? "Ground elevation unavailable"
        : `Ground elevation: ${h.toFixed(1)} m · ${val("terrain-source") === "hgt" ? "HGT source datum" : "terrain source datum"}`,
    );
    set("terrain-readout", $("center-height").textContent);
    if (
      draft.length &&
      val("draw-mode") !== "Point" &&
      val("draw-mode") !== "browse"
    ) {
      const leg = C.inverse(draft.at(-1), p);
      setGeo("preview", [C.feature("LineString", [draft.at(-1), p])]);
      set(
        "measure",
        `${draft.length} fixed vertices\nPreview leg: ${distance(leg.distance)} · ${leg.bearing.toFixed(2)}° true\n${stats(drawFeature([...draft, p]))}`,
      );
    } else setGeo("preview", []);
  }
  function updateGrid() {
    gridMarkers.forEach((m) => m.remove());
    gridMarkers = [];
    const b = map.getBounds(),
      p = centerPoint(),
      bounds = [
        Math.max(-180, b.getWest()),
        Math.max(-85, b.getSouth()),
        Math.min(180, b.getEast()),
        Math.min(85, b.getNorth()),
      ];
    for (const [id, fmt, toggle] of [
      ["grid1", "primary-format", "primary-grid"],
      ["grid2", "secondary-format", "secondary-grid"],
    ]) {
      try {
        const lines = checked(toggle)
          ? C.grid(p, bounds, val(fmt), config)
          : [];
        setGeo(id, lines);
        for (const line of lines) {
          const el = document.createElement("div");
          el.className = "grid-label";
          el.style.color = id === "grid2" ? "#226fbe" : "#45604d";
          el.textContent = line.properties.gridLabel;
          const c = line.geometry.coordinates;
          gridMarkers.push(
            new maplibregl.Marker({ element: el })
              .setLngLat(c[Math.floor((c.length - 1) / 2)])
              .addTo(map),
          );
        }
      } catch (e) {
        setGeo(id, []);
        say(e.message, true);
      }
    }
  }
  function exportSelection() {
    let fs = state.features;
    if (val("export-scope") === "selected")
      fs = fs.filter((f) => f.id === selected);
    if (val("export-scope") === "folder") {
      if (!val("folder-filter")) throw Error("Choose a folder first.");
      fs = fs.filter((f) => f.properties.folder === val("folder-filter"));
    }
    if (!fs.length) throw Error("No landmarks selected for export.");
    return fs;
  }
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function drawProfile() {
    const f = selectedFeature();
    if (!f) return;
    profileData = C.profile(f);
    if (!profileData.rows.length)
      throw Error("Select a route or track for its profile.");
    $("profile-panel").hidden = false;
    $("profile-index").max = profileData.rows.length - 1;
    $("profile-index").value = 0;
    const canvas = $("profile-canvas"),
      ctx = canvas.getContext("2d"),
      w = canvas.width,
      h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.font = "11px system-ui";
    const xkey = val("profile-x"),
      rows = profileData.rows,
      validX = rows.filter((r) => C.finite(r[xkey]));
    if (!validX.length) {
      ctx.fillText(
        "No reported timestamps for this track. Use the distance axis.",
        20,
        70,
      );
      return;
    }
    const xmin = Math.min(...validX.map((r) => r[xkey])),
      xmax = Math.max(...validX.map((r) => r[xkey]));
    const px = (x) => 65 + ((x - xmin) / (xmax - xmin || 1)) * (w - 130);
    ctx.strokeStyle = "#d4e2e5";
    ctx.strokeRect(65, 25, w - 130, h - 55);
    const units = {
      height: "m",
      speed: val("distance-unit") === "imperial" ? "mph" : "km/h",
      incline: "%",
      accuracy: "m",
      verticalAccuracy: "m",
    };
    const scaled = (value, key) =>
      key === "speed"
        ? value * (val("distance-unit") === "imperial" ? 2.236936292 : 3.6)
        : value;
    let any = false;
    for (const [key, color, right] of [
      [val("profile-y"), "#147c7e", false],
      [val("profile-y2"), "#cc753a", true],
    ]) {
      if (key === "none") continue;
      const valid = rows.filter((r) => C.finite(r[key]) && C.finite(r[xkey]));
      ctx.fillStyle = color;
      if (!valid.length) {
        ctx.fillText(`${key}: unavailable`, right ? w / 2 : 65, 14);
        continue;
      }
      any = true;
      const ymin = Math.min(...valid.map((r) => scaled(r[key], key))),
        ymax = Math.max(...valid.map((r) => scaled(r[key], key)));
      const py = (y) =>
        h - 30 - ((scaled(y, key) - ymin) / (ymax - ymin || 1)) * (h - 60);
      ctx.fillText(`${key} (${units[key]})`, right ? w / 2 : 65, 14);
      ctx.fillText(ymax.toFixed(1), right ? w - 60 : 2, 35);
      ctx.fillText(ymin.toFixed(1), right ? w - 60 : 2, h - 32);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let drawing = false;
      for (const r of rows) {
        if (!C.finite(r[key]) || !C.finite(r[xkey]) || r.segmentStart)
          drawing = false;
        if (!C.finite(r[key]) || !C.finite(r[xkey])) continue;
        const x = px(r[xkey]),
          y = py(r[key]);
        if (!drawing) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        drawing = true;
      }
      ctx.stroke();
    }
    ctx.fillStyle = "#526c75";
    const label = (x) =>
      xkey === "time" ? new Date(x).toISOString().slice(11, 19) : distance(x);
    ctx.fillText(label(xmin), 65, h - 8);
    ctx.fillText(label(xmax), w - 160, h - 8);
    ctx.fillText(xkey === "time" ? "Time (UTC)" : "Distance", w / 2, h - 8);
    if (!any) ctx.fillText("No reported values for these axes.", 80, 90);
    profileSample(0);
  }
  function profileSample(index) {
    const r = profileData?.rows[index];
    if (!r) return;
    const h = C.finite(r.height) ? r.height.toFixed(2) + " m" : "unavailable",
      speed = C.finite(r.speed)
        ? (r.speed * 3.6).toFixed(2) + " km/h"
        : "unavailable";
    set(
      "profile-value",
      `${distance(r.distance)} · height ${h} · speed ${speed} · incline ${r.incline === null ? "unavailable" : r.incline.toFixed(1) + "%"} · H accuracy ${r.accuracy ?? "unreported"} m · V accuracy ${r.verticalAccuracy ?? "unreported"} m · ${r.time === null ? "time unavailable" : new Date(r.time).toISOString()}\nHeight reference: ${selectedFeature()?.properties.heightReference || "Unspecified"}`,
    );
    if (!profileMarker)
      profileMarker = new maplibregl.Marker({ color: "#db783c" })
        .setLngLat(r.p)
        .addTo(map);
    else profileMarker.setLngLat(r.p);
  }

  // GPS: accepted fixes are kept separate from device-reported uncertainty.
  function freshOwn() {
    if (!own || watch === null || Date.now() - own.time > 15000)
      throw Error("Start GPS and wait for a fresh position.");
    return own;
  }
  function gpsSettings() {
    return {
      interval: bounded("gps-interval", 1, 60),
      maxAccuracy: bounded("gps-accuracy", 1, 1000),
      minDistance: bounded("gps-distance", 0, 100),
      maxSpeed: bounded("gps-speed", 1, 400),
      gapSeconds: bounded("gps-gap", 5, 600),
    };
  }
  function updateOwn() {
    if (!own || watch === null || Date.now() - own.time > 15000) {
      set(
        "gps-readout",
        "GPS fix unavailable or stale. Waiting for a fresh reading.",
      );
      ownMarker?.remove();
      ownMarker = null;
      setGeo("accuracy", []);
      setGeo("navigation", []);
      set(
        "nav-readout",
        nav
          ? "Navigation paused: current position unavailable."
          : "No active target.",
      );
      return;
    }
    const h = own.p[2];
    set(
      "gps-readout",
      `${C.formatCoord(own.p, "DD")}\nHorizontal accuracy: ${own.accuracy.toFixed(1)} m\nHeight (WGS84 ellipsoid): ${C.finite(h) ? h.toFixed(2) + " m" : "unavailable"}\nVertical accuracy: ${own.verticalAccuracy === null ? "unreported" : own.verticalAccuracy.toFixed(1) + " m"}\nSpeed: ${own.speed === null ? "unreported" : (own.speed * 3.6).toFixed(1) + " km/h"}\n${new Date(own.time).toISOString()}`,
    );
    if (!ownMarker)
      ownMarker = new maplibregl.Marker({ color: "#267add" })
        .setLngLat(own.p)
        .addTo(map);
    else ownMarker.setLngLat(own.p);
    const ring = Array.from({ length: 65 }, (_, i) =>
      C.direct(own.p, (i * 360) / 64, own.accuracy),
    );
    setGeo("accuracy", [C.feature("Polygon", [ring])]);
    if (checked("follow-location")) map.jumpTo({ center: own.p });
    if (
      val("orientation") === "gps" &&
      own.heading !== null &&
      own.speed !== null &&
      own.speed > 0.5
    )
      map.setBearing(own.heading);
    navigate();
  }
  function recordView() {
    if (!record) {
      set("record-state", "Recorder idle");
      setGeo("recording", []);
      return;
    }
    const lines = record.segments
      .map((s) => s.map((x) => x.p))
      .filter((s) => s.length >= 2);
    setGeo(
      "recording",
      lines.length ? [C.feature("MultiLineString", lines)] : [],
    );
    set(
      "record-state",
      `${record.paused ? "Paused" : "Recording"} · ${record.segments.reduce((n, s) => n + s.length, 0)} fixes\n${record.reason || "Waiting for accepted GPS fixes"}`,
    );
  }
  function receivePosition(pos) {
    let sample;
    try {
      sample = C.gpsSample(pos);
    } catch (e) {
      say(e.message, true);
      return;
    }
    if (own && sample.time <= own.time) return;
    own = sample;
    updateOwn();
    if (record && !record.paused) {
      try {
        const prev = record.segments.at(-1)?.at(-1),
          decision = C.acceptSample(prev, sample, gpsSettings());
        record.reason = decision.reason || "Fix accepted";
        if (decision.accept) {
          if (
            record.segments.reduce((n, s) => n + s.length, 0) >= C.MAX_POINTS
          ) {
            record.paused = true;
            record.reason =
              "50,000-point limit reached. Finish and export this track.";
          } else {
            if (decision.gap || record.newSegment || !record.segments.length) {
              record.segments.push([]);
              record.newSegment = false;
            }
            record.segments.at(-1).push(sample);
            persist();
          }
        }
        recordView();
      } catch (e) {
        record.paused = true;
        record.reason = e.message;
        recordView();
      }
    }
  }
  function startGps() {
    if (watch !== null) return;
    if (!navigator.geolocation)
      throw Error("Geolocation is unavailable in this browser.");
    gpsSettings();
    watch = navigator.geolocation.watchPosition(
      receivePosition,
      (e) => {
        say(`GPS: ${e.message}`, true);
        if (e.code === 1) stopGps();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
    gpsTimer = setInterval(updateOwn, 1000);
    say("GPS requested. Allow location access in your browser.");
  }
  function stopGps() {
    if (watch !== null) navigator.geolocation.clearWatch(watch);
    watch = null;
    clearInterval(gpsTimer);
    gpsTimer = null;
    if (record) {
      record.paused = true;
      record.newSegment = true;
      record.reason = "GPS stopped";
      persist();
      recordView();
    }
    updateOwn();
  }
  function finishRecord() {
    if (!record) return;
    const features = [],
      lines = [],
      samples = [];
    for (const seg of record.segments) {
      if (seg.length >= 2) {
        lines.push(seg.map((s) => s.p));
        samples.push(...seg);
      } else if (seg.length === 1)
        features.push(
          C.feature("Point", seg[0].p, `${record.name} · isolated fix`, {
            samples: [seg[0]],
            heightReference: "WGS84 ellipsoid",
          }),
        );
    }
    if (lines.length)
      features.unshift(
        C.feature(
          lines.length === 1 ? "LineString" : "MultiLineString",
          lines.length === 1 ? lines[0] : lines,
          record.name,
          {
            samples,
            heightReference: "WGS84 ellipsoid",
            folder: "Recorded tracks",
          },
        ),
      );
    if (!features.length)
      throw Error("No accepted fixes yet. Start GPS or resume recording.");
    addFeatures(features);
    record = null;
    recordView();
    persist();
    say("Track saved. Gaps remain separate segments.");
  }
  function alertNavigation(message) {
    say(message, true);
    if (!checked("audio-alerts") || Date.now() - navAlertAt < 15000) return;
    navAlertAt = Date.now();
    navigator.vibrate?.([150, 100, 150]);
    if (audioContext) {
      const o = audioContext.createOscillator(),
        g = audioContext.createGain();
      o.frequency.value = 700;
      g.gain.value = 0.08;
      o.connect(g);
      g.connect(audioContext.destination);
      o.start();
      o.stop(audioContext.currentTime + 0.25);
    }
  }
  function navigate() {
    if (!nav) return;
    if (lastNavTime === own.time) return;
    lastNavTime = own.time;
    const f = state.features.find((x) => x.id === nav);
    if (!f) {
      nav = null;
      return;
    }
    let target, report;
    if (f.geometry.type === "Point") {
      target = f.geometry.coordinates;
      const inv = C.inverse(own.p, target);
      report = `Target: ${f.properties.name}\nDistance: ${distance(inv.distance)} · bearing ${inv.bearing.toFixed(1)}° true`;
      if (inv.distance <= Number(val("proximity")))
        alertNavigation("Within the target proximity radius.");
    } else {
      const r = C.routeProgress(own.p, f);
      if (!r) return;
      target = r.target;
      report = `Following: ${f.properties.name}\nRemaining along path: ${distance(r.remaining)}\nOff path: ${distance(r.off)}\nBearing to next target: ${C.inverse(own.p, target).bearing.toFixed(1)}° true`;
      if (r.off > Number(val("off-path")))
        alertNavigation("Off-path alert: return to the displayed route.");
      else if (r.remaining <= Number(val("proximity")))
        alertNavigation("Near the end of the path.");
    }
    setGeo("navigation", [C.feature("LineString", [own.p, target])]);
    set("nav-readout", report);
    const bearing = C.inverse(own.p, target).bearing,
      reference = own.heading;
    $("compass-arrow").style.transform =
      `rotate(${bearing - (reference ?? 0)}deg)`;
    set(
      "compass-text",
      reference === null
        ? `Target ${bearing.toFixed(0)}° true`
        : `Target ${bearing.toFixed(0)}° · GPS course ${reference.toFixed(0)}° true`,
    );
  }
  function orientationEvent(e) {
    if (C.finite(e.webkitCompassHeading) && e.webkitCompassHeading >= 0)
      heading = e.webkitCompassHeading;
    else if (e.absolute === true && C.finite(e.alpha))
      heading = (360 - e.alpha) % 360;
    else return;
    set("compass-text", `Device ${heading.toFixed(0)}° (sensor reference)`);
    if (val("orientation") === "compass") map.setBearing(heading);
    if (nav && own && Date.now() - own.time <= 15000) {
      lastNavTime = null;
      navigate();
    }
  }

  // Local map / DEM protocols. Missing tiles fail clearly and never contact another source.
  async function pngBuffer(canvas) {
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? blob.arrayBuffer().then(resolve, reject)
            : reject(Error("Cannot encode terrain tile.")),
        "image/png",
      ),
    );
  }
  let blankTile;
  async function transparentTile() {
    if (!blankTile) {
      const c = document.createElement("canvas");
      c.width = c.height = 256;
      blankTile = await pngBuffer(c);
    }
    return blankTile.slice(0);
  }
  maplibregl.addProtocol("fssatlas", async (params) => {
    const [z, x, y] = params.url
      .replace("fssatlas://", "")
      .split("/")
      .map(Number);
    const b = atlas?.tile(z, x, y);
    return { data: b ? b.slice().buffer : await transparentTile() };
  });
  maplibregl.addProtocol("fsssaved", async (params) => {
    const key = params.url.replace("fsssaved://", "");
    const tile = downloaded?.tiles?.[key];
    return { data: tile ? tile.slice(0) : await transparentTile() };
  });
  maplibregl.addProtocol("fssdem", async (params) => {
    const [kind, z, x, y] = params.url.replace("fssdem://", "").split("/");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext("2d"),
      img = ctx.createImageData(256, 256);
    for (let j = 0; j < 256; j++)
      for (let i = 0; i < 256; i++) {
        const p = C.tilePoint(
          Number(x) + (i + 0.5) / 256,
          Number(y) + (j + 0.5) / 256,
          Number(z),
        );
        let h = null;
        for (const t of hgts) {
          h = t.height(p);
          if (h !== null) break;
        }
        const offset = (j * 256 + i) * 4;
        if (kind === "rgb") {
          const v = Math.max(0, Math.round(((h ?? 0) + 10000) * 10));
          img.data[offset] = v >> 16;
          img.data[offset + 1] = (v >> 8) & 255;
          img.data[offset + 2] = v & 255;
          img.data[offset + 3] = 255;
        } else if (h !== null) {
          let color;
          if (kind === "slope") {
            let east = null,
              north = null;
            for (const t of hgts) {
              const phi = (p[1] * Math.PI) / 180,
                q = 1 - 0.00669437999014 * Math.sin(phi) ** 2,
                N = 6378137 / Math.sqrt(q),
                M = (6378137 * (1 - 0.00669437999014)) / q ** 1.5;
              east =
                east ??
                t.height([
                  p[0] + ((30 / (N * Math.cos(phi))) * 180) / Math.PI,
                  p[1],
                ]);
              north =
                north ?? t.height([p[0], p[1] + ((30 / M) * 180) / Math.PI]);
            }
            if (east === null || north === null) continue;
            const slope =
              (Math.atan(Math.hypot(east - h, north - h) / 30) * 180) / Math.PI;
            color =
              slope < 15
                ? [78, 154, 90]
                : slope < 30
                  ? [215, 183, 73]
                  : slope < 45
                    ? [223, 123, 51]
                    : [179, 65, 56];
          } else {
            const t = Math.min(1, Math.max(0, h / 6000));
            color = [
              Math.round(70 + 180 * t),
              Math.round(140 + 90 * t),
              Math.round(80 + 155 * t),
            ];
          }
          img.data.set([...color, 170], offset);
        }
      }
    ctx.putImageData(img, 0, 0);
    return { data: await pngBuffer(canvas) };
  });
  async function rememberElevation(path, bytes) {
    if (onlineElevation.has(path)) return;
    const bitmap = await createImageBitmap(
      new Blob([bytes], { type: "image/png" }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (onlineElevation.size >= 32)
      onlineElevation.delete(onlineElevation.keys().next().value);
    onlineElevation.set(path, pixels);
  }
  maplibregl.addProtocol("fssnetdem", async (params, controller) => {
    const path = params.url.replace("fssnetdem://", ""),
      key = "dem:" + path;
    let cached;
    try {
      cached = await dbOp("get", key);
    } catch {}
    if (cached) {
      await rememberElevation(path, cached);
      return { data: cached };
    }
    const response = await fetch(
      `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${path}.png`,
      { signal: controller.signal },
    );
    if (!response.ok)
      throw Error("Online elevation unavailable. Import HGT to work offline.");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2 * 1024 * 1024)
      throw Error("Elevation tile too large.");
    await rememberElevation(path, bytes);
    try {
      const keys = (await dbOp("keys")).filter((k) =>
        String(k).startsWith("dem:"),
      );
      if (keys.length < 256) await dbOp("put", key, bytes);
    } catch {}
    return { data: bytes };
  });
  function removeLayer(id) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  function removeSource(id) {
    if (map.getSource(id)) map.removeSource(id);
  }
  function customUrl() {
    const raw = val("tile-url").trim();
    if (!["{z}", "{x}", "{y}"].every((t) => raw.includes(t)))
      throw Error("Use an HTTPS XYZ URL containing {z}, {x} and {y}.");
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password)
      throw Error("Use an HTTPS URL without embedded credentials.");
    return raw;
  }
  function applyBasemap() {
    const type = val("basemap");
    let source = null;
    if (type === "osm")
      source = {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
      };
    if (type === "custom") {
      const attribution = val("tile-attribution").trim();
      if (!attribution) throw Error("Enter your provider attribution.");
      source = {
        type: "raster",
        tiles: [customUrl()],
        tileSize: 256,
        maxzoom: 22,
        attribution: attribution.replace(/[<>]/g, ""),
      };
    }
    if (type === "mbtiles") {
      if (!atlas) throw Error("Import an MBTiles atlas first.");
      source = {
        type: "raster",
        tiles: ["fssatlas://{z}/{x}/{y}"],
        tileSize: 256,
        minzoom: atlas.min,
        maxzoom: atlas.max,
        attribution: (
          atlas.info.attribution ||
          atlas.info.name ||
          "Imported offline atlas"
        ).replace(/[<>]/g, ""),
      };
    }
    if (type === "cache") {
      if (!downloaded || !Object.keys(downloaded.tiles).length)
        throw Error("No downloaded area available.");
      source = {
        type: "raster",
        tiles: ["fsssaved://{z}/{x}/{y}"],
        tileSize: 256,
        minzoom: downloaded.min,
        maxzoom: downloaded.max,
        attribution: downloaded.attribution.replace(/[<>]/g, ""),
      };
    }
    removeLayer("basemap");
    removeSource("basemap");
    if (source) {
      map.addSource("basemap", source);
      map.addLayer(
        {
          id: "basemap",
          type: "raster",
          source: "basemap",
          paint: { "raster-opacity": Number(val("map-opacity")) },
        },
        "accuracy-fill",
      );
    }
    say(
      type === "blank"
        ? "Blank offline map. Import an atlas or add landmarks."
        : `Map source applied: ${$("basemap").selectedOptions[0].textContent}`,
    );
  }
  function applyTerrain() {
    const source = val("terrain-source");
    if (source === "hgt" && !hgts.length)
      throw Error("Import a valid HGT file first.");
    if (
      source !== "hgt" &&
      (checked("terrain-colors") || checked("slope-layer"))
    )
      throw Error("Terrain color and slope layers require imported HGT.");
    map.setTerrain(null);
    for (const id of ["dem-hillshade", "dem-colors", "dem-slope"])
      removeLayer(id);
    for (const id of ["dem", "dem-colors", "dem-slope"]) removeSource(id);
    if (source === "none") {
      updateCenter();
      return;
    }
    terrainRevision++;
    map.addSource("dem", {
      type: "raster-dem",
      tiles: [
        source === "hgt"
          ? "fssdem://rgb/{z}/{x}/{y}"
          : "fssnetdem://{z}/{x}/{y}",
      ],
      tileSize: 256,
      maxzoom: source === "hgt" ? 14 : 15,
      encoding: source === "hgt" ? "mapbox" : "terrarium",
      attribution:
        source === "hgt"
          ? "Imported HGT"
          : '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Terrain: Mapzen / USGS and contributors</a>',
    });
    if (checked("hillshade"))
      map.addLayer(
        {
          id: "dem-hillshade",
          type: "hillshade",
          source: "dem",
          paint: { "hillshade-exaggeration": 0.4 },
        },
        "landmarks-fill",
      );
    if (checked("terrain-3d"))
      map.setTerrain({
        source: "dem",
        exaggeration: Number(val("exaggeration")),
      });
    for (const [id, kind] of [
      ["dem-colors", "color"],
      ["dem-slope", "slope"],
    ])
      if (checked(kind === "color" ? "terrain-colors" : "slope-layer")) {
        map.addSource(id, {
          type: "raster",
          tiles: [`fssdem://${kind}/{z}/{x}/{y}`],
          tileSize: 256,
          maxzoom: 14,
        });
        map.addLayer(
          { id, type: "raster", source: id, paint: { "raster-opacity": 0.65 } },
          "landmarks-fill",
        );
      }
    map.setPitch(checked("terrain-3d") ? 60 : checked("perspective") ? 60 : 0);
    updateCenter();
    say(
      "Elevation layers applied. Ground DEM and GPS height are separate measurements.",
    );
  }
  function offlinePlan() {
    if (!areaBounds) throw Error("Select current map bounds first.");
    return C.tilePlan(
      areaBounds,
      bounded("offline-min", 0, 18),
      bounded("offline-max", 0, 18),
    );
  }
  async function downloadArea() {
    if (downloadBusy) throw Error("An area download is already active.");
    if (!checked("offline-permitted"))
      throw Error(
        "Choose a provider that permits offline downloading and check its permission.",
      );
    const url = customUrl(),
      host = new URL(url).hostname;
    if (host === "openstreetmap.org" || host.endsWith(".openstreetmap.org"))
      throw Error(
        "Offline downloading from public OpenStreetMap servers is not permitted.",
      );
    if (!val("tile-attribution").trim())
      throw Error("Provide the source attribution.");
    const plan = offlinePlan(),
      pack = {
        tiles: {},
        min: Number(val("offline-min")),
        max: Number(val("offline-max")),
        attribution: val("tile-attribution"),
        bounds: areaBounds,
      };
    downloadController = new AbortController();
    downloadBusy = true;
    $("download-tiles").disabled = true;
    let bytes = 0,
      failures = 0;
    $("download-progress").max = plan.length;
    $("download-progress").value = 0;
    try {
      for (let i = 0; i < plan.length; i++) {
        if (downloadController.signal.aborted) break;
        const t = plan[i],
          target = url
            .replace("{z}", t.z)
            .replace("{x}", t.x)
            .replace("{y}", t.y);
        try {
          const res = await fetch(target, {
            signal: downloadController.signal,
          });
          if (!res.ok || !res.headers.get("content-type")?.startsWith("image/"))
            throw Error("Tile unavailable");
          const data = await res.arrayBuffer();
          if (
            data.byteLength > 2 * 1024 * 1024 ||
            bytes + data.byteLength > 80 * 1024 * 1024
          )
            throw Error("Download size limit reached");
          const bitmap = await createImageBitmap(new Blob([data]));
          bitmap.close();
          pack.tiles[`${t.z}/${t.x}/${t.y}`] = data;
          bytes += data.byteLength;
        } catch (e) {
          if (downloadController.signal.aborted) break;
          failures++;
          if (e.message.includes("size limit")) break;
        }
        $("download-progress").value = i + 1;
        set(
          "download-state",
          `${i + 1}/${plan.length} processed · ${(bytes / 1048576).toFixed(1)} MB · ${failures} failed`,
        );
      }
      if (!Object.keys(pack.tiles).length)
        throw Error(
          "No tiles downloaded. Check the source, CORS access and selected area.",
        );
      await dbOp("put", "downloaded", pack);
      downloaded = pack;
      $("basemap").value = "cache";
      applyBasemap();
      say(
        `Saved ${Object.keys(pack.tiles).length}/${plan.length} tiles${downloadController.signal.aborted ? " (cancelled early)" : ""}. Missing tiles remain blank.`,
      );
    } finally {
      downloadBusy = false;
      $("download-tiles").disabled = false;
    }
  }

  // Restore the local project before starting the map; never resume GPS silently.
  for (const id of ["primary-format", "secondary-format", "entry-format"])
    config.catalog.forEach((zone) =>
      $(id).add(new Option(`DSM ${zone}`, `DSM ${zone}`)),
    );
  try {
    db = await dbOpen();
    const saved = await dbOp("get", "project");
    if (saved) {
      state.features = C.validateFeatures(collection(saved.features || []));
      state.settings = saved.settings || {};
      if (saved.view && Array.isArray(saved.view.center)) {
        state.view = {
          center: C.coord(saved.view.center),
          zoom: Math.max(0, Math.min(22, Number(saved.view.zoom) || 12)),
        };
      }
      draft = Array.isArray(saved.draft)
        ? saved.draft.slice(0, 2000).map(C.coord)
        : [];
      state.draftMode = saved.draftMode;
      state.draftName = saved.draftName;
      record = saved.record;
      if (record) {
        record.paused = true;
        record.newSegment = true;
        record.reason = "Recovered recording. Resume after starting GPS.";
      }
    }
    for (const [id, value] of Object.entries(state.settings))
      if (settingsIds.includes(id)) {
        if ($(id).type === "checkbox") $(id).checked = Boolean(value);
        else $(id).value = String(value);
      }
    set("save-status", "Local project restored");
  } catch (e) {
    say(`Could not restore local storage: ${e.message}`, true);
    set("save-status", "Use project exports for backup");
  }
  try {
    map = new maplibregl.Map({
      container: "map",
      center: state.view.center,
      zoom: state.view.zoom,
      maxPitch: 75,
      attributionControl: true,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#dce7e3" },
          },
        ],
      },
    });
  } catch (e) {
    say(
      "Interactive mapping requires WebGL. Enable browser hardware acceleration or use another browser.",
      true,
    );
    return;
  }
  map.addControl(
    new maplibregl.NavigationControl({ visualizePitch: true }),
    "top-right",
  );
  map.addControl(
    new maplibregl.FullscreenControl({ container: document.documentElement }),
  );
  const scale = new maplibregl.ScaleControl({ unit: val("distance-unit") });
  map.addControl(scale, "bottom-right");
  map.on("error", (e) => {
    if (e.error?.message && !e.error.message.includes("abort"))
      say(
        `Map data could not load: ${e.error.message.slice(0, 160)}. Use an offline atlas or another source.`,
        true,
      );
  });
  map.on(
    "load",
    safe(async () => {
      for (const id of [
        "accuracy",
        "landmarks",
        "draft",
        "preview",
        "recording",
        "navigation",
        "grid1",
        "grid2",
      ])
        map.addSource(id, { type: "geojson", data: collection([]) });
      const fill = (id, color, opacity) =>
        map.addLayer({
          id: `${id}-fill`,
          type: "fill",
          source: id,
          filter: ["==", ["geometry-type"], "Polygon"],
          paint: { "fill-color": color, "fill-opacity": opacity },
        });
      fill("accuracy", "#3484cf", 0.12);
      fill("landmarks", ["coalesce", ["get", "color"], "#167c80"], 0.24);
      fill("draft", "#dc853b", 0.25);
      for (const [id, color, width] of [
        ["landmarks", ["coalesce", ["get", "color"], "#167c80"], 3],
        ["draft", "#d4773b", 3],
        ["preview", "#b67d42", 2],
        ["recording", "#c33d56", 4],
        ["navigation", "#315edf", 3],
        ["grid1", "#5d6c60", 1],
        ["grid2", "#2678c7", 1],
      ])
        map.addLayer({
          id: `${id}-line`,
          type: "line",
          source: id,
          paint: {
            "line-color": color,
            "line-width": width,
            "line-opacity": id.startsWith("grid") ? 0.6 : 1,
          },
        });
      map.addLayer({
        id: "landmarks-points",
        type: "circle",
        source: "landmarks",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 5,
          "circle-color": ["coalesce", ["get", "color"], "#167c80"],
        },
      });
      map.on(
        "click",
        safe((e) => {
          if (val("draw-mode") !== "browse") {
            addPoint([C.wrap(e.lngLat.lng), e.lngLat.lat]);
            return;
          }
          const matches = map.queryRenderedFeatures(e.point, {
            layers: ["landmarks-points", "landmarks-line", "landmarks-fill"],
          });
          if (matches.length) {
            showPanel("landmarks");
            select(String(matches[0].id));
          } else map.easeTo({ center: e.lngLat, duration: 200 });
        }),
      );
      map.on("move", updateCenter);
      map.on("moveend", () => {
        updateGrid();
        renderFeatures();
        persist();
      });
      map.on("idle", () => {
        const h = groundHeight(centerPoint());
        set(
          "center-height",
          h === null
            ? "Ground elevation unavailable"
            : `Ground elevation: ${h.toFixed(1)} m · source DEM datum`,
        );
        set("terrain-readout", $("center-height").textContent);
      });
      applyBasemap();
      renderFeatures();
      renderList();
      updateCenter();
      updateGrid();
      recordView();
      try {
        downloaded = await dbOp("get", "downloaded");
        const rawAtlas = await dbOp("get", "atlas");
        if (rawAtlas) {
          atlas = await IO.openMbtiles(rawAtlas.buffer);
          set(
            "atlas-info",
            `${rawAtlas.name}\n${atlas.count} tiles · zoom ${atlas.min}–${atlas.max}`,
          );
        }
        const hs = await dbOp("get", "hgt");
        if (hs) hgts = hs.map((h) => new C.Hgt(h.name, h.buffer));
        set(
          "hgt-list",
          hgts.length
            ? hgts.map((h) => h.name).join("\n")
            : "No HGT data loaded.",
        );
        if (downloaded)
          set(
            "download-state",
            `${Object.keys(downloaded.tiles).length} stored tiles available.`,
          );
      } catch (e) {
        say(`Offline data could not be restored: ${e.message}`, true);
      }
      if (draft.length) {
        $("draw-mode").value = ["Point", "LineString", "Polygon"].includes(
          state.draftMode,
        )
          ? state.draftMode
          : draft.length === 1
            ? "Point"
            : "LineString";
        $("draw-name").value = state.draftName || "";
        refreshDraft();
        say("Recovered unfinished drawing.");
      } else say("Ready. Choose a tool to mark, measure or record.");
    }),
  );

  // User actions.
  on("toggle-tools", "click", () => {
    const hidden = $("tools").classList.toggle("collapsed");
    $("toggle-tools").setAttribute("aria-expanded", String(!hidden));
    map.resize();
  });
  on("panel-select", "change", () => showPanel(val("panel-select")));
  on("draw-mode", "change", () => {
    draft = [];
    editing = null;
    refreshDraft();
  });
  on("add-center", "click", () => addPoint(centerPoint()));
  on("crosshair", "click", () => addPoint(centerPoint()));
  on("undo", "click", () => {
    draft.pop();
    refreshDraft();
  });
  on("cancel-drawing", "click", () => {
    draft = [];
    editing = null;
    refreshDraft();
  });
  on("save-drawing", "click", () => {
    const mode = val("draw-mode");
    if (
      mode === "browse" ||
      draft.length < (mode === "Polygon" ? 3 : mode === "LineString" ? 2 : 1)
    )
      throw Error("Add enough vertices before saving.");
    const f = drawFeature();
    f.properties = {
      ...f.properties,
      name:
        val("draw-name").trim() ||
        `${mode === "Point" ? "Waypoint" : mode === "Polygon" ? "Area" : "Route"} ${state.features.length + 1}`,
      color: val("draw-color"),
      symbol: val("draw-symbol"),
      heightReference: "Unspecified",
    };
    if (editing) {
      const old = state.features.find((x) => x.id === editing);
      f.id = editing;
      f.properties = { ...old.properties, ...f.properties, samples: [] };
      const replacement = state.features.map((x) => (x.id === editing ? f : x));
      state.features = C.validateFeatures(collection(replacement));
      renderFeatures();
      renderList();
    } else addFeatures([f]);
    draft = [];
    editing = null;
    refreshDraft();
    say("Landmark saved on this device.");
  });
  on("go-coordinate", "click", () => {
    const p = C.parsePosition(
      val("entry-coord"),
      val("entry-format"),
      config,
      bounded("entry-zone", 1, 60),
      checked("entry-south"),
    );
    map.easeTo({ center: p, zoom: Math.max(map.getZoom(), 14) });
    say("Map centered on the entered coordinates.");
  });
  on("search", "input", renderList);
  on("folder-filter", "change", renderList);
  on("save-edit", "click", () => {
    const f = selectedFeature();
    if (!f) return;
    for (const key of ["name", "folder", "description", "color", "symbol"])
      f.properties[key] = val(`edit-${key}`);
    f.properties.visible = checked("edit-visible");
    renderFeatures();
    renderList();
    select(f.id);
    persist();
    say("Landmark details saved.");
  });
  on("zoom-selected", "click", () => {
    if (selectedFeature()) zoomFeature(selectedFeature());
  });
  on("delete-selected", "click", () => {
    const f = selectedFeature();
    if (!f) return;
    deleted = structuredClone(f);
    state.features = state.features.filter((x) => x.id !== selected);
    if (nav === selected) {
      nav = null;
      setGeo("navigation", []);
    }
    selected = null;
    $("editor").hidden = true;
    renderFeatures();
    renderList();
    persist();
    say("Landmark deleted. Restore last deletion is available.");
  });
  on("restore-delete", "click", () => {
    if (!deleted) throw Error("No deletion to restore in this session.");
    addFeatures([deleted]);
    deleted = null;
    say("Landmark restored.");
  });
  on("edit-vertices", "click", () => {
    const f = selectedFeature();
    if (!f) return;
    if (
      f.geometry.type === "MultiLineString" ||
      (f.geometry.type === "Polygon" && f.geometry.coordinates.length > 1)
    )
      throw Error(
        "Edit segmented tracks or areas with holes in a GIS editor to preserve their topology.",
      );
    editing = f.id;
    draft = structuredClone(
      f.geometry.type === "Point"
        ? [f.geometry.coordinates]
        : f.geometry.type === "Polygon"
          ? f.geometry.coordinates[0].slice(0, -1)
          : f.geometry.coordinates,
    );
    $("draw-mode").value = f.geometry.type;
    $("draw-name").value = f.properties.name;
    $("draw-color").value = f.properties.color;
    $("draw-symbol").value = f.properties.symbol;
    showPanel("draw");
    refreshDraft();
    say("Drag orange vertices or add points. Save landmark to apply.");
  });
  on("import-files", "change", async () => {
    let incoming = [];
    for (const f of $("import-files").files) {
      const features = await IO.importLandmarks(f);
      incoming.push(...features);
    }
    addFeatures(incoming);
    if (incoming.length) zoomFeature(incoming[0]);
    $("import-files").value = "";
    say(`Imported ${incoming.length} landmarks.`);
  });
  on("export", "click", () => {
    const format = val("export-format");
    downloadBlob(
      IO.exported(exportSelection(), format),
      `fss-landmarks.${format}`,
    );
    say(
      "Export prepared. GPX represents area outlines as tracks; CSV exports vertices.",
    );
  });
  on("share", "click", async () => {
    const format = val("export-format"),
      blob = IO.exported(exportSelection(), format),
      file = new File([blob], `fss-landmarks.${format}`, { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "FSS landmarks" });
    } else {
      downloadBlob(blob, file.name);
      say(
        "Device file sharing is unavailable; use the downloaded file in your messaging app.",
      );
    }
  });
  on("backup", "click", () =>
    downloadBlob(
      new Blob(
        [
          JSON.stringify(
            {
              type: "FSSProject",
              version: 1,
              landmarks: collection(state.features),
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
      "fss-project.json",
    ),
  );
  on("profile-open", "click", drawProfile);
  on("profile-x", "change", drawProfile);
  on("profile-y", "change", drawProfile);
  on("profile-y2", "change", drawProfile);
  on("profile-index", "input", () =>
    profileSample(Number(val("profile-index"))),
  );
  on("profile-close", "click", () => {
    $("profile-panel").hidden = true;
    profileMarker?.remove();
    profileMarker = null;
  });
  on("profile-canvas", "pointermove", (e) => {
    if (!profileData) return;
    const rect = $("profile-canvas").getBoundingClientRect();
    const rows = profileData.rows,
      key = val("profile-x"),
      values = rows.map((r) => r[key]).filter(C.finite);
    if (!values.length) return;
    const min = Math.min(...values),
      max = Math.max(...values),
      fraction = Math.max(
        0,
        Math.min(1, (((e.clientX - rect.left) / rect.width) * 900 - 65) / 770),
      ),
      target = min + fraction * (max - min);
    let i = 0,
      best = Infinity;
    rows.forEach((r, j) => {
      if (C.finite(r[key]) && Math.abs(r[key] - target) < best) {
        best = Math.abs(r[key] - target);
        i = j;
      }
    });
    $("profile-index").value = i;
    profileSample(i);
  });
  on("gps-start", "click", startGps);
  on("gps-stop", "click", stopGps);
  on("mark-own", "click", () => {
    const s = freshOwn();
    addFeatures([
      C.feature("Point", s.p, `GPS point ${state.features.length + 1}`, {
        samples: [s],
        heightReference: "WGS84 ellipsoid",
      }),
    ]);
    say("Own position and reported height saved.");
  });
  on("record-start", "click", () => {
    if (record)
      throw Error("Finish the existing recording before starting another.");
    startGps();
    record = {
      name: `Track ${new Date().toISOString().slice(0, 19)}`,
      segments: [],
      paused: false,
      newSegment: true,
    };
    recordView();
    persist();
  });
  on("record-pause", "click", () => {
    if (!record) throw Error("Start recording first.");
    if (record.paused) startGps();
    record.paused = !record.paused;
    record.newSegment = true;
    recordView();
    persist();
  });
  on("record-stop", "click", finishRecord);
  on("nav-selected", "click", () => {
    if (!selectedFeature()) return;
    if (selectedFeature().geometry.type === "Polygon")
      throw Error("Choose a waypoint or track for navigation.");
    $("nav-target").value = selected;
    showPanel("gps");
  });
  on("nav-start", "click", () => {
    freshOwn();
    bounded("proximity", 1, 1000);
    bounded("off-path", 5, 1000);
    const f = state.features.find((x) => x.id === val("nav-target"));
    if (!f) throw Error("Choose a waypoint or path.");
    if (C.segments(f).flat().length > 5000)
      throw Error(
        "Navigation supports paths up to 5,000 vertices; split this track into smaller paths.",
      );
    nav = f.id;
    lastNavTime = null;
    navAlertAt = 0;
    navigate();
  });
  on("nav-stop", "click", () => {
    nav = null;
    setGeo("navigation", []);
    set("nav-readout", "Navigation stopped.");
  });
  on("audio-alerts", "change", async () => {
    if (checked("audio-alerts")) {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (Audio) {
        audioContext = audioContext || new Audio();
        await audioContext.resume();
      }
    }
  });
  on("enable-compass", "click", async () => {
    if (!window.DeviceOrientationEvent)
      throw Error(
        "Device orientation is unavailable. GPS course up works while moving.",
      );
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const permission = await DeviceOrientationEvent.requestPermission(true);
      if (permission !== "granted") throw Error("Compass permission denied.");
    }
    if (!compassStarted) {
      window.addEventListener("deviceorientationabsolute", orientationEvent);
      window.addEventListener("deviceorientation", orientationEvent);
      compassStarted = true;
    }
    say(
      "Compass enabled if the device provides absolute heading; allow sensor access.",
    );
  });
  on("orientation", "change", () => {
    if (val("orientation") === "north") map.setBearing(0);
    if (val("orientation") === "compass" && heading === null)
      say("Enable device compass and wait for an absolute heading.", true);
  });
  on("perspective", "change", () =>
    map.setPitch(checked("perspective") ? 60 : 0),
  );
  on("apply-basemap", "click", applyBasemap);
  on("map-opacity", "input", () => {
    if (map.getLayer("basemap"))
      map.setPaintProperty(
        "basemap",
        "raster-opacity",
        Number(val("map-opacity")),
      );
    persist();
  });
  on("mbtiles-file", "change", async () => {
    const file = $("mbtiles-file").files[0];
    if (!file) return;
    if (file.size > 150 * 1048576) throw Error("MBTiles limit: 150 MB.");
    const buffer = await file.arrayBuffer(),
      next = await IO.openMbtiles(buffer);
    try {
      await dbOp("put", "atlas", { name: file.name, buffer });
    } catch (e) {
      next.close();
      throw e;
    }
    atlas?.close();
    atlas = next;
    map.setZoom(Math.max(atlas.min, Math.min(atlas.max, map.getZoom())));
    set(
      "atlas-info",
      `${file.name}\n${atlas.count} tiles · zoom ${atlas.min}–${atlas.max}`,
    );
    $("basemap").value = "mbtiles";
    applyBasemap();
    const bounds = atlas.info.bounds?.split(",").map(Number);
    if (bounds?.length === 4 && bounds.every(C.finite))
      map.fitBounds(
        [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[3]],
        ],
        { padding: 20 },
      );
  });
  on("clear-atlas", "click", async () => {
    await dbOp("delete", "atlas");
    if (val("basemap") === "mbtiles") {
      $("basemap").value = "blank";
      applyBasemap();
    }
    atlas?.close();
    atlas = null;
    set("atlas-info", "No offline atlas loaded.");
    say("Stored atlas removed. Import the original MBTiles to restore it.");
  });
  on("select-area", "click", () => {
    const b = map.getBounds();
    areaBounds = [
      Math.max(-180, b.getWest()),
      Math.max(-85, b.getSouth()),
      Math.min(180, b.getEast()),
      Math.min(85, b.getNorth()),
    ];
    set(
      "area-bounds",
      `W ${areaBounds[0].toFixed(5)} · S ${areaBounds[1].toFixed(5)}\nE ${areaBounds[2].toFixed(5)} · N ${areaBounds[3].toFixed(5)}`,
    );
  });
  on("estimate-tiles", "click", () => {
    const tiles = offlinePlan();
    set(
      "download-estimate",
      `${tiles.length} tiles · approximately ${((tiles.length * 40) / 1024).toFixed(1)} MB at 40 KB/tile (actual size varies)`,
    );
  });
  on("download-tiles", "click", downloadArea);
  on("cancel-download", "click", () => downloadController?.abort());
  on("clear-tiles", "click", async () => {
    if (downloadBusy) throw Error("Cancel the active download first.");
    await dbOp("delete", "downloaded");
    downloaded = null;
    if (val("basemap") === "cache") {
      $("basemap").value = "blank";
      applyBasemap();
    }
    set("download-state", "Downloaded area removed.");
  });
  on("hgt-files", "change", async () => {
    const files = [...$("hgt-files").files];
    if (files.length > 4) throw Error("Import up to four HGT tiles at a time.");
    const entries = [];
    for (const f of files) {
      if (![2884802, 25934402].includes(f.size))
        throw Error(`Invalid HGT file size: ${f.name}`);
      const buffer = await f.arrayBuffer();
      new C.Hgt(f.name, buffer);
      entries.push({ name: f.name, buffer });
    }
    if (!entries.length) return;
    await dbOp("put", "hgt", entries);
    hgts = entries.map((e) => new C.Hgt(e.name, e.buffer));
    set("hgt-list", hgts.map((h) => h.name).join("\n"));
    $("terrain-source").value = "hgt";
    map.easeTo({ center: [hgts[0].west + 0.5, hgts[0].south + 0.5], zoom: 10 });
    applyTerrain();
  });
  on("apply-terrain", "click", applyTerrain);
  on("clear-dem", "click", async () => {
    $("terrain-source").value = "none";
    $("terrain-colors").checked = false;
    $("slope-layer").checked = false;
    applyTerrain();
    await dbOp("delete", "hgt");
    const keys = await dbOp("keys");
    for (const key of keys)
      if (String(key).startsWith("dem:")) await dbOp("delete", key);
    hgts = [];
    onlineElevation.clear();
    set("hgt-list", "Stored elevation data cleared.");
    say(
      "Elevation cache cleared. Reimport valid HGT files or enable online terrain to reload.",
    );
  });
  for (const id of settingsIds)
    on(id, "change", () => {
      updateCenter();
      updateGrid();
      renderFeatures();
      if (selectedFeature()) set("selected-stats", stats(selectedFeature()));
      scale.setUnit(val("distance-unit"));
      persist();
    });
  on("persist-storage", "click", async () => {
    const granted = await navigator.storage?.persist?.();
    const estimate = await navigator.storage?.estimate?.();
    set(
      "storage-info",
      `${granted ? "Persistent storage granted" : "Browser did not grant persistent storage"}${estimate ? `\nUsed ${(estimate.usage / 1048576).toFixed(1)} MB of ${(estimate.quota / 1048576).toFixed(0)} MB` : ""}. Keep exported backups.`,
    );
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && record) {
      record.paused = true;
      record.newSegment = true;
      record.reason =
        "Page hidden: recording paused. Resume when back in the field map.";
      recordView();
      persist();
    }
  });
  window.addEventListener("pagehide", () => {
    if (record) {
      record.paused = true;
      record.newSegment = true;
    }
    persistNow();
    if (watch !== null) navigator.geolocation.clearWatch(watch);
    clearInterval(gpsTimer);
    downloadController?.abort();
    window.removeEventListener("deviceorientation", orientationEvent);
    window.removeEventListener("deviceorientationabsolute", orientationEvent);
  });
  if (innerWidth < 760) {
    $("tools").classList.add("collapsed");
    $("toggle-tools").setAttribute("aria-expanded", "false");
  }
})().catch((e) => {
  const box = document.getElementById("message");
  box.textContent = `Map could not start: ${e.message}. Reload, or check browser storage / WebGL support.`;
  box.classList.add("error");
});
