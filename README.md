# FSS Survey Calculator

A Streamlit web application for surveying and geodetic calculations, including:

- latitude/longitude distance and bearing
- grid distance, bearing, and traverse calculations
- decimal-degree and DMS conversion
- WGS84, supported Kalianpur 1975 (ESM), and DSM WGS84/LCC coordinate conversion
- automatic zone detection
- CSV batch conversion, including DSM and ESM conversions in both directions
- browser-based position display

All 14 application tabs are retained. The zone catalog and selectors preserve all **9 original Kalianpur entries and 24 original DSM entries**, including their original identifiers. Calculation definitions are tracked separately so a historical identifier cannot silently select an unrelated grid.

## Run locally

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
streamlit run app.py
```

For browser location, serve the application through HTTPS (or use localhost) and grant location permission. Browser/device location is informational and is not a substitute for survey-grade GNSS equipment.

## Input notes

- Latitude and longitude are WGS84 decimal degrees unless a DMS field is shown.
- Grid coordinates and heights are metres.
- Select the correct Kalianpur source zone for inverse and batch conversions; using the wrong zone produces incorrect coordinates.
- Kalianpur transformations use the EPSG definitions below. Coordinates outside their area bounds are rejected; there is no default Zone I or nearest-zone fallback.
- Automatic zone suggestions use EPSG bounding boxes, which are not exact coverage polygons. Confirm the source map's datum and zone. Inverse conversions reject results outside the selected zone's bounds, but cannot identify every incorrectly selected source zone.
- Transformations reject non-finite input/output and disallow PROJ's approximate “ballpark” datum operations. Invalid batch rows receive an error status, never a successful infinite or NaN result.
- Transformation accuracy is displayed separately from numeric formatting. The operation available in the tested registry, Kalianpur 1975 to WGS 84 (1), has an expected accuracy of **22 m**. Millimetre-formatted output does not establish millimetre accuracy. Heights are passed through unchanged; no vertical datum transformation is performed.

## Supported Kalianpur 1975 zones

| Zone | EPSG CRS | Central meridian |
| --- | --- | --- |
| I | 24378 | 68°E |
| IIa | 24379 | 74°E |
| IIb | 24380 | 90°E |
| IIIa | 24381 | 80°E |
| IVa | 24383 | 80°E |

The code reads area bounds, descriptions, and central meridians from the installed EPSG registry, and verifies each CRS name and datum before use. CRS loading alone is insufficient: a valid identifier can describe a completely different datum or region.

## Geodetic audit

Checked with pyproj 3.8.0, PROJ 9.8.1, and EPSG v12.029 (2025-10-02):

| Previous assignment | Registry finding |
| --- | --- |
| DSM 5C → EPSG:2001 | Antigua 1943 / British West Indies Grid |
| DSM 5D → EPSG:2007 | St. Vincent 45 / British West Indies Grid |
| DSM 5E → EPSG:2013 | NAD27(CGQ77) / SCoPQ zone 7 (Canada) |
| Kalianpur 1975 IIIb → EPSG:24382 | Kalianpur **1880** / India zone **IIb** |
| Kalianpur IVb, Va, Vb → EPSG:24384–24386 | No CRS records in the tested EPSG registry |

All 24 former DSM EPSG assignments identify unrelated Caribbean or Canadian grids. **Every original assignment is retained** in [data/legacy_zone_catalog.json](data/legacy_zone_catalog.json), recovered from the original `app.py` at commit `85600eb`. This includes the original bounds, descriptions, meridians, and former custom DSM parameters. The archive is reference data; calculations use separately verified definitions. DSM conversions currently use the 18 zones in the user-supplied parameter table with custom CRS names.

### Complete catalog and remaining parameter gaps

**Zone List** displays the original identifier, its actual registry meaning, the calculation definition, and whether parameters are ready. The complete original catalog can be downloaded as JSON. Source-zone selectors retain all original entries; DSM target selectors also retain all 24 entries. Selecting an entry without parameters explains exactly what is missing. It does not remove the entry, substitute another zone, or submit its mismatched identifier to the projection engine.

| System | Definitions available for conversion | Original entries awaiting source parameters |
| --- | --- | --- |
| Kalianpur 1975 | I, IIa, IIb, IIIa, IVa | IIIb, IVb, Va, Vb |
| DSM | All 18 rows in the supplied photo | 7C, 7D, 7G, 7H, 8C, 8D |

To complete those conversions, the remaining DSM entries need their authoritative projection-table rows, including datum, origin, standard parallels, and false offsets. The remaining Kalianpur entries need authoritative projection parameters **and** a datum transformation to WGS84. The old identifiers alone do not supply this information. Neighboring rows are not extrapolated into purported official definitions. Automatic conversion continues to use only available definitions; the original bounds are preserved as historical metadata, not evidence of valid coverage.

The previous custom DSM definition used `+proj=tmerc` (Transverse Mercator), despite the UI label “LCC”, and an unnamed datum specified only by ellipsoid axes. PROJ could construct only a ballpark datum operation to/from WGS84, with unknown accuracy. Removing the false EPSG labels did not repair that transformation.

The user subsequently supplied `20260916_102204.jpg`, titled **DSM GRID ZONE PARAMETERS**. Its parameters replace that incorrect calculation as described below.

Registry and transformation references: [PROJ CRS Explorer](https://crs-explorer.proj.org/), [PROJ coordinate-operation selection](https://proj.org/en/stable/operations/operations_computation.html), and [pyproj Transformer API](https://pyproj4.github.io/pyproj/stable/api/transformer.html).

## DSM parameters and coordinate reference

The complete transcription, original DMS precision, and source-image SHA-256 are in [data/dsm_zones.json](data/dsm_zones.json). The photo supplies the projection parameters but does not name the datum. **WGS84** is used based on [Survey of India's description of DSM](https://surveyofindia.gov.in/pages/publications), which identifies the series as WGS84/LCC. This datum choice is documented separately from the image transcription.

| Longitude of origin | Supplied zones |
| --- | --- |
| 72°E | 5C, 5D, 5E, 5F, 5G, 5H |
| 80°E | 6C, 6D, 6E, 6F, 6G, 6H |
| 88°E | 7E, 7F |
| 96°E | 8E, 8F, 8G, 8H |

| Band | Latitude of origin (N) | Standard parallel 1 (N) | Standard parallel 2 (N) | Central scale (reference) |
| --- | --- | --- | --- | --- |
| C | 39°00′39.60″ | 36°51′26″ | 41°08′34″ | 0.9993035 |
| D | 33°00′31.84″ | 30°51′26″ | 35°08′34″ | 0.9993040 |
| E | 27°00′25.04″ | 24°51′26″ | 29°08′34″ | 0.9993044 |
| F | 21°00′18.90″ | 18°51′26″ | 23°08′34″ | 0.9993048 |
| G | 15°00′13.21″ | 12°51′26″ | 17°08′34″ | 0.9993051 |
| H | 09°00′07.82″ | 06°51′26″ | 11°08′34″ | 0.9993053 |

Every zone has **false easting = 500,000 m** and **false northing = 500,000 m**. For example, the Zone **6E** origin, **27°00′25.04″N, 80°00′00″E**, converts to **E 500,000 m, N 500,000 m**. The same grid numbers in a different zone describe a different location; always retain the zone identifier. Enter full metre coordinates, not a shortened grid reference without its square identification.

The projection is **Lambert Conformal Conic (2SP)** on the WGS84 ellipsoid. The two standard parallels already imply the central scale. Their calculated scale matches every printed band value within its seven-decimal rounding precision. The printed factor is retained as a reference check; it is **not applied again** as an additional `k_0`. In PROJ that extra parameter would introduce the differently scaled 2SP Michigan variant. See [PROJ's LCC documentation](https://proj.org/en/stable/operations/projections/lcc.html).

The source table contains no boundary polygons. Automatic suggestions use nominal **8° longitude × 6° latitude** bands centred on the listed meridian and integer latitude band centre. These are application suggestions, not verified map-sheet boundaries. Auto mode rejects absent or ambiguous matches; a shared boundary requires manual selection. An explicit zone uses that zone's projection without treating the nominal rectangle as an authoritative coverage restriction. Inverse DSM conversion always requires the source zone.

### Using DSM in the app

- **Lat/Lon to Grid:** choose `DSM (WGS84 LCC)` and the target zone, or use the nominal auto suggestion.
- **DSM to Lat/Lon:** choose the map sheet's source zone and enter full easting/northing in metres.
- **ESM to DSM / DSM to ESM:** conversions pass through WGS84 and retain the existing Kalianpur datum accuracy information. Unsupported Kalianpur locations are rejected.
- **Batch Process:** choose one of the five operations. WGS84 input uses `lat,lon`; grid input uses `easting,northing`. Exports retain source/target zone and CRS labels. Failed rows remain explicit errors.
- **Own Position:** DSM output uses the supplied parameters, with a zone override available.
- **Zone List → DSM:** view all 24 original identifiers and their calculation status, followed by the 18 supplied parameter rows. Download the complete original catalog as JSON or the supplied parameter reference as CSV.

The mathematics is checked independently against the [EPSG 9802 equations documented by GDAL](https://gdal.org/en/stable/proj_list/lambert_conic_conformal_2sp.html), the origin coordinates, standard-parallel scales, and forward/inverse round trips. The photo contains no independent surveyed control points. **These are verified calculations from the supplied table, not certification of field accuracy.** A known point with its DSM zone, full grid coordinates, and independently established WGS84 latitude/longitude is still needed for an external check. DSM↔WGS84 uses the same datum; conversions involving Kalianpur retain the approximately 22 m datum-transformation limitation noted above. No vertical datum transformation is performed.

## Regression checks

```bash
python -m unittest discover -s tests -v
```

The tests cover preservation of all 33 original zone identifiers, complete selectors and reference views, separation of historical identifiers from conversion definitions, all five verified Kalianpur zones, the 18 DSM image rows, origin and scale checks, an independent LCC formula, forward/inverse and ESM/DSM chains, missing definitions and non-finite values, Streamlit screens, batch exports, and DSM position output. Numerical fixtures and mathematical origin checks are not independently surveyed control points.
