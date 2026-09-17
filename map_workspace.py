"""Locally bundled map client; personal map data stays in the user's browser."""
from functools import lru_cache
from pathlib import Path
import json

import streamlit as st
import streamlit.components.v1 as components
from geodesy import DSM_ZONES, DSM_ZONE_CATALOG

ASSETS = Path(__file__).resolve().parent / 'map_assets'
VENDORS = ('maplibre-gl.js', 'geographiclib.js', 'proj4.js', 'mgrs.js', 'fflate.js', 'sql-asm.js')


@lru_cache(maxsize=1)
def map_html():
    config = {"dsm": DSM_ZONES, "catalog": list(DSM_ZONE_CATALOG)}
    page = (ASSETS / 'index.html').read_text()
    styles = '\n'.join((ASSETS / p).read_text() for p in ('vendor/maplibre-gl.css', 'style.css'))
    scripts = '\n'.join((ASSETS / 'vendor' / p).read_text() for p in VENDORS)
    scripts += '\nwindow.FSS_CONFIG = ' + json.dumps(config).replace('<', '\\u003c') + ';\n'
    scripts += '\n'.join((ASSETS / p).read_text() for p in ('core.js', 'files.js', 'app.js'))
    # Vendor bundles can contain literal HTML strings. Escape closing script tags.
    scripts = scripts.replace('</script', '<\\/script')
    return page.replace('/* FSS_STYLES */', styles).replace('/* FSS_SCRIPTS */', scripts)


def render_map_workspace():
    st.subheader('Map · Field workspace')
    st.caption('Mark, measure, record and navigate. Open the map tools below. GPS uses the device connected to this browser.')
    with st.expander('Offline workspace and field guidance'):
        st.download_button('Download offline map workspace', map_html(), 'fss-map.html', 'text/html', key='offline_map_app')
        st.markdown('Open the downloaded HTML to use map tools without Streamlit. Import raster **MBTiles** and **HGT** terrain locally; export a project backup before changing devices. GPS and compass require browser permission and a secure context (HTTPS or localhost); support for local HTML varies by browser. Keep the map open while recording. Native Android A-GPS reset, battery permissions and background GPS are controlled by the operating system.')
    if hasattr(st, "iframe"):
        st.iframe(map_html(), height=900)
    else:  # Compatibility with the existing Streamlit >=1.37 requirement.
        components.html(map_html(), height=900, scrolling=True)
