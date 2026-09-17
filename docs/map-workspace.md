# Map workspace and menu

The feature discussions in `alpine.txt` are implemented as a browser mapping workspace under **Menu → Map**. All fourteen existing calculator, conversion, positioning and reference pages remain in the sidebar menu, giving fifteen pages in total. The original 33 zone identifiers and all existing conversion definitions are unchanged.

## GIS layout and live references

A compact toolbar opens the docked tools panel. Pan, Point, Distance and Area select drawing modes; Landmarks, Layers, GPS, Terrain and Display open their controls. The map corner offers Locate me, North up and Maps. North up resets true-north rotation and tilt without needing a device compass. All original pages remain in the main menu.

The default lower readout follows the desktop cursor, returning to the map center on pointer exit or pan. It includes primary/secondary coordinates, WGS84 MGRS, DSM and Kalianpur easting/northing with suggested zones, and ground elevation. Shared bands/overlapping EPSG bounding boxes show multiple suggestions. These suggestions do not identify the source map sheet. Choose an explicit zone in the coordinate format selector when required; all historical identifiers remain in Zone List.

The browser Kalianpur definitions are exported from the same installed EPSG CRS and verified geocentric translation used by Python. Tests compare forward and inverse results against PROJ at 15 locations across all five supported zones, within 1 mm numerically. This agreement is not positioning accuracy: the datum operation reports 22 m accuracy. Missing zone definitions still request source parameters.

Cursor terrain height is enabled by default, using debounced online Terrarium tile requests with a bounded cache and failure retry delay. The Terrain checkbox disables those requests; selecting imported HGT gives local data priority. Ground elevation uses the DEM source's vertical reference and resolution. It is separate from the GPS antenna's WGS84 ellipsoid height; missing DEM/device height remains unavailable. Online terrain services receive the viewed area, and outages or missing tiles cannot produce a measured height. No vertical datum conversion is inferred.

Street (OSM), satellite (Esri World Imagery), topographic (Esri World Topo), blank, custom XYZ, imported raster MBTiles and downloaded-area maps are selectable. Attribution is displayed; provider availability and detail vary. Built-in street/satellite/topographic sources are for live viewing; bulk download remains limited to explicitly permitted custom providers.

Every source-grid converter, including both DSM/ESM directions and batch processing, offers Auto (source candidates). Compatible inverse locations are listed for single conversions. Batch ambiguous rows receive candidate-zone errors without invented latitude/longitude. Existing explicit defaults are retained. DSM false-origin coordinates 500000,500000 match all 18 supplied zones, so a source zone must be selected. Map coordinate entry has equivalent Auto candidate behavior. Forward conversion continues to suggest zones from latitude/longitude.

Locate me starts a high-accuracy browser watch after permission. The map, own-point capture and track recorder use the selected maximum accuracy radius and reject implausible jumps. The corner shows accepted-fix age, horizontal uncertainty, height and vertical uncertainty; fixes expire after 15 seconds. Heights are retained from the same accepted fix. Filtering cannot improve the receiver's physical accuracy or produce RTK FIX; use the existing external receiver workflow for RTK.

## Feature coverage

| Requested feature | Location and behavior |
| --- | --- |
| Mark a location using the center target | Mark & measure → Waypoint → Add center point; map clicks also add a point |
| Name, color and symbol | Waypoint/route/area creation and the landmark editor |
| Cursor and map-center coordinates | Default WGS84 DD/UTM/MGRS and suggested DSM/Kalianpur coordinates; cursor movement on desktop, center position while panning or using touch |
| DD, DMS and metric coordinate formats | Display settings: DD, DMS, UTM, MGRS and the existing DSM and Kalianpur catalogs; unsupported entries retain their labels and explain which source parameters are missing |
| Go to supplied coordinates | DD latitude/longitude, UTM easting/northing with hemisphere and zone, MGRS, or DSM/Kalianpur easting/northing with explicit zone or Auto candidates |
| Two-point and multi-leg measurement | Route / distance; live preview leg distance and true bearing; saved total length |
| Property area and perimeter | Area / property; WGS84 ellipsoidal area and perimeter; undo and draggable vertices; crossed boundaries are rejected |
| Acres, hectares and imperial units | Display settings; metres/kilometres or feet/miles, square metres, hectares, acres or square feet |
| Primary and alternate grid | Independent grid toggles, numeric labels and a blue secondary grid; projected grids use the selected CRS rather than Web Mercator tile coordinates |
| Saved landmarks and folders | Search, folder filter, rename, description, visibility, color/symbol changes, zoom, delete and restore the last deletion |
| Edit a boundary/route | Edit vertices, drag points, add/undo vertices, save or cancel; timestamp metadata is cleared after geometry changes |
| Offline map selection and download | Select the current bounds, choose zoom levels, estimate tile count/size, download progress, cancel and use cached tiles |
| Offline tile source controls | Downloads require an explicitly permitted custom HTTPS XYZ provider with CORS; public OSM bulk downloading is disabled |
| Desktop atlas workflow | Import raster MBTiles created in MOBAC or another GIS tool; PNG/JPEG/WebP supported, with TMS row addressing and available zoom range |
| GPX and KML/KMZ import | Waypoints, routes, tracks and polygons; track segments and missing heights retained |
| Export and sharing | GPX, KML, KMZ, GeoJSON and per-vertex CSV; selected item, folder or all items; device share sheet when supported, download fallback otherwise |
| Dynamic profile | Interactive distance/time X axis, independent left/right Y axes for height, speed, incline or horizontal/vertical accuracy; cursor and slider locate the corresponding point on the map |
| Track statistics | Distance, segment/point count, elapsed timestamp span, height minimum/maximum and unfiltered ascent/descent |
| Own GPS position and height | Explicit Start/Stop GPS, current position, horizontal uncertainty radius, height and vertical accuracy; no missing height replaced with zero |
| Track recorder | Start, pause/resume and finish; configurable interval, accuracy, minimum movement, maximum speed and gap thresholds; interruptions produce separate segments |
| Go To navigation | Straight-line distance and true bearing to a waypoint, live target line and proximity alert |
| Path following | Nearest-path projection, look-ahead target, remaining along-path distance, off-path distance and alert; no road routing or obstacle detection |
| Sound and vibration | Explicit opt-in; browser-supported audio/vibration with rate limiting |
| Compass and map rotation | Device absolute heading where exposed and permitted; north-up, GPS course-up and compass-up; GPS-course target arrow uses true bearings |
| Explorer perspective | 60-degree tilted view, navigation controls and fullscreen |
| Online DEM and hillshade | Optional AWS Terrarium source, on-demand tile fetching, bounded local cache and clear/reload controls |
| HGT elevation files | Local import of 1201×1201 or 3601×3601 signed big-endian samples; standard filenames, exact byte-size validation, bilinear height sampling and void handling |
| Terrain visualization | 3D relief, hillshade, HGT elevation colors, HGT slope colors and vertical exaggeration |
| Offline app tools | Download a self-contained HTML map workspace; no CDN JavaScript or Python server is needed to open its tools |
| Save and recover | IndexedDB auto-save for landmarks, drawings, recordings, atlas and terrain; recovered recordings remain paused; portable project export/import |
| GPS drift, A-GPS reset and calibration discussion | Recorder filters and field guidance are included. OS A-GPS reset, battery permissions, raw satellite diagnostics and magnetometer calibration are native-device functions, not browser APIs. |

## Use in the field

1. Start the app and open **Menu → Map**. On a narrow screen, open **Map tools** to select a tool group.
2. Choose a drawing type. Tap on the map or align its center target, add vertices, then save the landmark. Existing landmarks are available in **Landmarks & files**.
3. For a recorder, choose **GPS & navigation → Start GPS**, grant location permission, inspect the fix and then start recording. Keep the map visible. Hidden pages pause recording deliberately, preventing an unobserved gap from being drawn as a continuous surveyed path.
4. Import an MBTiles atlas in **Maps & offline areas**. Use its available zoom levels; absent tiles remain blank. For custom tile downloads, select a small region and a provider whose license permits that use.
5. Import HGT files in **Elevation & terrain**, then enable hillshade, relief or slope. An HGT file describes ground terrain, not antenna height. A valid byte count does not prove a DEM's provenance or field accuracy.
6. Export a GeoJSON or FSS project backup. For full offline use, download the HTML workspace while connected, retain the atlas/HGT originals, and import them when opening the standalone workspace. Storage is browser/origin-specific and does not automatically transfer between the hosted app, downloaded HTML, devices or browsers.

## Accuracy and platform limits

Distances and areas use the WGS84 ellipsoid through GeographicLib. They are horizontal geodesic measurements, not terrain-surface distances or a cadastral survey certification. Heights from browser GPS reference the WGS84 ellipsoid; ground DEMs use their own vertical datum. No geoid, pole-height or vertical datum correction is silently applied. Track ascent/descent is unfiltered and can reflect GPS height noise.

The map's GPS stream comes from the browser. The separate **Own Position** page retains the existing serial RTK/NTRIP integration. This change does not add direct phone BLE access or route RTK corrections into a browser GPS receiver.

Compass-up uses the device's reported reference, which may be magnetic. The true-bearing target arrow uses GPS course when available; it does not silently subtract magnetic heading from a true bearing. A stationary or unsupported receiver may not report course.

The browser must support WebGL for interactive rendering. Sensor functions require device support, permission and an appropriate secure context. Opening downloaded HTML provides offline tools, but geolocation access to `file://` depends on browser policy. HTTPS or a localhost web server is the reliable context for sensor access. This app cannot guarantee GPS while the screen is locked or the app is closed.

Basemap boundaries are those supplied by the map provider. Import an authoritative raster map for official boundary work. AQM is proprietary and is not imported; use MOBAC raster MBTiles. Vector PBF MBTiles, raster overlays inside KMZ, raw satellite diagnostics and native Android background services are outside this implementation. Editing multi-segment tracks or polygons with holes requires a GIS editor; viewing, measuring and exporting those geometries are supported.

GPX area exports become boundary tracks because GPX has no polygon type. CSV exports one row per vertex and imports rows as points; GeoJSON/project JSON preserves the complete geometry and metadata. KML geometry is visually clamped to the ground so raw ellipsoidal heights are not misrepresented as KML sea-level heights; raw coordinates and height-reference metadata remain in the file. External programs may ignore FSS extensions.

## Resource limits and recovery

- Project: 2,000 landmarks and 50,000 total vertices; drawings/area rings: 2,000 vertices; path navigation: 5,000 vertices.
- Landmark input: 40 MB, including expanded KML inside KMZ.
- Raster atlas: 150 MB; HGT import: up to four tiles at a time.
- Custom tile area: up to 500 tiles and 80 MB. Incomplete or cancelled downloads keep only successfully fetched tiles and report their count.
- Online DEM cache: up to 256 tiles. Browser quotas and eviction still apply.
- Deletion of a landmark can be undone once in the current session. Removing an offline atlas or DEM requires reimporting the original data to restore it.
- Use project exports as portable backups. Auto-save and a persistent-storage request do not replace backups.

## Verification

Run `python -m unittest discover -s tests -v` for the existing calculators, menu pages, geodesy and RTK transport tests. Run `npm ci && npm test` for map geometry, imports/exports, real SQLite MBTiles reading, DOM interaction tests with simulated sensors/map adapters, and the original browser scan checks. Node dependencies are test-only; deployment still uses `requirements.txt`.

The DOM tests validate application state, tool handlers and persistence without real WebGL. The remote browser in the implementation environment could not reach the local preview, so live visual rendering and physical GPS/compass/RTK commissioning remain required. Verify a known surveyed control and your actual offline atlas before relying on field measurements.

## Protocol references

- [MapLibre custom protocols](https://maplibre.org/maplibre-gl-js/docs/API/functions/addProtocol/) and [raster DEM sources](https://maplibre.org/maplibre-style-spec/sources/#raster-dem)
- [MBTiles 1.3 specification](https://github.com/mapbox/mbtiles-spec/blob/master/1.3/spec.md)
- [GPX 1.1 schema](https://www.topografix.com/GPX/1/1/)
- [W3C Geolocation](https://www.w3.org/TR/geolocation/)
- [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
- [AWS terrain data](https://registry.opendata.aws/terrain-tiles/) and [terrain attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)

- [PROJ Lambert conformal conic parameters](https://proj.org/en/stable/operations/projections/lcc.html)
- [Esri World Imagery service](https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer) and [World Topo service](https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer)
