/* Standard interchange formats and bounded, local raster imports. */
(function (root) {
  "use strict";
  const C = root.FSS,
    MAX_FILE = 40 * 1024 * 1024;
  const escape = (x) =>
    String(x ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[c],
    );
  const children = (e, name) =>
    Array.from(e.children || []).filter((c) => c.localName === name);
  const descendants = (e, name) =>
    Array.from(e.getElementsByTagNameNS("*", name));
  const text = (e, name) => children(e, name)[0]?.textContent?.trim() || "";
  const number = (s) =>
    s !== "" && Number.isFinite(Number(s)) ? Number(s) : null;
  const fc = (features) => ({ type: "FeatureCollection", features });
  function xml(source) {
    if (/<!DOCTYPE|<!ENTITY/i.test(source))
      throw Error("XML entities and document types are not supported.");
    const doc = new DOMParser().parseFromString(source, "application/xml");
    if (doc.querySelector("parsererror")) throw Error("Malformed XML.");
    return doc;
  }
  function csvRows(source) {
    const rows = [];
    let row = [],
      cell = "",
      quoted = false;
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (c === '"') {
        if (quoted && source[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = !quoted;
      } else if (c === "," && !quoted) {
        row.push(cell);
        cell = "";
      } else if ((c === "\n" || c === "\r") && !quoted) {
        if (c === "\r" && source[i + 1] === "\n") i++;
        row.push(cell);
        if (row.some((x) => x !== "")) rows.push(row);
        row = [];
        cell = "";
      } else cell += c;
    }
    if (quoted) throw Error("Unterminated CSV quote.");
    row.push(cell);
    if (row.some((x) => x !== "")) rows.push(row);
    return rows;
  }
  function importCsv(source) {
    const rows = csvRows(source);
    if (rows.length < 2)
      throw Error("CSV needs a header and at least one point.");
    const heads = rows.shift().map((x) => x.trim().toLowerCase());
    const get = (r, ...names) => {
      const i = heads.findIndex((x) => names.includes(x));
      return i < 0 ? "" : (r[i] ?? "");
    };
    return rows.map((r, i) => {
      const lon = number(get(r, "lon", "longitude")),
        lat = number(get(r, "lat", "latitude"));
      const h = number(get(r, "height", "altitude_ellipsoid_m", "elevation"));
      const p = C.coord([lon, lat, ...(h === null ? [] : [h])]);
      return C.feature(
        "Point",
        p,
        get(r, "name", "point_name", "point_id") || `Point ${i + 1}`,
        {
          folder: get(r, "folder") || "Imported",
          description: get(r, "description"),
          heightReference:
            get(r, "height_reference", "heightreference") || "Unspecified",
          samples: [
            {
              time: Date.parse(get(r, "time", "utc_time")) || null,
              accuracy: number(get(r, "accuracy", "horizontal_sigma_m")),
              verticalAccuracy: number(
                get(r, "vertical_accuracy", "height_sigma_m"),
              ),
            },
          ],
        },
      );
    });
  }
  function importGpx(doc) {
    const out = [];
    const point = (e) => {
      const lon = number(e.getAttribute("lon") || ""),
        lat = number(e.getAttribute("lat") || "");
      const h = number(text(e, "ele"));
      return C.coord([lon, lat, ...(h === null ? [] : [h])]);
    };
    const sample = (e) => ({
      time: Number.isFinite(Date.parse(text(e, "time")))
        ? Date.parse(text(e, "time"))
        : null,
      accuracy: number(descendants(e, "accuracy")[0]?.textContent || ""),
      verticalAccuracy: number(
        descendants(e, "verticalAccuracy")[0]?.textContent || "",
      ),
      speed: number(text(e, "speed")),
    });
    for (const e of descendants(doc, "wpt"))
      out.push(
        C.feature("Point", point(e), text(e, "name") || "Waypoint", {
          description: text(e, "desc"),
          samples: [sample(e)],
          heightReference:
            descendants(e, "heightReference")[0]?.textContent ||
            "GPX elevation (source datum unspecified)",
        }),
      );
    for (const e of [...descendants(doc, "trk"), ...descendants(doc, "rte")]) {
      const lines = [],
        samples = [];
      const groups = e.localName === "trk" ? children(e, "trkseg") : [e];
      for (const s of groups) {
        const nodes = children(s, e.localName === "trk" ? "trkpt" : "rtept");
        if (nodes.length === 1)
          out.push(
            C.feature(
              "Point",
              point(nodes[0]),
              `${text(e, "name") || "Track"} · isolated fix`,
              { samples: [sample(nodes[0])] },
            ),
          );
        if (nodes.length >= 2) {
          lines.push(nodes.map(point));
          samples.push(...nodes.map(sample));
        }
      }
      if (lines.length)
        out.push(
          C.feature(
            lines.length === 1 ? "LineString" : "MultiLineString",
            lines.length === 1 ? lines[0] : lines,
            text(e, "name") || "Track",
            {
              description: text(e, "desc"),
              samples,
              heightReference:
                descendants(e, "heightReference")[0]?.textContent ||
                "GPX elevation (source datum unspecified)",
            },
          ),
        );
    }
    return out;
  }
  function importKml(doc) {
    const out = [];
    const coordinates = (e) =>
      text(e, "coordinates")
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => {
          const v = t.split(",");
          return C.coord([
            number(v[0] || ""),
            number(v[1] || ""),
            ...(v[2] !== undefined ? [number(v[2])] : []),
          ]);
        });
    for (const p of descendants(doc, "Placemark")) {
      let meta = {};
      const data = descendants(p, "Data").find(
        (d) => d.getAttribute("name") === "fss",
      );
      if (data) {
        try {
          meta = JSON.parse(text(data, "value"));
        } catch {
          throw Error("Invalid FSS metadata in KML.");
        }
      }
      const props = {
        ...meta,
        description: text(p, "description") || meta.description || "",
        heightReference:
          meta.heightReference || "KML elevation (source datum unspecified)",
      };
      const name = text(p, "name") || "Landmark";
      for (const e of descendants(p, "Point")) {
        const c = coordinates(e);
        if (c.length !== 1) throw Error("KML Point needs one coordinate.");
        out.push(C.feature("Point", c[0], name, props));
      }
      const lines = descendants(p, "LineString").map(coordinates);
      if (lines.length)
        out.push(
          C.feature(
            lines.length === 1 ? "LineString" : "MultiLineString",
            lines.length === 1 ? lines[0] : lines,
            name,
            props,
          ),
        );
      for (const e of descendants(p, "Polygon")) {
        const rings = [
          ...children(e, "outerBoundaryIs"),
          ...children(e, "innerBoundaryIs"),
        ].map((b) => coordinates(descendants(b, "LinearRing")[0] || b));
        out.push(C.feature("Polygon", rings, name, props));
      }
    }
    return out;
  }
  async function unzipKml(bytes) {
    let total = 0;
    const files = fflate.unzipSync(bytes, {
      filter: (f) => {
        if (/\.kml$/i.test(f.name)) {
          total += f.originalSize;
          if (total > MAX_FILE) throw Error("Expanded KML exceeds 40 MB.");
          return true;
        }
        return false;
      },
    });
    const entries = Object.entries(files).filter(([name]) =>
      /\.kml$/i.test(name),
    );
    if (!entries.length) throw Error("KMZ does not contain KML.");
    const primary =
      entries.find(([name]) => name.toLowerCase() === "doc.kml") || entries[0];
    return new TextDecoder().decode(primary[1]);
  }
  async function importLandmarks(file) {
    if (file.size > MAX_FILE) throw Error("Landmark file limit is 40 MB.");
    const ext = file.name.split(".").pop().toLowerCase();
    let data;
    if (ext === "kmz")
      data = importKml(
        xml(await unzipKml(new Uint8Array(await file.arrayBuffer()))),
      );
    else {
      const source = await file.text();
      if (["geojson", "json"].includes(ext)) {
        const obj = JSON.parse(source);
        data = obj.type === "FSSProject" ? obj.landmarks : obj;
        return C.validateFeatures(data);
      }
      if (ext === "gpx") data = importGpx(xml(source));
      else if (ext === "kml") data = importKml(xml(source));
      else if (ext === "csv") data = importCsv(source);
      else throw Error("Use GPX, KML, KMZ, GeoJSON or CSV.");
    }
    if (!data.length) throw Error("No supported landmarks found.");
    return C.validateFeatures(fc(data));
  }
  function toGpx(features) {
    let body = "";
    const point = (tag, p, s = {}, info = "", reference = "") =>
      `<${tag} lat="${p[1]}" lon="${p[0]}">${C.finite(p[2]) ? `<ele>${p[2]}</ele>` : ""}${C.finite(s.time) ? `<time>${new Date(s.time).toISOString()}</time>` : ""}${info}<extensions>${C.finite(s.accuracy) ? `<fss:accuracy>${s.accuracy}</fss:accuracy>` : ""}${C.finite(s.verticalAccuracy) ? `<fss:verticalAccuracy>${s.verticalAccuracy}</fss:verticalAccuracy>` : ""}${reference ? `<fss:heightReference>${escape(reference)}</fss:heightReference>` : ""}</extensions></${tag}>`;
    for (const f of [...features].sort(
      (a, b) =>
        Number(b.geometry.type === "Point") -
        Number(a.geometry.type === "Point"),
    )) {
      const p = f.properties,
        info = `<name>${escape(p.name)}</name><desc>${escape(p.description)}</desc>`;
      if (f.geometry.type === "Point")
        body += point(
          "wpt",
          f.geometry.coordinates,
          p.samples?.[0],
          info,
          p.heightReference,
        );
      else {
        let index = 0;
        const segs = C.segments(f)
          .map(
            (s) =>
              `<trkseg>${s.map((c) => point("trkpt", c, p.samples?.[index++])).join("")}</trkseg>`,
          )
          .join("");
        body += `<trk>${info}<extensions><fss:heightReference>${escape(p.heightReference)}</fss:heightReference></extensions>${segs}</trk>`;
      }
    }
    return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="FSS Survey Calculator" xmlns="http://www.topografix.com/GPX/1/1" xmlns:fss="https://github.com/moorthimms/FSS-survey-calculator">${body}</gpx>`;
  }
  function toKml(features) {
    const coords = (c) => c.map((p) => p.join(",")).join(" "),
      line = (s) =>
        `<LineString><altitudeMode>clampToGround</altitudeMode><coordinates>${coords(s)}</coordinates></LineString>`;
    const body = features
      .map((f) => {
        const g = f.geometry,
          p = f.properties;
        let geom;
        if (g.type === "Point")
          geom = `<Point><coordinates>${g.coordinates.join(",")}</coordinates></Point>`;
        else if (g.type === "Polygon")
          geom = `<Polygon>${g.coordinates.map((r, i) => `<${i ? "inner" : "outer"}BoundaryIs><LinearRing><coordinates>${coords(r)}</coordinates></LinearRing></${i ? "inner" : "outer"}BoundaryIs>`).join("")}</Polygon>`;
        else
          geom =
            g.type === "LineString"
              ? line(g.coordinates)
              : `<MultiGeometry>${g.coordinates.map(line).join("")}</MultiGeometry>`;
        return `<Placemark><name>${escape(p.name)}</name><description>${escape(p.description)}</description><ExtendedData><Data name="fss"><value>${escape(JSON.stringify(p))}</value></Data></ExtendedData>${geom}</Placemark>`;
      })
      .join("");
    return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${body}</Document></kml>`;
  }
  function toCsv(features) {
    const cell = (x) =>
      '"' +
      String(x ?? "")
        .replace(/^[=+@]/, "'$&")
        .replace(/"/g, '""') +
      '"';
    const rows = [
      [
        "name",
        "geometry",
        "segment",
        "vertex",
        "latitude",
        "longitude",
        "height",
        "height_reference",
        "time",
        "accuracy",
        "vertical_accuracy",
        "folder",
        "description",
      ],
    ];
    for (const f of features) {
      let index = 0;
      const lines =
        f.geometry.type === "Point"
          ? [[f.geometry.coordinates]]
          : C.segments(f);
      lines.forEach((s, j) =>
        s.forEach((p, i) => {
          const a = f.properties.samples?.[index++] || {};
          rows.push([
            f.properties.name,
            f.geometry.type,
            j,
            i,
            p[1],
            p[0],
            p[2],
            f.properties.heightReference,
            C.finite(a.time) ? new Date(a.time).toISOString() : "",
            a.accuracy,
            a.verticalAccuracy,
            f.properties.folder,
            f.properties.description,
          ]);
        }),
      );
    }
    return rows.map((r) => r.map(cell).join(",")).join("\r\n");
  }
  function exported(features, format) {
    if (format === "geojson")
      return new Blob([JSON.stringify(fc(features), null, 2)], {
        type: "application/geo+json",
      });
    if (format === "gpx")
      return new Blob([toGpx(features)], { type: "application/gpx+xml" });
    if (format === "kml")
      return new Blob([toKml(features)], {
        type: "application/vnd.google-earth.kml+xml",
      });
    if (format === "kmz")
      return new Blob(
        [
          fflate.zipSync({
            "doc.kml": new TextEncoder().encode(toKml(features)),
          }),
        ],
        { type: "application/vnd.google-earth.kmz" },
      );
    return new Blob([toCsv(features)], { type: "text/csv" });
  }
  async function openMbtiles(buffer) {
    if (buffer.byteLength > 150 * 1024 * 1024)
      throw Error("MBTiles limit is 150 MB per file.");
    const SQL = await initSqlJs();
    const db = new SQL.Database(new Uint8Array(buffer));
    try {
      const meta = db.exec("SELECT name, value FROM metadata");
      const info = Object.fromEntries(meta[0]?.values || []);
      const format = (info.format || "").toLowerCase();
      if (!["png", "jpg", "jpeg", "webp"].includes(format))
        throw Error(
          "Only raster PNG/JPEG/WebP MBTiles are supported. Export a raster MBTiles atlas from MOBAC.",
        );
      const range = db.exec(
        "SELECT MIN(zoom_level), MAX(zoom_level), COUNT(*) FROM tiles",
      )[0]?.values[0];
      if (!range || !range[2] || range[0] < 0 || range[1] > 24)
        throw Error("MBTiles contains no valid tile range.");
      const stmt = db.prepare(
        "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=? LIMIT 1",
      );
      return {
        db,
        info,
        min: range[0],
        max: range[1],
        count: range[2],
        tile(z, x, y) {
          stmt.bind([z, x, 2 ** z - 1 - y]);
          let data = null;
          if (stmt.step()) data = stmt.get()[0];
          stmt.reset();
          return data;
        },
        close() {
          stmt.free();
          db.close();
        },
      };
    } catch (e) {
      db.close();
      throw e;
    }
  }
  root.FSSFiles = {
    importLandmarks,
    toGpx,
    toKml,
    toCsv,
    exported,
    openMbtiles,
    csvRows,
    importCsv,
    importGpx,
    importKml,
  };
})(typeof window === "undefined" ? globalThis : window);
