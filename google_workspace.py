"""Official Google Maps companion; no tile scraping or server-side key proxy."""
import json
import os
from pathlib import Path
import streamlit as st
import streamlit.components.v1 as components

ASSETS = Path(__file__).resolve().parent / 'map_assets'


def google_html(api_key='', map_id='', navigation_map_id='', experimental=False):
    config = {'key': api_key, 'mapId': map_id, 'navigationMapId': navigation_map_id,
              'experimental': bool(experimental)}
    script = 'window.GOOGLE_CONFIG=' + json.dumps(config).replace('<', '\\u003c') + ';\n'
    script += (ASSETS / 'google.js').read_text()
    return (ASSETS / 'google.html').read_text().replace('/* GOOGLE_SCRIPT */', script.replace('</script', '<\\/script'))


def render_google_workspace():
    st.caption('Google Maps · search, routes and 3D exploration. Survey editing remains in the Field workspace.')
    key = os.environ.get('GOOGLE_MAPS_BROWSER_KEY', '')
    if not key:
        st.info('To load Google maps here, configure GOOGLE_MAPS_BROWSER_KEY on the host. Coordinate validation and Open in Google Maps links work without a key.')
    page = google_html(key, os.environ.get('GOOGLE_MAPS_MAP_ID', ''),
                       os.environ.get('GOOGLE_MAPS_NAVIGATION_MAP_ID', ''),
                       os.environ.get('GOOGLE_MAPS_EXPERIMENTAL', '') == '1')
    if hasattr(st, 'iframe'):
        st.iframe(page, height=920)
    else:
        components.html(page, height=920, scrolling=True)
    with st.expander('Google service setup'):
        st.markdown('Use a browser API key restricted to the deployed website referrer and required Google APIs. Enable **Maps JavaScript API**, **Geocoding API** and **Routes API** with billing. Browser keys are visible by design; do not use a server secret. Optional `GOOGLE_MAPS_MAP_ID` configures cloud styling; `GOOGLE_MAPS_NAVIGATION_MAP_ID` must reference your navigation-style map. `GOOGLE_MAPS_EXPERIMENTAL=1` opts into the alpha channel and experimental 3D roadmap. Searches, map views and route endpoints are sent to Google when used. Google content is not included in offline map downloads.')
