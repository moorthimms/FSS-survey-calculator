# SAAS / QGIS data and feature compatibility

## What this change provides

Select **Menu → Map → Advanced GIS / 3D**. The compact map remains the default and the Google Maps option remains available. The previously bundled advanced map and GIS workbench are now accessible without replacing the compact UI or its marker storage.

New functionality:

- Regular XYZ elevation grids load inside the browser and become local terrain for height readouts, 3D relief, hillshade and slope/elevation colors.
- A saved single line can be sampled against the local DEM to create a terrain profile. The original route is retained. The resulting height-bearing line can be exported through the normal landmark export controls.
- Shapefile `.shp`, `.shx`, `.dbf` and optional sidecars can be selected together without making a ZIP first.
- Explicit options remove zero-length lines and simplify a display copy in local UTM metres. Defaults preserve geometry and reject invalid input. Output records cleanup counts and simplification tolerance.

No Windows executable, DLL, private dataset or proprietary runtime is bundled or executed. This is a browser implementation of supported workflows, not a port of the entire SAAS/QGIS desktop application.

## Feature comparison

The SAAS help manual's feature groups were compared with the current repository. Some manual pages are placeholders; a listed feature is not proof that the installed desktop executable works. Desktop software was not executed during inspection. The QGIS installation documentation includes the 3.2 release history; this does not independently establish the executable's exact version. QGIS/SAGA/GRASS algorithm and plugin parity is not claimed.

| Source capability | FSS support after this change | Qualification |
| --- | --- | --- |
| Pan, zoom, turn, tilt, center crosshair, scale and coordinates | Available in the advanced map | Browser controls; not the native HUD |
| Earth globe / 3D terrain | Globe projection and local/online terrain relief | Switch to flat projection before relief; no direct MPT rendering |
| Horizontal distance and plan area | Existing drawing and ellipsoidal measurements | Not terrain surface area |
| Terrain profile and vertical differences | New sampled local-DEM route; interactive height/incline profile | Height source and datum retained; no measurement of buildings |
| Slope map / hillshade | Local HGT or XYZ terrain | Slope colors use the existing approximately 30 m finite-difference method, not native SAAS analysis settings |
| WGS84 MGRS, DSM and Kalianpur references | Existing verified FSS converters and grids | SAAS's “IMGRS” label is not treated as equivalent without its grid definition |
| Feature layers and attributes | GeoJSON/GPX/KML; Shapefile/GeoPackage conversion; style, labels, tables | Missing source CRS must be supplied; map limits still apply |
| Raster layers | GeoTIFF display preparation, WMS imagery, raster MBTiles | GeoTIFF preview and WMS imagery are not DEM heights |
| Labels, text, polyline and polygon | Existing labels, annotations and drawing | Arbitrary image labels and native object properties are not ported |
| Save/load project | FSS project JSON and device storage | No FLY project compatibility; source terrain files retained separately |
| Snapshot / print layout | Existing map export and print composition | Tile-provider/CORS restrictions may affect export |
| GIS vector operations | Existing buffers, centroids, clipping, intersection, dissolve and selection | Bounded browser operations; not the entire QGIS Processing toolbox |
| Line of sight, viewsheds, route viewsheds, 3D-model visibility | Not implemented | Requires an additional validated terrain/model analysis engine |
| Terrain surface area, aerial distance, cut/fill volumes, least-cost path | Not implemented as SAAS equivalents | Existing driving directions are not least-cost terrain paths |
| 3D model import, time slider, presentation editor, movie rendering, stereo | Not ported | Requires additional renderer/animation/runtime work |

## Import a road Shapefile

1. Download the matching `.shp`, `.shx`, `.dbf` and, if supplied, `.prj`/`.cpg` files from your source folder.
2. Open the GIS data workbench below the advanced map and choose **Shapefile components**.
3. Select all matching components. If there is no `.prj`, enter the actual source CRS. Coordinate ranges that look like longitude/latitude are not sufficient evidence of WGS84.
4. Leave simplification at zero for an exact coordinate copy. If invalid zero-length records exist, explicitly select their removal. For a source that exceeds 50,000 vertices, choose a smaller region or an explicit display simplification tolerance. Simplification is not a survey correction and does not improve accuracy.
5. Prepare and download GeoJSON, then load it in **Layers & data → Import vector file**. The conversion summary reports removed records. Keep original files for authoritative use.

Combined upload limit: 80 MB. One basename, mandatory SHP/SHX/DBF; optional PRJ/CPG/QIX/SBN/SBX. Map project limit: 2,000 features and 50,000 vertices, including existing data. Metric simplification is restricted to local extents spanning at most six longitude degrees within UTM latitude coverage.

## Import an XYZ elevation grid

1. Open **Field tools → Elevation & terrain → Import XYZ elevation grid**.
2. Confirm X and Y are WGS84 longitude and latitude in degrees. Projected, non-WGS84 or irregular point data must be reprojected/regridded first; the importer will not guess.
3. Choose the source Z units and record its vertical reference. Feet means international feet. No vertical datum transformation is performed.
4. Set the exact no-data sentinel only when documented. Blank preserves zero as a valid height; zero must not automatically be treated as either missing terrain or a measured sea-level value.
5. Load the file. It replaces the current local terrain and is saved to browser IndexedDB. Select relief, slope or hillshade and press **Apply elevation layers**.
6. To profile a route, save/select a line, then use **Create local terrain profile**. Sampling is limited to 5,000 points; missing terrain stops the operation rather than filling gaps.

Accepted text: three numeric columns separated by whitespace, comma or semicolon; optional `X Y Z`/longitude-latitude-elevation header; `#` comment lines. The grid must be complete, rectangular, regularly spaced and contain no duplicate coordinates. At most 1,000,000 cells / 40 MB. Web Mercator latitude coverage applies. Heights use bilinear interpolation; interpolation does not add source resolution. Void and out-of-extent height queries return unavailable. As with the existing HGT renderer, uncovered display mesh can be flat; it is not evidence of zero elevation. Source XYZ text and metadata are restored, but the local elevation source must be reselected after reopening the workspace. Keep the source file: FSS project JSON does not bundle terrain files.

## MPT and FLY

An MPT terrain database is not an MBTiles, GeoTIFF or browser XYZ-tile source. Renaming its extension, linking a Drive download, or copying its Windows DLLs does not make it readable by MapLibre. The inspected terrain header was MPT4; no working native decoder/export runtime was established here.

Skyline documents publication of MPT through SkylineGlobe Server and delivery via WMS/WMTS. For FSS's current WMS integration, obtain a compatible **HTTPS WMS 1.1.1 imagery endpoint**, actual layer identifier, source attribution, EPSG:3857 support, and browser CORS access. Add those under **Layers & data**. This supplies imagery only; it does not import MPT elevations or FLY scene objects. Use supported DEM exports or an additional compatible elevation service for terrain heights. Do not substitute a generic global basemap and label it as the imported MPT.

Official reference: [SkylineGlobe Server services](https://www.skylinesoft.com/KB_Resources/SGS/WebHelp/UserGuide/What_is_SkylineGlobe_Server.html).

## Validation

Automated checks cover source CRS requirements, sidecar validation, explicit geometry cleanup/simplification, regular-grid validation, feet conversion, zeros/voids, bilinear height interpolation, coverage errors, route sampling, import controls, device persistence and workspace switching. Existing Python and JavaScript regression suites are retained. Source samples were also exercised locally; tests using an explicitly assumed CRS verify code paths only and do not establish a dataset's actual datum.

Renderer-adapter tests do not verify physical GPU rendering, live map providers, a Skyline server, native QGIS plugins, receiver accuracy or desktop SAAS behavior.
