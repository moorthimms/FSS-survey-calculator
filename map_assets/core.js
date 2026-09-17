/* Pure mapping operations shared by the browser and regression tests. */
(function (root, factory) {
  const api = factory(
    typeof module === "object" && module.exports
      ? require("./vendor/geographiclib.js")
      : root.geodesic,
    typeof module === "object" && module.exports
      ? require("./vendor/proj4.js")
      : root.proj4,
    typeof module === "object" && module.exports
      ? require("./vendor/mgrs.js")
      : root.mgrs,
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FSS = api;
})(
  typeof window === "undefined" ? globalThis : window,
  function (geo, proj4, mgrs) {
    "use strict";
    const geod = geo.Geodesic.WGS84,
      MAX_POINTS = 50000;
    const finite = (x) => typeof x === "number" && Number.isFinite(x);
    const optional = (x) => (finite(x) ? x : null);
    const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
    function coord(p) {
      if (
        !Array.isArray(p) ||
        !finite(p[0]) ||
        !finite(p[1]) ||
        Math.abs(p[0]) > 180 ||
        Math.abs(p[1]) > 90
      )
        throw Error(
          "Coordinates must be finite WGS84 longitude, latitude within ±180°, ±90°.",
        );
      return [p[0], p[1], ...(finite(p[2]) ? [p[2]] : [])];
    }
    function inverse(a, b) {
      coord(a);
      coord(b);
      const r = geod.Inverse(a[1], a[0], b[1], b[0]);
      return { distance: r.s12, bearing: (r.azi1 + 360) % 360 };
    }
    function direct(p, bearing, distance) {
      const r = geod.Direct(p[1], p[0], bearing, distance);
      return [r.lon2, r.lat2];
    }
    function segments(f) {
      const g = f.geometry;
      if (g.type === "LineString") return [g.coordinates];
      if (g.type === "MultiLineString") return g.coordinates;
      if (g.type === "Polygon") return g.coordinates;
      return [];
    }
    function measure(f) {
      let distance = 0,
        area = 0;
      for (const line of segments(f))
        for (let i = 1; i < line.length; i++)
          distance += inverse(line[i - 1], line[i]).distance;
      if (f.geometry.type === "Polygon") {
        f.geometry.coordinates.forEach((ring, i) => {
          const poly = new geo.PolygonArea.PolygonArea(geod, false);
          ring.forEach((p) => poly.AddPoint(p[1], p[0]));
          area += (i ? -1 : 1) * Math.abs(poly.Compute(false, true).area);
        });
      }
      return { distance, area: Math.max(0, area) };
    }
    function validateRing(ring) {
      if (ring.length > 2001)
        throw Error("Area limit: 2,000 boundary vertices per ring.");
      const base = ring[0][0],
        r = ring.map((p) => [base + wrap(p[0] - base), p[1]]);
      const side = (a, b, c) =>
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const within = (a, b, c) =>
        Math.min(a[0], b[0]) <= c[0] &&
        c[0] <= Math.max(a[0], b[0]) &&
        Math.min(a[1], b[1]) <= c[1] &&
        c[1] <= Math.max(a[1], b[1]);
      const unique = new Set(r.slice(0, -1).map((p) => p.join(",")));
      if (unique.size !== r.length - 1 || unique.size < 3)
        throw Error("Area has duplicate or insufficient corners.");
      for (let i = 0; i < r.length - 1; i++)
        for (let j = i + 2; j < r.length - 1; j++) {
          if (i === 0 && j === r.length - 2) continue;
          const a = r[i],
            b = r[i + 1],
            c = r[j],
            d = r[j + 1],
            s1 = side(a, b, c),
            s2 = side(a, b, d),
            s3 = side(c, d, a),
            s4 = side(c, d, b);
          if (
            (s1 * s2 < 0 && s3 * s4 < 0) ||
            (s1 === 0 && within(a, b, c)) ||
            (s2 === 0 && within(a, b, d)) ||
            (s3 === 0 && within(c, d, a)) ||
            (s4 === 0 && within(c, d, b))
          )
            throw Error(
              "Area boundary crosses itself. Reorder or move the corners.",
            );
        }
      if (Math.abs(measure(feature("Polygon", [ring])).area) < 0.000001)
        throw Error("Area corners are collinear or enclose zero area.");
    }
    function validateFeatures(input) {
      const features =
        input.type === "FeatureCollection"
          ? input.features
          : input.type === "Feature"
            ? [input]
            : null;
      if (!Array.isArray(features) || features.length > 2000)
        throw Error(
          "Expected a FeatureCollection with at most 2,000 landmarks.",
        );
      let count = 0;
      return features.map((f) => {
        if (!f || f.type !== "Feature" || !f.geometry)
          throw Error("Invalid landmark geometry.");
        const type = f.geometry.type;
        let c;
        const line = (x, min) => {
          if (!Array.isArray(x) || x.length < min)
            throw Error("Too few vertices.");
          count += x.length;
          if (count > MAX_POINTS)
            throw Error("Project limit: 50,000 vertices.");
          return x.map(coord);
        };
        if (type === "Point") {
          c = coord(f.geometry.coordinates);
          count++;
        } else if (type === "LineString") c = line(f.geometry.coordinates, 2);
        else if (type === "MultiLineString") {
          if (
            !Array.isArray(f.geometry.coordinates) ||
            !f.geometry.coordinates.length
          )
            throw Error("Empty track.");
          c = f.geometry.coordinates.map((x) => line(x, 2));
        } else if (type === "Polygon") {
          if (
            !Array.isArray(f.geometry.coordinates) ||
            !f.geometry.coordinates.length
          )
            throw Error("Empty area.");
          c = f.geometry.coordinates.map((x) => {
            const r = line(x, 4);
            if (r[0][0] !== r.at(-1)[0] || r[0][1] !== r.at(-1)[1])
              throw Error("Area rings must be closed.");
            validateRing(r);
            return r;
          });
        } else
          throw Error(
            `Unsupported geometry: ${type}. Use points, lines, multi-lines or polygons.`,
          );
        if (count > MAX_POINTS) throw Error("Project limit: 50,000 vertices.");
        const p = f.properties || {};
        return {
          type: "Feature",
          id: String(f.id || cryptoId()),
          geometry: { type, coordinates: c },
          properties: {
            name: String(p.name || "Untitled").slice(0, 160),
            folder: String(p.folder || "Imported").slice(0, 100),
            description: String(p.description || "").slice(0, 3000),
            color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : "#167c80",
            symbol: ["pin", "flag", "camp", "survey"].includes(p.symbol)
              ? p.symbol
              : "pin",
            visible: p.visible !== false,
            heightReference: String(p.heightReference || "Unspecified").slice(
              0,
              160,
            ),
            samples: Array.isArray(p.samples)
              ? p.samples.slice(0, MAX_POINTS).map((s) => ({
                  time: optional(s?.time),
                  accuracy: optional(s?.accuracy),
                  verticalAccuracy: optional(s?.verticalAccuracy),
                  speed: optional(s?.speed),
                }))
              : [],
          },
        };
      });
    }
    function cryptoId() {
      return typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2);
    }
    function feature(type, coordinates, name = "Untitled", extra = {}) {
      return {
        type: "Feature",
        id: cryptoId(),
        geometry: { type, coordinates },
        properties: {
          name,
          folder: "Field work",
          color: "#167c80",
          symbol: "pin",
          visible: true,
          ...extra,
        },
      };
    }
    function dms(v, lat) {
      const total = Math.round(Math.abs(v) * 360000);
      const d = Math.floor(total / 360000),
        m = Math.floor((total % 360000) / 6000),
        s = (total % 6000) / 100;
      return `${d}° ${m}′ ${s.toFixed(2)}″ ${lat ? (v < 0 ? "S" : "N") : v < 0 ? "W" : "E"}`;
    }
    function utmZone(p) {
      let z = Math.min(60, Math.floor((p[0] + 180) / 6) + 1);
      if (p[1] >= 56 && p[1] < 64 && p[0] >= 3 && p[0] < 12) z = 32;
      if (p[1] >= 72 && p[1] < 84 && p[0] >= 0 && p[0] < 42)
        z = p[0] < 9 ? 31 : p[0] < 21 ? 33 : p[0] < 33 ? 35 : 37;
      return z;
    }
    function zoneCandidates(p, system, config) {
      coord(p);
      if (system === "Kalianpur")
        return Object.entries(config?.kalianpur || {})
          .filter(
            ([, v]) =>
              p[0] >= v.bounds.lon_min &&
              p[0] <= v.bounds.lon_max &&
              p[1] >= v.bounds.lat_min &&
              p[1] <= v.bounds.lat_max,
          )
          .map(([z]) => z);
      return Object.entries(config?.dsm || {})
        .filter(([, v]) => {
          const latitude = Math.round(v.latitude_of_origin);
          return (
            Math.abs(p[0] - v.longitude_of_origin) <= 4 + 1e-9 &&
            Math.abs(p[1] - latitude) <= 3 + 1e-9
          );
        })
        .map(([z]) => z);
    }
    function autoReferences(p, system, config) {
      const zones = zoneCandidates(p, system, config);
      if (!zones.length)
        return `${system}: outside supplied / verified zone coverage`;
      return (
        zones.map((z) => formatCoord(p, `${system} ${z}`, config)).join(" | ") +
        (zones.length > 1
          ? " · overlapping candidates; confirm map sheet"
          : " · suggested zone")
      );
    }
    function projection(format, p, config) {
      if (format === "DSM Auto" || format === "Kalianpur Auto") {
        const system = format.split(" ")[0],
          zones = zoneCandidates(p, system, config);
        if (zones.length !== 1)
          throw Error(
            `${system}: ${zones.length ? "choose zone: " + zones.join(", ") : "outside supported coverage"}`,
          );
        return projection(`${system} ${zones[0]}`, p, config);
      }
      if (format.startsWith("Kalianpur ")) {
        const zone = format.slice(10),
          v = config?.kalianpur?.[zone];
        if (!v)
          throw Error(
            `${format}: source parameters required; original identifier retained in Zone List.`,
          );
        return { name: `${format} · EPSG:${v.epsg}`, def: v.def };
      }
      if (format === "UTM" || format === "MGRS") {
        if (p[1] < -80 || p[1] > 84)
          throw Error("UTM/MGRS display supports 80°S to 84°N.");
        return {
          name: `UTM ${utmZone(p)}${p[1] < 0 ? "S" : "N"}`,
          def: `+proj=utm +zone=${utmZone(p)} ${p[1] < 0 ? "+south " : ""}+datum=WGS84 +units=m +no_defs`,
        };
      }
      if (format.startsWith("DSM ")) {
        const zone = format.slice(4),
          v = config?.dsm?.[zone];
        if (!v)
          throw Error(
            `DSM ${zone}: source parameters required; original identifier retained in Zone List.`,
          );
        return {
          name: format,
          def: `+proj=lcc +lat_0=${v.latitude_of_origin} +lon_0=${v.longitude_of_origin} +lat_1=${v.standard_parallel_1} +lat_2=${v.standard_parallel_2} +x_0=${v.false_easting_m} +y_0=${v.false_northing_m} +datum=WGS84 +units=m +no_defs`,
        };
      }
      return null;
    }
    function formatCoord(p, format, config) {
      coord(p);
      if (format === "DD") return `${p[1].toFixed(7)}°, ${p[0].toFixed(7)}°`;
      if (format === "DMS") return `${dms(p[1], true)}  ${dms(p[0], false)}`;
      const pr = projection(format, p, config);
      if (format === "MGRS") return mgrs.forward(p, 5);
      if (!pr) throw Error("Unknown coordinate format.");
      const q = proj4("EPSG:4326", pr.def, p.slice(0, 2));
      if (!q.slice(0, 2).every(finite))
        throw Error("Projection unavailable here.");
      return `${pr.name} · E ${q[0].toFixed(3)} · N ${q[1].toFixed(3)} m`;
    }
    function inverseCandidates(text, system, config) {
      const zones = Object.keys(
        system === "DSM" ? config.dsm || {} : config.kalianpur || {},
      );
      const values = text
        .trim()
        .split(/[ ,;]+/)
        .map(Number);
      if (values.length !== 2 || !values.every(finite))
        throw Error("Enter two finite metre coordinates.");
      return zones.flatMap((zone) => {
        try {
          const p = parsePosition(text, `${system} ${zone}`, config);
          return zoneCandidates(p, system, config).includes(zone)
            ? [{ zone, p }]
            : [];
        } catch {
          return [];
        }
      });
    }
    function parsePosition(text, format, config, zone = 43, south = false) {
      if (format.endsWith(" Auto"))
        throw Error(
          "Grid numbers alone need a source zone; select the map sheet zone.",
        );
      if (format === "MGRS") return coord(mgrs.toPoint(text.trim()));
      const v = text
        .trim()
        .split(/[ ,;]+/)
        .map(Number);
      if (v.length !== 2 || !v.every(finite))
        throw Error("Enter two numbers separated by a comma.");
      if (format === "DD") return coord([v[1], v[0]]);
      const pr =
        format === "UTM"
          ? {
              def: `+proj=utm +zone=${zone} ${south ? "+south " : ""}+datum=WGS84 +units=m`,
            }
          : projection(format, [78, 30], config);
      if (!pr)
        throw Error(
          "Use DD, UTM, MGRS, DSM or Kalianpur for coordinate entry.",
        );
      const p = coord(proj4(pr.def, "EPSG:4326", v));
      if (format.startsWith("Kalianpur ")) {
        const b = config.kalianpur[format.slice(10)].bounds,
          tolerance = 1e-7;
        if (
          p[0] < b.lon_min - tolerance ||
          p[0] > b.lon_max + tolerance ||
          p[1] < b.lat_min - tolerance ||
          p[1] > b.lat_max + tolerance
        )
          throw Error(
            "Coordinates fall outside the selected Kalianpur zone; confirm the map sheet.",
          );
      }
      return p;
    }
    function grid(center, bounds, format, config) {
      const out = [];
      const line = (c, label) =>
        out.push(feature("LineString", c, "Grid", { gridLabel: label }));
      if (format === "None") return out;
      const [west, south, east, north] = bounds;
      if (east - west > 180 || Math.abs(center[1]) > 84.8) return out;
      const pr = projection(format, center, config);
      if (!pr) {
        const target = Math.max(east - west, north - south) / 8,
          choices = [
            0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1,
            0.2, 0.5, 1, 2, 5, 10, 20, 30,
          ];
        const step = choices.find((s) => s >= target) || 30;
        for (let x = Math.ceil(west / step) * step; x <= east; x += step)
          line(
            [
              [wrap(x), south],
              [wrap(x), north],
            ],
            `${wrap(x).toFixed(4)}°`,
          );
        for (let y = Math.ceil(south / step) * step; y <= north; y += step)
          line(
            [
              [west, y],
              [east, y],
            ],
            `${y.toFixed(4)}°`,
          );
      } else {
        const corners = [
          [west, south],
          [east, south],
          [west, north],
          [east, north],
        ].map((p) => proj4("EPSG:4326", pr.def, p));
        const xs = corners.map((p) => p[0]),
          ys = corners.map((p) => p[1]);
        if (![...xs, ...ys].every(finite)) return out;
        const xmin = Math.min(...xs),
          xmax = Math.max(...xs),
          ymin = Math.min(...ys),
          ymax = Math.max(...ys);
        const target = Math.max(xmax - xmin, ymax - ymin) / 8;
        const pow = 10 ** Math.floor(Math.log10(target || 1));
        const step = [1, 2, 5, 10].map((n) => n * pow).find((n) => n >= target);
        const unproject = (x, y) => proj4(pr.def, "EPSG:4326", [x, y]);
        for (
          let x = Math.ceil(xmin / step) * step;
          x <= xmax && out.length < 60;
          x += step
        )
          line(
            Array.from({ length: 25 }, (_, i) =>
              unproject(x, ymin + ((ymax - ymin) * i) / 24),
            ),
            `E ${x.toFixed(0)} m`,
          );
        for (
          let y = Math.ceil(ymin / step) * step;
          y <= ymax && out.length < 60;
          y += step
        )
          line(
            Array.from({ length: 25 }, (_, i) =>
              unproject(xmin + ((xmax - xmin) * i) / 24, y),
            ),
            `N ${y.toFixed(0)} m`,
          );
      }
      return out;
    }
    function profile(f) {
      let total = 0,
        index = 0,
        ascent = 0,
        descent = 0;
      const rows = [];
      for (const seg of segments(f)) {
        let prev = null;
        for (const p of seg) {
          const sample = f.properties.samples?.[index++] || {};
          const d = prev ? inverse(prev.p, p).distance : 0;
          total += d;
          let dt =
            prev && finite(sample.time) && finite(prev.sample.time)
              ? (sample.time - prev.sample.time) / 1000
              : null;
          if (!(dt > 0)) dt = null;
          const dz =
            prev && finite(p[2]) && finite(prev.p[2]) ? p[2] - prev.p[2] : null;
          if (dz !== null) {
            ascent += Math.max(dz, 0);
            descent += Math.max(-dz, 0);
          }
          rows.push({
            p,
            segmentStart: prev === null,
            distance: total,
            time: optional(sample.time),
            height: optional(p[2]),
            speed:
              finite(sample.speed) && sample.speed >= 0
                ? sample.speed
                : dt
                  ? d / dt
                  : null,
            incline: dz !== null && d > 0 ? (100 * dz) / d : null,
            accuracy: optional(sample.accuracy),
            verticalAccuracy: optional(sample.verticalAccuracy),
          });
          prev = { p, sample };
        }
      }
      return { rows, total, ascent, descent };
    }
    function routeProgress(p, route) {
      let total = 0;
      const candidates = [];
      for (const s of segments(route))
        for (let i = 1; i < s.length; i++) {
          const a = s[i - 1],
            b = s[i],
            ab = inverse(a, b),
            ap = inverse(a, p);
          const angle = ((ap.bearing - ab.bearing) * Math.PI) / 180;
          const along = Math.max(
            0,
            Math.min(
              ab.distance,
              6371008.8 *
                Math.atan2(
                  Math.sin(ap.distance / 6371008.8) * Math.cos(angle),
                  Math.cos(ap.distance / 6371008.8),
                ),
            ),
          );
          const off = inverse(direct(a, ab.bearing, along), p).distance;
          candidates.push({ a, b, ab, start: total, off });
          total += ab.distance;
        }
      let best = null;
      // Refine the eight nearest spherical estimates on the ellipsoid.
      for (const { a, b, ab, start } of candidates
        .sort((x, y) => x.off - y.off)
        .slice(0, 8)) {
        let lo = 0,
          hi = ab.distance;
        for (let k = 0; k < 24; k++) {
          const u = lo + (hi - lo) / 3,
            v = hi - (hi - lo) / 3;
          if (
            inverse(direct(a, ab.bearing, u), p).distance <
            inverse(direct(a, ab.bearing, v), p).distance
          )
            hi = v;
          else lo = u;
        }
        for (const along of [0, (lo + hi) / 2, ab.distance]) {
          const closest = direct(a, ab.bearing, along),
            off = inverse(closest, p).distance;
          if (!best || off < best.off)
            best = {
              off,
              remaining: Math.max(0, total - start - along),
              target: direct(a, ab.bearing, Math.min(ab.distance, along + 30)),
              closest,
            };
        }
      }
      return best;
    }
    function gpsSample(pos, now = Date.now()) {
      const c = pos?.coords,
        t = pos?.timestamp;
      if (
        !c ||
        ![c.longitude, c.latitude, c.accuracy, t].every(finite) ||
        c.accuracy < 0 ||
        Math.abs(now - t) > 15000
      )
        throw Error("Waiting for a fresh, valid GPS fix.");
      const p = coord([
        c.longitude,
        c.latitude,
        ...(finite(c.altitude) ? [c.altitude] : []),
      ]);
      return {
        p,
        time: t,
        accuracy: c.accuracy,
        verticalAccuracy:
          finite(c.altitudeAccuracy) && c.altitudeAccuracy >= 0
            ? c.altitudeAccuracy
            : null,
        speed: finite(c.speed) && c.speed >= 0 ? c.speed : null,
        heading:
          finite(c.heading) && c.heading >= 0 && c.heading < 360
            ? c.heading
            : null,
      };
    }
    function acceptSample(prev, s, settings) {
      if (s.accuracy > settings.maxAccuracy)
        return { accept: false, reason: "Accuracy filter" };
      if (!prev) return { accept: true, gap: false };
      const dt = (s.time - prev.time) / 1000;
      if (dt <= 0 || dt < settings.interval)
        return { accept: false, reason: "Sampling interval" };
      const dist = inverse(prev.p, s.p).distance;
      if (dt > settings.gapSeconds) return { accept: true, gap: true };
      if (dist / dt > settings.maxSpeed)
        return { accept: false, reason: "Speed / jump filter" };
      if (settings.minDistance > 0 && dist < settings.minDistance)
        return { accept: false, reason: "Stationary filter" };
      return { accept: true, gap: false };
    }
    function tileXY(p, z) {
      const n = 2 ** z,
        lat =
          (Math.max(-85.05112878, Math.min(85.05112878, p[1])) * Math.PI) / 180;
      return [
        Math.min(n - 1, Math.max(0, Math.floor(((p[0] + 180) / 360) * n))),
        Math.min(
          n - 1,
          Math.max(
            0,
            Math.floor(((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * n),
          ),
        ),
      ];
    }
    function tilePoint(x, y, z) {
      return [
        (x / 2 ** z) * 360 - 180,
        (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) /
          Math.PI,
      ];
    }
    function tilePlan(bounds, min, max, limit = 500) {
      if (
        !Number.isInteger(min) ||
        !Number.isInteger(max) ||
        min < 0 ||
        max > 18 ||
        max < min
      )
        throw Error("Choose zoom levels 0–18 with maximum ≥ minimum.");
      const [w, s, e, n] = bounds;
      if (w > e || e - w > 180)
        throw Error(
          "Select an area smaller than 180° without crossing the date line.",
        );
      const tiles = [];
      for (let z = min; z <= max; z++) {
        const [x0, y0] = tileXY([w, n], z),
          [x1, y1] = tileXY([e, s], z);
        if (tiles.length + (x1 - x0 + 1) * (y1 - y0 + 1) > limit)
          throw Error(
            `Area exceeds ${limit} tiles; reduce the area or zoom levels.`,
          );
        for (let x = x0; x <= x1; x++)
          for (let y = y0; y <= y1; y++) tiles.push({ z, x, y });
      }
      return tiles;
    }
    function terrariumHeight(p, tile, image) {
      const [z, x, y] = tile,
        n = 2 ** z;
      const [tx, ty] = tileXY(p, z);
      if (tx !== x || ty !== y) return null;
      const phi = (p[1] * Math.PI) / 180;
      const px = Math.max(
        0,
        Math.min(
          image.width - 1,
          (((p[0] + 180) / 360) * n - x) * image.width - 0.5,
        ),
      );
      const py = Math.max(
        0,
        Math.min(
          image.height - 1,
          (((1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2) * n - y) *
            image.height -
            0.5,
        ),
      );
      const ix = Math.floor(px),
        iy = Math.floor(py),
        jx = Math.min(ix + 1, image.width - 1),
        jy = Math.min(iy + 1, image.height - 1);
      const values = [
        [ix, iy],
        [jx, iy],
        [ix, jy],
        [jx, jy],
      ].map(([a, b]) => {
        const i = (b * image.width + a) * 4;
        return image.data[i + 3] === 0
          ? null
          : image.data[i] * 256 +
              image.data[i + 1] +
              image.data[i + 2] / 256 -
              32768;
      });
      if (values.includes(null)) return null;
      const dx = px - ix,
        dy = py - iy;
      return (
        (values[0] * (1 - dx) + values[1] * dx) * (1 - dy) +
        (values[2] * (1 - dx) + values[3] * dx) * dy
      );
    }
    function Hgt(name, buffer) {
      const m = /^([NS])(\d{2})([EW])(\d{3})\.hgt$/i.exec(name);
      const side = Math.sqrt(buffer.byteLength / 2);
      if (!m || ![1201, 3601].includes(side))
        throw Error(
          "HGT needs N30E078.hgt naming and exactly 2,884,802 or 25,934,402 bytes.",
        );
      this.south = Number(m[2]) * (m[1].toUpperCase() === "S" ? -1 : 1);
      this.west = Number(m[4]) * (m[3].toUpperCase() === "W" ? -1 : 1);
      if (
        this.south < -90 ||
        this.south >= 90 ||
        this.west < -180 ||
        this.west >= 180
      )
        throw Error("Invalid HGT origin.");
      this.side = side;
      this.view = new DataView(buffer);
      this.name = name;
    }
    Hgt.prototype.height = function (p) {
      const x = (p[0] - this.west) * (this.side - 1),
        y = (this.south + 1 - p[1]) * (this.side - 1);
      if (x < 0 || y < 0 || x > this.side - 1 || y > this.side - 1) return null;
      const x0 = Math.floor(x),
        y0 = Math.floor(y),
        x1 = Math.min(x0 + 1, this.side - 1),
        y1 = Math.min(y0 + 1, this.side - 1);
      const values = [
        [x0, y0],
        [x1, y0],
        [x0, y1],
        [x1, y1],
      ].map(([a, b]) => this.view.getInt16(2 * (b * this.side + a), false));
      if (values.includes(-32768)) return null;
      const dx = x - x0,
        dy = y - y0;
      return (
        (values[0] * (1 - dx) + values[1] * dx) * (1 - dy) +
        (values[2] * (1 - dx) + values[3] * dx) * dy
      );
    };
    return {
      finite,
      optional,
      coord,
      wrap,
      inverse,
      direct,
      segments,
      measure,
      validateFeatures,
      cryptoId,
      feature,
      dms,
      utmZone,
      zoneCandidates,
      autoReferences,
      projection,
      formatCoord,
      inverseCandidates,
      parsePosition,
      grid,
      profile,
      routeProgress,
      gpsSample,
      acceptSample,
      tileXY,
      tilePoint,
      tilePlan,
      Hgt,
      terrariumHeight,
      MAX_POINTS,
    };
  },
);
