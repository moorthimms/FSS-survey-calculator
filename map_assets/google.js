/* Google-hosted content is rendered only through the official Google SDK. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id),
    cfg = window.GOOGLE_CONFIG || {};
  let map,
    earth,
    marker,
    geocoder,
    traffic,
    transit,
    polylines = [],
    routeMarkers = [],
    generation = 0,
    searchGeneration = 0,
    modeGeneration = 0;
  let center = { lat: 29.583, lng: 80.218 },
    currentType = "roadmap",
    currentMapId = cfg.mapId || "DEMO_MAP_ID";
  const status = (text) => ($("status").textContent = text);
  function coordinate(text) {
    const s = text.trim();
    if (!/^[+\-\d.\s,]+$/.test(s)) return null;
    const parts = s.split(/\s*,\s*|\s+/).filter(Boolean);
    if (
      parts.length !== 2 ||
      parts.some((p) => !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(p))
    )
      throw Error("Enter latitude, longitude as two decimal numbers.");
    const [lat, lng] = parts.map(Number);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    )
      throw Error("Latitude must be −90…90 and longitude −180…180.");
    return { lat, lng };
  }
  function endpoint(id) {
    const text = $(id).value.trim();
    if (!text) throw Error("Enter both From and To locations.");
    return coordinate(text) || text;
  }
  const fmt = (p) => `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
  function point(p) {
    return {
      lat: typeof p.lat === "function" ? p.lat() : p.lat,
      lng: typeof p.lng === "function" ? p.lng() : p.lng,
    };
  }
  function links() {
    const q = $("query").value.trim();
    $("external-search").href =
      "https://www.google.com/maps/search/?" +
      new URLSearchParams({ api: "1", query: q || fmt(center) });
    $("external-route").href =
      "https://www.google.com/maps/dir/?" +
      new URLSearchParams({
        api: "1",
        origin: $("origin").value.trim(),
        destination: $("destination").value.trim(),
        travelmode: {
          DRIVING: "driving",
          WALKING: "walking",
          BICYCLING: "bicycling",
          TRANSIT: "transit",
        }[$("travel").value],
      });
  }
  function on(id, event, fn) {
    $(id).addEventListener(event, async () => {
      try {
        await fn();
      } catch (e) {
        status(
          e.message ||
            "Google operation failed. Check the enabled APIs, key restrictions and network.",
        );
      }
    });
  }
  function requireMap() {
    if (!map)
      throw Error(
        "Google map is not ready. Configure the browser key or use Open in Google Maps.",
      );
  }
  function clearRoute() {
    generation++;
    polylines.forEach((p) => p.setMap(null));
    routeMarkers.forEach((p) => (p.map = null));
    polylines = [];
    routeMarkers = [];
    $("route-summary").textContent = "";
  }
  async function locate(p, title) {
    center = p;
    links();
    $("coordinates").textContent = "WGS84 · " + fmt(p);
    if (!map) {
      status(
        "Valid coordinate: " + fmt(p) + ". Use Open in Google Maps to view.",
      );
      return;
    }
    map.setCenter(p);
    map.setZoom(15);
    if (earth) earth.center = { ...p, altitude: 0 };
    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
    if (marker) marker.map = null;
    marker = new AdvancedMarkerElement({ map, position: p, title });
    status(title + " · " + fmt(p));
  }
  function createMap(id) {
    const oldZoom = map?.getZoom() || 10;
    if (map) center = point(map.getCenter());
    clearRoute();
    if (marker) marker.map = null;
    map = new google.maps.Map($("map"), {
      center,
      zoom: oldZoom,
      mapId: id,
      mapTypeId: "roadmap",
      mapTypeControl: false,
      streetViewControl: true,
      fullscreenControl: true,
      scaleControl: true,
    });
    currentMapId = id;
    traffic = new google.maps.TrafficLayer();
    transit = new google.maps.TransitLayer();
    traffic.setMap($("traffic").checked ? map : null);
    transit.setMap($("transit").checked ? map : null);
    map.addListener("idle", () => {
      if (!currentType.startsWith("3d-")) {
        center = point(map.getCenter());
        $("coordinates").textContent = "Map center · WGS84 " + fmt(center);
      }
    });
    map.addListener("mousemove", (e) => {
      if (e.latLng)
        $("coordinates").textContent = "Cursor · WGS84 " + fmt(point(e.latLng));
    });
  }
  async function setType() {
    requireMap();
    const value = $("map-type").value,
      ticket = ++modeGeneration;
    if (value.startsWith("3d-")) {
      clearRoute();
      if (value === "3d-roadmap" && !cfg.experimental)
        throw Error("Experimental 3D roadmap is not enabled on this host.");
      const { Map3DElement } = await google.maps.importLibrary("maps3d");
      if (ticket !== modeGeneration) return;
      if (!earth) {
        earth = new Map3DElement({
          center: { ...center, altitude: 0 },
          range: 8000,
          tilt: 60,
          heading: 0,
          mode: value.slice(3).toUpperCase(),
        });
        $("earth").append(earth);
        earth.addEventListener("gmp-error", () => status("Google 3D could not render. Check device support, API configuration and coverage, or select a 2D map."));
        earth.addEventListener("gmp-centerchange", () => {
          center = point(earth.center);
          $("coordinates").textContent = "3D center · WGS84 " + fmt(center);
        });
      }
      earth.center = { ...center, altitude: 0 };
      earth.mode = value.slice(3).toUpperCase();
      $("earth").hidden = false;
      $("map").hidden = true;
    } else {
      const id =
        value === "navigation"
          ? cfg.navigationMapId
          : cfg.mapId || "DEMO_MAP_ID";
      if (!id)
        throw Error("Navigation styling needs a configured navigation map ID.");
      if (currentMapId !== id) createMap(id);
      $("earth").hidden = true;
      $("map").hidden = false;
      map.setCenter(center);
      map.setMapTypeId(value === "navigation" ? "roadmap" : value);
    }
    currentType = value;
    $("type-note").textContent =
      value === "navigation"
        ? "Host-configured navigation cloud style."
        : value.startsWith("3d-")
          ? "3D exploration; routes and traffic remain on the 2D map."
          : "";
    status("Map view: " + $("map-type").selectedOptions[0].textContent);
  }
  on("map-type", "change", async () => {
    try {
      await setType();
    } catch (e) {
      $("map-type").value = currentType;
      throw e;
    }
  });
  on("search", "click", async () => {
    const text = $("query").value.trim();
    if (!text) throw Error("Enter a place or coordinates.");
    links();
    const ticket = ++searchGeneration;
    $("results").replaceChildren();
    const p = coordinate(text);
    if (p) {
      await locate(p, "Selected coordinate");
      return;
    }
    requireMap();
    status("Searching…");
    if (!geocoder) {
      const { Geocoder } = await google.maps.importLibrary("geocoding");
      geocoder = new Geocoder();
    }
    const { results } = await geocoder.geocode({ address: text, region: "in" });
    if (ticket !== searchGeneration) return;
    if (!results?.length)
      throw Error("No matching place found. Add a district, state or country.");
    for (const result of results.slice(0, 8)) {
      const b = document.createElement("button");
      b.textContent = result.formatted_address;
      b.onclick = () =>
        locate(point(result.geometry.location), result.formatted_address).catch(
          (e) => status(e.message),
        );
      $("results").append(b);
    }
    status("Choose a matching location.");
  });
  $("query").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("search").click();
  });
  ["query", "origin", "destination", "travel"].forEach((id) =>
    on(id, "input", () => {
      links();
      if (id !== "query") clearRoute();
    }),
  );
  on("swap", "click", () => {
    [$("origin").value, $("destination").value] = [
      $("destination").value,
      $("origin").value,
    ];
    clearRoute();
    links();
  });
  for (const id of ["origin", "destination"])
    on(id + "-center", "click", () => {
      $(id).value = fmt(center);
      clearRoute();
      links();
    });
  on("clear-route", "click", clearRoute);
  on("route", "click", async () => {
    const origin = endpoint("origin"),
      destination = endpoint("destination");
    links();
    requireMap();
    clearRoute();
    if (currentType.startsWith("3d-")) {
      $("map-type").value = "roadmap";
      await setType();
    }
    const ticket = ++generation;
    status("Calculating route…");
    const { Route } = await google.maps.importLibrary("routes");
    const { routes } = await Route.computeRoutes({
      origin,
      destination,
      travelMode: $("travel").value,
      fields: ["path", "distanceMeters", "durationMillis"],
    });
    if (ticket !== generation) return;
    const route = routes?.[0];
    if (!route?.path?.length)
      throw Error("No route found for this travel mode.");
    const markers = await route.createWaypointAdvancedMarkers();
    if (ticket !== generation) return;
    polylines = route.createPolylines();
    polylines.forEach((p) => p.setMap(map));
    routeMarkers = markers;
    markers.forEach((p) => (p.map = map));
    const bounds = new google.maps.LatLngBounds();
    route.path.forEach((p) => bounds.extend(point(p)));
    map.fitBounds(bounds);
    $("route-summary").textContent =
      `${Number.isFinite(route.distanceMeters) ? (route.distanceMeters / 1000).toFixed(2) + " km" : "Distance unavailable"} · ${Number.isFinite(route.durationMillis) ? Math.round(route.durationMillis / 60000) + " min estimated" : "Time unavailable"}\nUse Navigate in Google Maps for instructions.`;
    status("Route shown. Endpoints may snap to accessible roads.");
  });
  on("traffic", "change", () => {
    requireMap();
    traffic.setMap($("traffic").checked ? map : null);
  });
  on("transit", "change", () => {
    requireMap();
    transit.setMap($("transit").checked ? map : null);
  });
  on("north", "click", () => {
    requireMap();
    map.setHeading(0);
    if (earth) earth.heading = 0;
    $("heading").value = 0;
  });
  on("camera", "click", () => {
    if (!earth || !currentType.startsWith("3d-"))
      throw Error("Select a 3D map first.");
    earth.tilt = Number($("tilt").value);
    earth.heading = Number($("heading").value);
  });
  for (const [id, delta] of [
    ["zoom-in", 1],
    ["zoom-out", -1],
  ])
    on(id, "click", () => {
      requireMap();
      if (currentType.startsWith("3d-"))
        earth.range = Math.max(
          100,
          Math.min(20000000, earth.range * Math.pow(2, -delta)),
        );
      else map.setZoom(map.getZoom() + delta);
    });
  on(
    "own",
    "click",
    () =>
      new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(Error("Geolocation is not supported."));
          return;
        }
        status("Requesting device location…");
        navigator.geolocation.getCurrentPosition(
          async (position) => {
            try {
              const c = position.coords;
              await locate(
                { lat: c.latitude, lng: c.longitude },
                "Own position",
              );
              $("origin").value = fmt(center);
              clearRoute();
              links();
              status(
                `Device accuracy ±${c.accuracy.toFixed(1)} m · height ${Number.isFinite(c.altitude) ? c.altitude.toFixed(1) + " m (device datum)" : "unavailable"}.`,
              );
              resolve();
            } catch (e) {
              reject(e);
            }
          },
          (e) => reject(Error("Location unavailable: " + e.message)),
          { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
        );
      }),
  );
  $("map-type").querySelector('[value="navigation"]').disabled =
    !cfg.navigationMapId;
  $("map-type").querySelector('[value="3d-roadmap"]').disabled =
    !cfg.experimental;
  links();
  window.gm_authFailure = () =>
    status(
      "Google authentication failed. Check billing, enabled APIs and website restrictions for this browser key.",
    );
  window.initGoogleMap = async () => {
    try {
      await google.maps.importLibrary("maps");
      createMap(currentMapId);
      status("Google map ready. Search or enter route endpoints.");
    } catch (e) {
      status("Google map failed to initialize: " + e.message);
    }
  };
  if (cfg.key) {
    const script = document.createElement("script");
    script.src =
      "https://maps.googleapis.com/maps/api/js?" +
      new URLSearchParams({
        key: cfg.key,
        loading: "async",
        callback: "initGoogleMap",
        v: cfg.experimental ? "alpha" : "weekly",
      });
    script.async = true;
    script.onerror = () =>
      status(
        "Google Maps could not load. Check the network or use Open in Google Maps.",
      );
    document.head.append(script);
  } else
    status(
      "Google key not configured. Enter coordinates or use the Google Maps links.",
    );
})();
