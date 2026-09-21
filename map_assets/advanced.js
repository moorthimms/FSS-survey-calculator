/* Task-oriented cartography workspace. All vector operations stay on-device. */
(function (root) {
  "use strict";
  root.FSSAdvanced = {
    mount(ctx) {
      const {
          map,
          state,
          C,
          IO,
          addFeatures,
          refresh,
          persist,
          say,
          showPanel,
          downloadBlob,
          centerPoint,
        } = ctx,
        G = root.FSSGIS,
        T = root.turf;
      const $ = (id) => document.getElementById(id),
        v = (id) => $(id).value;
      const on = (id, event, fn) =>
        $(id).addEventListener(event, async () => {
          try {
            await fn();
          } catch (e) {
            say(e.message, true);
          }
        });
      const num = (id, min, max) => {
        const x = Number(v(id));
        if (!v(id).trim() || !Number.isFinite(x) || x < min || x > max)
          throw Error(
            `Enter ${min}–${max} for ${$(id).parentElement.textContent.trim()}.`,
          );
        return x;
      };
      state.gis = state.gis || {
        layers: [],
        styles: {},
        labels: { margin: 6, deduplicate: true, distance: 120 },
        scale: "center",
      };
      const model = state.gis;
      model.layers = Array.isArray(model.layers) ? model.layers : [];
      model.styles = Object.assign(Object.create(null), model.styles || {});
      model.labels = model.labels || {};
      let labelMarkers = [],
        labels = [],
        layerIds = [],
        webLayers = [],
        printing = false;
      const selectedFeatures = (folder) =>
        state.features.filter((f) => f.properties.folder === folder);
      function sync() {
        const names = [
          ...new Set(state.features.map((f) => f.properties.folder)),
        ];
        model.layers = model.layers.filter((l) => names.includes(l.name));
        for (const name of names)
          if (!model.layers.some((l) => l.name === name))
            model.layers.unshift({ name, visible: true });
        for (const id of [
          "gis-style-layer",
          "gis-analysis-layer",
          "gis-table-layer",
        ]) {
          const old = v(id);
          $(id).replaceChildren(
            ...model.layers.map((l) => new Option(l.name, l.name)),
          );
          if (model.layers.some((l) => l.name === old)) $(id).value = old;
        }
        const old = v("gis-mask");
        $("gis-mask").replaceChildren(
          new Option("Choose a polygon", ""),
          ...state.features
            .filter((f) => f.geometry.type === "Polygon")
            .map((f) => new Option(f.properties.name, f.id)),
        );
        if (state.features.some((f) => f.id === old)) $("gis-mask").value = old;
        const list = $("gis-layer-list");
        list.replaceChildren();
        for (const [i, l] of model.layers.entries()) {
          const row = document.createElement("div");
          row.className = "gis-layer-row";
          const check = document.createElement("input");
          check.type = "checkbox";
          check.checked = l.visible !== false;
          check.setAttribute("aria-label", `Show ${l.name}`);
          check.onchange = () => {
            l.visible = check.checked;
            refresh();
            persist();
          };
          const name = document.createElement("button");
          name.textContent = `${l.name} (${selectedFeatures(l.name).length})`;
          name.onclick = () => {
            $("gis-style-layer").value = l.name;
            styleForm();
            showPanel("style");
          };
          const move = (text, delta) => {
            const b = document.createElement("button");
            b.textContent = text;
            b.setAttribute(
              "aria-label",
              `${delta < 0 ? "Raise" : "Lower"} ${l.name}`,
            );
            b.disabled = i + delta < 0 || i + delta >= model.layers.length;
            b.onclick = () => {
              [model.layers[i], model.layers[i + delta]] = [
                model.layers[i + delta],
                model.layers[i],
              ];
              refresh();
              persist();
            };
            return b;
          };
          row.append(check, name, move("↑", -1), move("↓", 1));
          list.append(row);
        }
        for (const l of webLayers) {
          const row = document.createElement("div");
          row.className = "gis-layer-row";
          const check = document.createElement("input");
          check.type = "checkbox";
          check.checked = l.visible;
          check.setAttribute("aria-label", `Show ${l.name}`);
          check.onchange = () => {
            l.visible = check.checked;
            map.setLayoutProperty(
              l.id,
              "visibility",
              l.visible ? "visible" : "none",
            );
          };
          const label = document.createElement("span");
          label.textContent = l.name;
          const remove = document.createElement("button");
          remove.textContent = "Remove";
          remove.onclick = () => {
            map.removeLayer(l.id);
            map.removeSource(l.id);
            webLayers = webLayers.filter((x) => x !== l);
            if (l.rasterName)
              model.rasters = (model.rasters || []).filter(
                (r) => r.name !== l.rasterName,
              );
            sync();
            persist();
          };
          row.append(check, label, remove);
          list.append(row);
        }
        if (!model.layers.length && !webLayers.length)
          list.textContent =
            "No data layers yet. Draw or import a feature to begin.";
        updateFields();
        legend();
      }
      function updateFields() {
        for (const id of ["gis-style-field", "gis-label-field"]) {
          const old = v(id);
          $(id).replaceChildren(
            ...G.fieldNames(selectedFeatures(v("gis-style-layer"))).map(
              (k) => new Option(k, k),
            ),
          );
          if ([...$(id).options].some((x) => x.value === old))
            $(id).value = old;
        }
      }
      function styleForm() {
        updateFields();
        const s = model.styles[v("gis-style-layer")] || {};
        for (const [id, key, def] of [
          ["gis-style-mode", "mode", "original"],
          ["gis-style-field", "field", "name"],
          ["gis-color", "color", "#167c80"],
          ["gis-size", "size", 6],
          ["gis-width", "width", 3],
          ["gis-opacity", "opacity", 1],
          ["gis-label-field", "labelField", "name"],
          ["gis-label-min", "labelMin", 0],
          ["gis-label-max", "labelMax", 22],
        ])
          $(id).value = s[key] ?? def;
      }
      function styled() {
        return [...model.layers]
          .reverse()
          .filter((l) => l.visible !== false)
          .flatMap((l) =>
            G.styleFeatures(
              selectedFeatures(l.name).filter(
                (f) => f.properties.visible !== false,
              ),
              model.styles[l.name] || {},
            ),
          );
      }
      function drawLayers(features) {
        for (const id of layerIds) if (map.getLayer(id)) map.removeLayer(id);
        layerIds = [];
        // Common source remains available for selecting and exporting. Separate
        // layers make user drawing order apply across geometry types.
        for (const id of [
          "landmarks-fill",
          "landmarks-line",
          "landmarks-points",
        ])
          if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
        [...model.layers].reverse().forEach((l, i) => {
          if (l.visible === false) return;
          const filter = ["==", ["get", "folder"], l.name],
            s = model.styles[l.name] || {};
          const add = (kind, paint, geometry) => {
            const id = `gis-vector-${i}-${kind}`;
            map.addLayer(
              {
                id,
                type: kind,
                source: "landmarks",
                filter: geometry
                  ? ["all", filter, ["==", ["geometry-type"], geometry]]
                  : filter,
                paint,
              },
              "draft-fill",
            );
            layerIds.push(id);
          };
          add(
            "fill",
            {
              "fill-color": ["get", "color"],
              "fill-opacity": ["*", 0.25, ["get", "_opacity"]],
            },
            "Polygon",
          );
          add("line", {
            "line-color": ["get", "color"],
            "line-width": ["get", "_width"],
            "line-opacity": ["get", "_opacity"],
          });
          if (s.mode === "heatmap")
            add(
              "heatmap",
              {
                "heatmap-radius": Math.max(10, (s.size || 6) * 4),
                "heatmap-opacity": s.opacity ?? 1,
                "heatmap-weight": s.field
                  ? [
                      "max",
                      0,
                      ["to-number", ["get", s.field, ["get", "attributes"]], 0],
                    ]
                  : 1,
              },
              "Point",
            );
          else
            add(
              "circle",
              {
                "circle-color": ["get", "color"],
                "circle-radius": ["get", "_radius"],
                "circle-opacity": ["get", "_opacity"],
              },
              "Point",
            );
        });
        updateLabels(features);
        legend();
      }
      function updateLabels(features = styled()) {
        labelMarkers.forEach((m) => m.remove());
        labelMarkers = [];
        labels = [];
        if (!$("show-labels").checked) return;
        const candidates = [];
        for (const f of [...features].reverse()) {
          const s = model.styles[f.properties.folder] || {},
            z = map.getZoom();
          if (z < (s.labelMin ?? 0) || z > (s.labelMax ?? 22)) continue;
          const p =
            f.geometry.type === "Point"
              ? f.geometry.coordinates
              : T.pointOnFeature(f).geometry.coordinates;
          if (!map.getBounds().contains(p)) continue;
          const q = map.project(p),
            text = f.properties._label || f.properties.name;
          if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) continue;
          candidates.push({
            p,
            x: q.x + 10,
            y: q.y,
            text,
            width: Math.min(320, text.length * 7),
            annotation: f.properties.annotation,
          });
        }
        labels = G.labelLayout(candidates, model.labels).slice(0, 250);
        for (const l of labels) {
          const el = document.createElement("div");
          el.className = l.annotation ? "gis-annotation" : "gis-label";
          el.textContent = l.text;
          labelMarkers.push(
            new maplibregl.Marker({
              element: el,
              anchor: "left",
              offset: [10, 0],
            })
              .setLngLat(l.p)
              .addTo(map),
          );
        }
      }
      function legendRows() {
        const rows = [];
        for (const l of model.layers.filter((x) => x.visible !== false)) {
          const s = model.styles[l.name] || {},
            fs = G.styleFeatures(
              selectedFeatures(l.name).filter(
                (f) => f.properties.visible !== false,
              ),
              s,
            ),
            groups = new Map();
          for (const f of fs) {
            const color = f.properties.color,
              raw = G.field(f, s.field);
            const key =
              s.mode === "categorized" ? String(raw ?? "(missing)") : color;
            if (!groups.has(key))
              groups.set(key, {
                color,
                values: [],
                text:
                  s.mode === "categorized"
                    ? key
                    : s.mode === "heatmap"
                      ? "Point density"
                      : l.name,
              });
            if (
              s.mode === "graduated" &&
              raw !== null &&
              raw !== undefined &&
              String(raw).trim() !== "" &&
              Number.isFinite(Number(raw))
            )
              groups.get(key).values.push(Number(raw));
          }
          for (const g of groups.values()) {
            if (s.mode === "graduated")
              g.text = g.values.length
                ? `${s.field}: ${Math.min(...g.values).toPrecision(5)} – ${Math.max(...g.values).toPrecision(5)} (observed)`
                : `${s.field}: missing`;
            rows.push({ color: g.color, text: `${l.name} · ${g.text}` });
          }
        }
        return rows;
      }
      function legend() {
        const box = $("gis-legend");
        box.replaceChildren();
        const rows = legendRows();
        for (const entry of rows) {
          const row = document.createElement("div"),
            swatch = document.createElement("i");
          swatch.style.background = entry.color;
          row.append(swatch, document.createTextNode(entry.text));
          box.append(row);
        }
        if (!rows.length)
          box.textContent = "Import or draw features to build a legend.";
      }
      function scaleReadout() {
        const d = G.scaleAt(map, v("gis-scale-method"));
        $("gis-scale-readout").textContent =
          d === null
            ? "Scale unavailable in globe / tilted view."
            : `100 screen pixels ≈ ${d.toFixed(1)} m · ${$("gis-scale-method").selectedOptions[0].textContent}. Nominal screen scale 1:${Math.round(((d / 100) * 96) / 0.0254)} at 96 CSS dpi.`;
        return d;
      }
      on("tool-draw", "click", () => showPanel("draw"));
      on("tool-style", "click", () => {
        styleForm();
        showPanel("style");
      });
      on("tool-analyze", "click", () => showPanel("analyze"));
      on("tool-print", "click", () => {
        scaleReadout();
        showPanel("print");
      });
      on("gis-terrain-open", "click", () => showPanel("terrain"));
      on("gis-import-open", "click", () => {
        showPanel("landmarks");
        $("import-files").click();
      });
      on("gis-style-layer", "change", styleForm);
      on("gis-style-apply", "click", () => {
        const name = v("gis-style-layer");
        if (!name) throw Error("Create or import a layer first.");
        const labelMin = num("gis-label-min", 0, 22),
          labelMax = num("gis-label-max", 0, 22);
        if (labelMin > labelMax)
          throw Error("Label minimum zoom exceeds maximum.");
        if (
          v("gis-style-mode") === "heatmap" &&
          selectedFeatures(name).some((f) => f.geometry.type !== "Point")
        )
          throw Error("Heatmaps need a point-only layer.");
        const mode = v("gis-style-mode");
        if (
          mode === "graduated" &&
          !selectedFeatures(name).some(
            (f) =>
              G.field(f, v("gis-style-field")) !== null &&
              G.field(f, v("gis-style-field")) !== "" &&
              Number.isFinite(Number(G.field(f, v("gis-style-field")))),
          )
        )
          throw Error("Graduated styling needs a numeric attribute.");
        model.styles[name] = {
          mode,
          field: v("gis-style-field"),
          ...(mode === "original" ? {} : { color: v("gis-color") }),
          size: num("gis-size", 2, 30),
          width: num("gis-width", 1, 12),
          opacity: num("gis-opacity", 0, 1),
          labelField: v("gis-label-field"),
          labelMin,
          labelMax,
        };
        model.labels = {
          margin: num("gis-label-margin", 0, 50),
          deduplicate: $("gis-label-dedupe").checked,
          distance: num("gis-label-distance", 0, 2000),
        };
        refresh();
        persist();
        say("Style and label rules applied.");
      });
      on("gis-annotation-add", "click", () => {
        const name = v("gis-annotation").trim();
        if (!name) throw Error("Enter annotation text.");
        addFeatures([
          C.feature("Point", centerPoint(), name, {
            folder: "Annotations",
            annotation: true,
          }),
        ]);
        say(
          "Annotation placed at the map center. Edit its name or position in Landmarks.",
        );
      });
      on("gis-analyze", "click", () => {
        const mask = state.features.find((f) => f.id === v("gis-mask")),
          op = v("gis-operation");
        if (
          op === "intersection" &&
          selectedFeatures(v("gis-analysis-layer")).some(
            (f) => f.geometry.type !== "Polygon",
          )
        )
          throw Error("Intersection requires polygon inputs.");
        const result = G.analyze(
          op,
          selectedFeatures(v("gis-analysis-layer")),
          mask,
          op === "buffer" ? num("gis-radius", 1, 50000) : 100,
        );
        if (result.length) {
          const folder = `${op} · ${new Date().toISOString()}`;
          result.forEach((f) => (f.properties.folder = folder));
          addFeatures(result);
        }
        $("gis-analysis-status").textContent =
          `${result.length} output features. Input retained.`;
        say("Analysis completed.");
      });
      on("gis-table-open", "click", () => {
        const fs = selectedFeatures(v("gis-table-layer")),
          fields = G.fieldNames(fs),
          table = document.createElement("table"),
          head = document.createElement("tr");
        for (const f of fields) {
          const th = document.createElement("th");
          th.textContent = f;
          head.append(th);
        }
        table.append(head);
        for (const f of fs.slice(0, 200)) {
          const tr = document.createElement("tr");
          for (const k of fields) {
            const td = document.createElement("td");
            td.textContent = String(G.field(f, k) ?? "");
            tr.append(td);
          }
          table.append(tr);
        }
        $("gis-table-content").replaceChildren(
          document.createTextNode(
            `Showing ${Math.min(200, fs.length)} of ${fs.length} features`,
          ),
          table,
        );
        $("gis-table-dialog").showModal();
      });
      on("gis-table-close", "click", () => $("gis-table-dialog").close());
      on("gis-fields-apply", "click", () => {
        const name = v("gis-table-layer"),
          fs = selectedFeatures(name);
        if (!fs.length) throw Error("Choose a layer.");
        const fields = v("gis-fields")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        if (fields.some((k) => !G.fieldNames(fs).includes(k)))
          throw Error("Unknown field name. Inspect the table first.");
        const changed = G.configureFields(fs, {
          fields,
          primaryKey: v("gis-key").trim(),
          caseMode: v("gis-case"),
        });
        const byId = new Map(changed.map((f) => [f.id, f]));
        state.features = state.features.map((f) => byId.get(f.id) || f);
        refresh();
        persist();
        say("Attribute settings applied.");
      });
      function validateRaster(data) {
        if (!data) throw Error("Missing raster data.");
        if (
          data.type !== "FSSRaster" ||
          !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.image || "") ||
          data.image.length > 8 * 1024 * 1024
        )
          throw Error("Invalid raster overlay or image exceeds 8 MB.");
        if (!Array.isArray(data.coordinates) || data.coordinates.length !== 4)
          throw Error("Raster needs four WGS84 corners.");
        const corners = data.coordinates.map((p) => C.coord(p));
        if (corners.some((p) => Math.abs(p[1]) > 85.05113))
          throw Error("Raster exceeds Web Mercator latitude coverage.");
        return corners;
      }
      function addRaster(data, name, remember = true) {
        const corners = validateRaster(data);
        model.rasters = model.rasters || [];
        if (remember && model.rasters.length >= 4)
          throw Error("Limit: four raster overlays.");
        const id = "gis-raster-" + C.cryptoId();
        map.addSource(id, {
          type: "image",
          url: data.image,
          coordinates: corners,
        });
        map.addLayer({ id, type: "raster", source: id }, "accuracy-fill");
        webLayers.push({ id, name, visible: true, rasterName: name });
        if (remember) model.rasters.push({ data, name });
        sync();
        persist();
      }
      async function importFile(file) {
        if (!/\.(json|geojson)$/i.test(file.name)) return false;
        if (file.size > 40 * 1024 * 1024) throw Error("File limit is 40 MB.");
        const data = JSON.parse(await file.text());
        if (data.type === "FSSRaster") {
          addRaster(data, file.name);
          say("Georeferenced raster overlay added.");
          return true;
        }
        if (data.type === "FeatureCollection" || data.type === "Feature") {
          if (data.crs && !JSON.stringify(data.crs).match(/4326|CRS84/))
            throw Error(
              "Use the GIS workbench to convert this CRS to WGS84 first.",
            );
          addFeatures(G.normalize(data, file.name));
          say("Vector layer imported.");
          return true;
        }
        if (data.type === "FSSProject" && data.gis) {
          const fs = C.validateFeatures(data.landmarks);
          C.validateFeatures({
            type: "FeatureCollection",
            features: [...state.features, ...fs],
          });
          // Apply only recognized style settings through a bounded JSON object.
          const raw = data.gis;
          if (JSON.stringify(raw).length > 35 * 1024 * 1024)
            throw Error("Project style/raster payload is too large.");
          const rasters = Array.isArray(raw.rasters) ? raw.rasters : [];
          if (rasters.length + (model.rasters || []).length > 4)
            throw Error("Project would exceed four raster overlays.");
          rasters.forEach((r) => validateRaster(r.data));
          addFeatures(fs);
          const savedLayers = Array.isArray(raw.layers) ? raw.layers : [];
          const restored = [];
          for (const l of savedLayers) {
            if (
              l &&
              model.layers.some((x) => x.name === l.name) &&
              !restored.some((x) => x.name === l.name)
            )
              restored.push({ name: l.name, visible: l.visible !== false });
          }
          model.layers = [
            ...restored,
            ...model.layers.filter(
              (l) => !restored.some((x) => x.name === l.name),
            ),
          ];
          if (raw.labels)
            model.labels = {
              margin: Math.max(0, Math.min(40, Number(raw.labels.margin) || 0)),
              deduplicate: raw.labels.deduplicate !== false,
              distance: Math.max(
                0,
                Math.min(1000, Number(raw.labels.distance) || 120),
              ),
            };
          for (const l of model.layers) {
            const s = raw.styles?.[l.name];
            if (
              s &&
              [
                "original",
                "single",
                "categorized",
                "graduated",
                "heatmap",
              ].includes(s.mode)
            ) {
              model.styles[l.name] = {
                mode: s.mode,
                field: String(s.field || "name").slice(0, 100),
                labelField: String(s.labelField || "name").slice(0, 100),
                color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : undefined,
                size: Math.max(2, Math.min(30, Number(s.size) || 6)),
                width: Math.max(1, Math.min(12, Number(s.width) || 3)),
                opacity: Math.max(
                  0,
                  Math.min(1, Number.isFinite(s.opacity) ? s.opacity : 1),
                ),
                labelMin: Math.max(0, Math.min(22, Number(s.labelMin) || 0)),
                labelMax: Math.max(0, Math.min(22, Number(s.labelMax) || 22)),
              };
            }
          }
          for (const raster of (Array.isArray(raw.rasters)
            ? raw.rasters
            : []
          ).slice(0, 4))
            addRaster(
              raster.data,
              String(raster.name || "Raster").slice(0, 160),
            );
          refresh();
          persist();
          say("Project landmarks, styles and raster overlays imported.");
          return true;
        }
        return false;
      }
      on("gis-add-service", "click", async () => {
        const raw = v("gis-url").trim(),
          credit = v("gis-source-credit").trim();
        if (!credit) throw Error("Enter the source attribution.");
        if (v("gis-service") === "wms") {
          const url = G.wmsURL(raw, v("gis-wms-layers")),
            id = "gis-web-" + C.cryptoId();
          map.addSource(id, {
            type: "raster",
            tiles: [url],
            tileSize: 256,
            attribution: credit.replace(/[<>]/g, ""),
          });
          map.addLayer({ id, type: "raster", source: id }, "accuracy-fill");
          webLayers.push({ id, name: v("gis-wms-layers"), visible: true });
          sync();
          say(
            "WMS layer added. Network access and EPSG:3857 support are required.",
          );
        } else {
          const url = new URL(raw);
          if (url.protocol !== "https:" || url.username || url.password)
            throw Error("Use HTTPS without credentials.");
          const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
          if (!res.ok) throw Error(`Web data request failed (${res.status}).`);
          const reader = res.body.getReader(),
            chunks = [];
          let size = 0;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 10 * 1024 * 1024) {
              await reader.cancel();
              throw Error("Web vector limit is 10 MB.");
            }
            chunks.push(value);
          }
          const text = await new Blob(chunks).text(),
            data = JSON.parse(text);
          if (data.crs && !JSON.stringify(data.crs).match(/4326|CRS84/))
            throw Error(
              "Request WGS84 longitude/latitude GeoJSON from the service.",
            );
          const fs = G.normalize(data, "Web data " + new Date().toISOString());
          fs.forEach((f) => (f.properties.description = `Source: ${credit}`));
          addFeatures(fs);
          say(`Imported ${fs.length} web features.`);
        }
      });
      on("gis-projection", "change", () => {
        if (v("gis-projection") === "globe" && map.getTerrain?.())
          throw Error("Turn off 3D terrain before switching to globe.");
        map.setProjection({ type: v("gis-projection") });
        if (v("gis-projection") === "globe") map.easeTo({ zoom: 2, pitch: 0 });
        model.projection = v("gis-projection");
        persist();
        scaleReadout();
        say(
          v("gis-projection") === "globe"
            ? "Earth globe enabled. Zoom in to explore your layers."
            : "Flat map enabled.",
        );
      });
      on("gis-scale-method", "change", () => {
        model.scale = v("gis-scale-method");
        scaleReadout();
        persist();
      });
      function creditText() {
        const el = document.createElement("div");
        el.innerHTML = Object.values(map.getStyle().sources || {})
          .map((s) => s.attribution || "")
          .filter(Boolean)
          .join(" · ");
        return el.textContent;
      }
      function wrapText(c, text, x, y, maxWidth, line = 18) {
        for (const paragraph of text.split("\n")) {
          let row = "";
          for (const word of paragraph.split(/\s+/)) {
            if (c.measureText(row + word).width > maxWidth && row) {
              c.fillText(row, x, y);
              y += line;
              row = "";
            }
            row += word + " ";
          }
          c.fillText(row, x, y);
          y += line;
        }
        return y;
      }
      on("gis-print-preview", "click", async () => {
        if (printing) return;
        if (!map.areTilesLoaded())
          throw Error("Wait for map tiles to finish loading before export.");
        printing = true;
        try {
          const source = map.getCanvas(),
            canvas = $("gis-print-canvas"),
            dpr = source.width / source.clientWidth;
          const entries = $("gis-print-legend").checked ? legendRows() : [];
          if (entries.length > 100)
            throw Error(
              "Print supports 100 legend entries; hide layers or simplify categories first.",
            );
          canvas.width = source.width + 80;
          canvas.height = source.height + 600 + entries.length * 36;
          const c = canvas.getContext("2d");
          c.fillStyle = "#fff";
          c.fillRect(0, 0, canvas.width, canvas.height);
          c.fillStyle = "#163642";
          c.font = "bold 26px sans-serif";
          c.fillText(v("gis-print-title").slice(0, 100), 40, 42);
          c.drawImage(source, 40, 70);
          c.font = `${12 * dpr}px sans-serif`;
          for (const l of labels) {
            c.fillStyle = "#ffffffe8";
            c.fillRect(
              40 + l.x * dpr,
              70 + (l.y - 12) * dpr,
              l.width * dpr,
              20 * dpr,
            );
            c.fillStyle = "#18333d";
            c.fillText(l.text, 40 + l.x * dpr, 70 + l.y * dpr);
          }
          let y = source.height + 102;
          c.fillStyle = "#17333e";
          c.font = "13px sans-serif";
          const bearing = map.getBearing(),
            r = (-bearing * Math.PI) / 180;
          c.save();
          c.translate(canvas.width - 65, 110);
          c.rotate(r);
          c.font = "bold 26px sans-serif";
          c.fillText("↑", -8, 0);
          c.font = "bold 15px sans-serif";
          c.fillText("N", -5, -24);
          c.restore();
          const scale = scaleReadout();
          if (scale !== null) {
            const length = 100 * dpr;
            c.fillRect(40, y, length, 3);
            c.fillText(
              `${scale.toFixed(1)} m · ${v("gis-scale-method")} reference`,
              40,
              y + 20,
            );
            y += 42;
          } else {
            c.fillText(
              "Scale varies in globe / tilted view; no scale bar",
              40,
              y,
            );
            y += 24;
          }
          if (entries.length) {
            c.font = "bold 13px sans-serif";
            c.fillText("Legend", 40, y);
            y += 20;
            c.font = "13px sans-serif";
            for (const entry of entries) {
              c.fillStyle = entry.color;
              c.fillRect(40, y - 10, 12, 12);
              c.fillStyle = "#17333e";
              y = wrapText(c, entry.text, 60, y, canvas.width - 110, 16) + 4;
            }
          }
          c.font = "11px sans-serif";
          y = wrapText(
            c,
            (v("gis-print-notes") + "\n" + creditText()).slice(0, 2000),
            40,
            y + 8,
            canvas.width - 80,
            15,
          );
          const cropped = document.createElement("canvas");
          cropped.width = canvas.width;
          cropped.height = Math.min(canvas.height, y + 30);
          cropped.getContext("2d").drawImage(canvas, 0, 0);
          canvas.height = cropped.height;
          c.drawImage(cropped, 0, 0);
          canvas.toDataURL("image/png");
          $("gis-print-dialog").showModal();
          say(
            "Print preview ready. PNG is raster; Save as PDF uses the browser print dialog.",
          );
        } finally {
          printing = false;
        }
      });
      on("gis-print-close", "click", () => $("gis-print-dialog").close());
      on(
        "gis-print-png",
        "click",
        () =>
          new Promise((resolve, reject) =>
            $("gis-print-canvas").toBlob((blob) => {
              if (!blob) {
                reject(Error("Map image export failed."));
                return;
              }
              downloadBlob(blob, "fss-map-layout.png");
              resolve();
            }, "image/png"),
          ),
      );
      on("gis-print-pdf", "click", () => window.print());
      map.on("moveend", () => {
        updateLabels();
        scaleReadout();
      });
      $("gis-scale-method").value = model.scale || "center";
      if (model.projection === "globe" && map.setProjection) {
        map.setProjection({ type: "globe" });
        $("gis-projection").value = "globe";
      }
      for (const r of (model.rasters || []).slice(0, 4)) {
        try {
          addRaster(r.data, r.name, false);
        } catch (e) {
          say(`Stored raster: ${e.message}`, true);
        }
      }
      sync();
      styleForm();
      return {
        sync,
        styled,
        drawLayers,
        importFile,
        layerIds: () => layerIds,
        webLayers: () => webLayers,
        updateLabels,
      };
    },
  };
})(window);
