"""Locally bundled map client; personal map data stays in the user's browser."""
from functools import lru_cache
from pathlib import Path
import json

import streamlit as st
import streamlit.components.v1 as components
from geodesy import (DSM_ZONES, DSM_ZONE_CATALOG, KALIANPUR_ZONE_CATALOG,
                     KALIANPUR_EPSG, ENHANCED_KALIANPUR_ZONES, kalianpur_crs, kalianpur_transformer)

ASSETS = Path(__file__).resolve().parent / 'map_assets'
VENDORS = ('maplibre-gl.js', 'geographiclib.js', 'proj4.js', 'mgrs.js', 'fflate.js', 'sql-asm.js', 'turf.js')


def map_config():
    """Export the installed EPSG projection and verified 3-parameter operation."""
    definitions = {}
    for zone in KALIANPUR_EPSG:
        crs = kalianpur_crs(zone)
        transformer = kalianpur_transformer(zone, inverse=True)
        shifts = [op for op in transformer.operations
                  if op.method_name == "Geocentric translations (geog2D domain)"]
        if len(shifts) != 1:
            raise ValueError(f"Browser datum operation requires review for {zone}.")
        shift = {p.name: p.value for p in shifts[0].params}
        params = {p.name: p.value for p in crs.coordinate_operation.params}
        if crs.coordinate_operation.method_name != "Lambert Conic Conformal (1SP)":
            raise ValueError(f"Browser projection requires review for {zone}.")
        lat = params["Latitude of natural origin"]
        definition = (
            f"+proj=lcc +lat_0={lat} +lat_1={lat} +lon_0={params['Longitude of natural origin']} "
            f"+k_0={params['Scale factor at natural origin']} "
            f"+x_0={params['False easting']} +y_0={params['False northing']} "
            f"+a={crs.ellipsoid.semi_major_metre} +rf={crs.ellipsoid.inverse_flattening} "
            f"+towgs84={shift['X-axis translation']},{shift['Y-axis translation']},{shift['Z-axis translation']} "
            "+units=m +no_defs"
        )
        definitions[zone] = {**ENHANCED_KALIANPUR_ZONES[zone], "def": definition,
                             "accuracy": transformer.accuracy}
    return {"dsm": DSM_ZONES, "catalog": list(DSM_ZONE_CATALOG),
            "kalianpur": definitions, "kalianpurCatalog": list(KALIANPUR_ZONE_CATALOG)}


@lru_cache(maxsize=1)
def map_html():
    config = map_config()
    page = (ASSETS / 'index.html').read_text()
    styles = '\n'.join((ASSETS / p).read_text() for p in ('vendor/maplibre-gl.css', 'style.css'))
    scripts = '\n'.join((ASSETS / 'vendor' / p).read_text() for p in VENDORS)
    scripts += '\nwindow.FSS_CONFIG = ' + json.dumps(config).replace('<', '\\u003c') + ';\n'
    scripts += '\n'.join((ASSETS / p).read_text() for p in ('core.js', 'files.js', 'advanced-core.js', 'advanced.js', 'app.js'))
    # Vendor bundles can contain literal HTML strings. Escape closing script tags.
    scripts = scripts.replace('</script', '<\\/script')
    return page.replace('/* FSS_STYLES */', styles).replace('/* FSS_SCRIPTS */', scripts)


def render_map_workspace():
    st.subheader('Map')
    view = st.radio('Map workspace', ['Field workspace', 'Google Maps'], horizontal=True, key='map_engine')
    if view == 'Google Maps':
        from google_workspace import render_google_workspace
        render_google_workspace()
        return
    from simple_map import simple_map_html
    page = simple_map_html(map_config())
    if hasattr(st, "iframe"):
        st.iframe(page, height=980)
    else:
        components.html(page, height=980, scrolling=True)
