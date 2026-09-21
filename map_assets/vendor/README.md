# Bundled map dependencies

These pinned upstream distributions are bundled locally so the map client and exported HTML do not need CDN script access. Each package's license is included beside its distribution. `manifest.json` records source URLs and SHA-256 hashes.

| Package | Version | License file |
| --- | --- | --- |
| MapLibre GL JS | 5.6.1 | maplibre-LICENSE.txt |
| GeographicLib Geodesic | 2.1.0 | geographiclib-LICENSE.txt |
| Proj4js | 2.19.10 | proj4-LICENSE.txt |
| MGRS | 2.1.0 | mgrs-LICENSE.txt |
| fflate | 0.8.2 | fflate-LICENSE.txt |
| sql.js (asm.js build) | 1.13.0 | sql-LICENSE.txt |

The unminified GeographicLib distribution is intentionally used. The initially downloaded minified artifact failed known inverse-distance fixtures; do not substitute a different bundle without running the geodesic tests. sql.js uses its self-contained asm.js distribution to avoid an external WebAssembly file request in offline HTML.

Map data, terrain data and imported files have their own provider licenses; these software licenses do not cover those datasets.

Turf 7.2.0 (`turf.js`, MIT, `turf-LICENSE.txt`) supplies the bounded browser spatial analysis and point-on-feature labeling routines. Its distribution hash and upstream URL are recorded in the manifest.

Leaflet 1.9.4 (`leaflet.js`, `leaflet.css`, BSD-2-Clause, `leaflet-LICENSE.txt`) is bundled for the compact OpenStreetMap view. It uses custom DOM symbols, so Leaflet default marker PNGs are not required. The manifest records upstream URLs and SHA-256 hashes.
