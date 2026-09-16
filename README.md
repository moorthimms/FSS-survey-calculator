# FSS Survey Calculator

A Streamlit web application for surveying and geodetic calculations, including:

- latitude/longitude distance and bearing
- grid distance, bearing, and traverse calculations
- decimal-degree and DMS conversion
- WGS84 and supported Kalianpur 1975 (ESM) coordinate conversion
- automatic zone detection
- CSV batch conversion
- browser-based position display

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

## Geodetic audit and DSM availability

Checked with pyproj 3.8.0, PROJ 9.8.1, and EPSG v12.029 (2025-10-02):

| Previous assignment | Registry finding |
| --- | --- |
| DSM 5C → EPSG:2001 | Antigua 1943 / British West Indies Grid |
| DSM 5D → EPSG:2007 | St. Vincent 45 / British West Indies Grid |
| DSM 5E → EPSG:2013 | NAD27(CGQ77) / SCoPQ zone 7 (Canada) |
| Kalianpur 1975 IIIb → EPSG:24382 | Kalianpur **1880** / India zone **IIb** |
| Kalianpur IVb, Va, Vb → EPSG:24384–24386 | No CRS records in the tested EPSG registry |

All 24 former DSM EPSG assignments were unrelated Caribbean or Canadian grids. Those assignments have been removed. The legacy DSM index extents remain visible only as **unverified references**.

The previous custom DSM definition used `+proj=tmerc` (Transverse Mercator), despite the UI label “LCC”, and an unnamed datum specified only by ellipsoid axes. PROJ could construct only a ballpark datum operation to/from WGS84, with unknown accuracy. Removing the false EPSG labels did not repair that transformation.

**DSM conversions and DSM position output are unavailable** until an authoritative projection definition, datum transformation, and independent control points are supplied and checked. The application does not guess replacement parameters or substitute a different Indian CRS.

Registry and transformation references: [PROJ CRS Explorer](https://crs-explorer.proj.org/), [PROJ coordinate-operation selection](https://proj.org/en/stable/operations/operations_computation.html), and [pyproj Transformer API](https://pyproj4.github.io/pyproj/stable/api/transformer.html).

## Regression checks

```bash
python -m unittest discover -s tests -v
```

The tests cover registry identity, all five forward/inverse conversions, rejected coverage and non-finite values, Streamlit conversion screens, invalid CSV rows, and unavailable DSM output. Numerical reference values are regression fixtures from PROJ, not independently surveyed control points or certification of field accuracy.
