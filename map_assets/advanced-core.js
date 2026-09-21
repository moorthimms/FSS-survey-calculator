/* GIS operations shared by the browser and regression tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports)
    module.exports = factory(require("./core"), require("./vendor/turf"));
  else root.FSSGIS = factory(root.FSS, root.turf);
})(typeof globalThis !== "undefined" ? globalThis : this, function (C, T) {
  "use strict";
  const palette = [
    "#167c80",
    "#d76638",
    "#7356a8",
    "#43864b",
    "#ca9c2c",
    "#2878b5",
    "#c84979",
    "#74604a",
  ];
  const fc = (features) => ({ type: "FeatureCollection", features });
  function attributes(properties) {
    const out = Object.create(null);
    for (const [k, v] of Object.entries(properties || {}).slice(0, 64)) {
      if (
        [
          "__proto__",
          "constructor",
          "prototype",
          "samples",
          "attributes",
        ].includes(k)
      )
        continue;
      if (
        v === null ||
        typeof v === "boolean" ||
        (typeof v === "number" && Number.isFinite(v)) ||
        typeof v === "string"
      )
        out[k.slice(0, 100)] = typeof v === "string" ? v.slice(0, 2000) : v;
    }
    return out;
  }
  function field(f, key) {
    if (["name", "folder"].includes(key)) return f.properties[key];
    return Object.hasOwn(f.properties.attributes || {}, key)
      ? f.properties.attributes[key]
      : f.properties[key];
  }
  function number(v) {
    return typeof v === "number" && Number.isFinite(v)
      ? v
      : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
        ? Number(v)
        : null;
  }
  function fieldNames(features) {
    return [
      ...new Set(
        features.flatMap((f) =>
          Object.keys(f.properties.attributes || {}).concat(["name", "folder"]),
        ),
      ),
    ].sort();
  }
  function normalize(input, folder) {
    const raw =
      input?.type === "FeatureCollection"
        ? input.features
        : input?.type === "Feature"
          ? [input]
          : [];
    if (!raw.length) throw Error("No vector features found.");
    const flat = [];
    for (const f of raw) {
      if (!f.geometry) continue;
      const add = (g) =>
        flat.push({
          ...f,
          id: C.cryptoId(),
          geometry: g,
          properties: {
            ...f.properties,
            folder: folder || f.properties?.folder,
            attributes: attributes(f.properties?.attributes || f.properties),
          },
        });
      const g = f.geometry;
      if (g.type === "MultiPolygon")
        g.coordinates.forEach((c) => add({ type: "Polygon", coordinates: c }));
      else if (g.type === "MultiPoint")
        g.coordinates.forEach((c) => add({ type: "Point", coordinates: c }));
      else if (g.type === "GeometryCollection")
        throw Error("Explode geometry collections before importing.");
      else add(g);
    }
    return C.validateFeatures(fc(flat));
  }
  function styleFeatures(features, style = {}) {
    const categories = [
      ...new Set(
        features.map((f) => String(field(f, style.field) ?? "(missing)")),
      ),
    ].sort();
    const nums = features
      .map((f) => number(field(f, style.field)))
      .filter((v) => v !== null);
    const min = Math.min(...nums),
      max = Math.max(...nums);
    return features.map((f) => {
      const q = { ...f, properties: { ...f.properties } },
        p = q.properties;
      p.color = style.color || p.color;
      p._radius = Number(style.size) || 6;
      p._width = Number(style.width) || 3;
      p._opacity = Number.isFinite(style.opacity) ? style.opacity : 1;
      if (style.mode === "categorized")
        p.color =
          palette[
            categories.indexOf(String(field(f, style.field) ?? "(missing)")) %
              palette.length
          ];
      if (style.mode === "graduated") {
        const v = number(field(f, style.field)),
          t = v === null ? null : max === min ? 0.5 : (v - min) / (max - min);
        p.color =
          t === null
            ? "#999999"
            : ["#e0f3db", "#a8ddb5", "#43a2ca", "#0868ac", "#084081"][
                Math.min(4, Math.floor(t * 5))
              ];
        if (t !== null) p._radius = 4 + t * 12;
      }
      p._label = String(field(f, style.labelField || "name") ?? "").slice(
        0,
        160,
      );
      return q;
    });
  }
  function labelLayout(
    candidates,
    { margin = 6, deduplicate = true, distance = 120 } = {},
  ) {
    const accepted = [];
    for (const c of candidates) {
      if (!c.text) continue;
      const b = {
        left: c.x - margin,
        top: c.y - 10 - margin,
        right: c.x + c.width + margin,
        bottom: c.y + 10 + margin,
      };
      if (
        accepted.some(
          (a) =>
            !(
              b.right < a.box.left ||
              b.left > a.box.right ||
              b.bottom < a.box.top ||
              b.top > a.box.bottom
            ),
        )
      )
        continue;
      if (
        deduplicate &&
        accepted.some(
          (a) =>
            a.text === c.text && Math.hypot(a.x - c.x, a.y - c.y) < distance,
        )
      )
        continue;
      accepted.push({ ...c, box: b });
    }
    return accepted;
  }
  function configureFields(
    features,
    { fields = [], primaryKey = "", caseMode = "keep" } = {},
  ) {
    const names = fields.length ? fields : fieldNames(features),
      rename = (k) =>
        caseMode === "lower"
          ? k.toLowerCase()
          : caseMode === "upper"
            ? k.toUpperCase()
            : k;
    if (new Set(names.map(rename)).size !== names.length)
      throw Error("Case conversion would create duplicate field names.");
    const keys = new Set();
    return features.map((f) => {
      if (primaryKey) {
        const key = field(f, primaryKey);
        if (key === null || key === undefined || key === "")
          throw Error("Primary key contains missing values.");
        if (keys.has(String(key)))
          throw Error("Primary key contains duplicates.");
        keys.add(String(key));
      }
      const attrs = Object.create(null);
      for (const k of names) attrs[rename(k)] = field(f, k) ?? null;
      return { ...f, properties: { ...f.properties, attributes: attrs } };
    });
  }
  function analyze(operation, features, mask, radius = 100) {
    if (!features.length) throw Error("Choose a non-empty input layer.");
    if (features.length > 500)
      throw Error("Use at most 500 features per browser analysis.");
    let result = [];
    if (operation === "buffer") {
      if (!Number.isFinite(radius) || radius <= 0 || radius > 50000)
        throw Error("Buffer distance must be 0–50,000 metres.");
      result = features
        .map((f) => T.buffer(f, radius, { units: "meters", steps: 24 }))
        .filter(Boolean);
    } else if (operation === "centroid")
      result = features.map((f) =>
        T.centroid(f, { properties: { ...f.properties } }),
      );
    else if (operation === "dissolve") {
      if (features.some((f) => f.geometry.type !== "Polygon"))
        throw Error("Dissolve requires polygons.");
      result =
        features.length === 1
          ? features
          : [T.union(fc(features))].filter(Boolean);
    } else {
      if (!mask || mask.geometry.type !== "Polygon")
        throw Error("Choose a polygon mask.");
      for (const f of features) {
        if (operation === "select") {
          if (T.booleanIntersects(f, mask)) result.push(f);
        } else if (operation === "intersection" || operation === "clip") {
          if (f.geometry.type === "Point") {
            if (T.booleanPointInPolygon(f, mask)) result.push(f);
          } else if (f.geometry.type === "Polygon") {
            const q = T.intersect(fc([f, mask]));
            if (q) {
              q.properties = { ...f.properties };
              result.push(q);
            }
          } else
            throw Error(
              "Polygon clip supports points and polygons. Use Select intersecting for lines.",
            );
        } else throw Error("Unknown analysis.");
      }
    }
    if (!result.length) return [];
    return normalize(fc(result), `${operation} result`);
  }
  function scaleAt(map, method = "center", width = 100) {
    if (
      (map.getPitch?.() || 0) !== 0 ||
      (map.getProjection?.()?.type || "mercator") !== "mercator"
    )
      return null;
    const canvas = map.getCanvas(),
      w = canvas.clientWidth,
      h = canvas.clientHeight;
    if (!w || !h) return null;
    const row = (y) => {
      const a = map.unproject([w / 2 - width / 2, y]),
        b = map.unproject([w / 2 + width / 2, y]);
      return C.inverse([a.lng, a.lat], [b.lng, b.lat]).distance;
    };
    if (method === "equator")
      return (width * 40075016.68557849) / (512 * 2 ** map.getZoom());
    if (method === "average") return (row(0) + row(h / 2) + row(h)) / 3;
    return row(method === "top" ? 0 : method === "bottom" ? h : h / 2);
  }
  function wmsURL(raw, layers) {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password)
      throw Error("Use HTTPS without embedded credentials.");
    if (!layers.trim())
      throw Error("Enter WMS layer names from GetCapabilities.");
    for (const k of [...u.searchParams.keys()])
      if (
        [
          "service",
          "request",
          "version",
          "layers",
          "styles",
          "format",
          "transparent",
          "srs",
          "crs",
          "bbox",
          "width",
          "height",
        ].includes(k.toLowerCase())
      )
        u.searchParams.delete(k);
    for (const [k, v] of Object.entries({
      SERVICE: "WMS",
      VERSION: "1.1.1",
      REQUEST: "GetMap",
      LAYERS: layers,
      STYLES: "",
      FORMAT: "image/png",
      TRANSPARENT: "true",
      SRS: "EPSG:3857",
      WIDTH: "256",
      HEIGHT: "256",
      BBOX: "{bbox-epsg-3857}",
    }))
      u.searchParams.set(k, v);
    return u.toString().replace("%7Bbbox-epsg-3857%7D", "{bbox-epsg-3857}");
  }
  return {
    palette,
    attributes,
    field,
    fieldNames,
    normalize,
    styleFeatures,
    labelLayout,
    configureFields,
    analyze,
    scaleAt,
    wmsURL,
  };
});
