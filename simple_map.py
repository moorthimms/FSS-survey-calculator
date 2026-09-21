"""Compact multi-provider map page; the legacy workbench remains recoverable in code."""
import json
import os
from pathlib import Path

ASSETS = Path(__file__).resolve().parent / 'map_assets'


def simple_map_html(grid_config, token=None):
    public_token = os.environ.get('MAPBOX_PUBLIC_TOKEN', '') if token is None else token
    if public_token.startswith('sk.'):
        public_token = ''  # Never send a secret Mapbox token to a browser.
    config = {'grids': grid_config,
              'mapboxToken': public_token,
              'routingUrl': os.environ.get('FSS_ROUTING_URL', 'https://router.project-osrm.org/route/v1/driving'),
              'vectorStyle': os.environ.get('FSS_VECTOR_STYLE_URL', 'https://tiles.openfreemap.org/styles/liberty')}
    styles = '\n'.join((ASSETS / 'vendor' / name).read_text() for name in ('maplibre-gl.css', 'leaflet.css'))
    scripts = '\n'.join((ASSETS / 'vendor' / name).read_text() for name in ('maplibre-gl.js', 'leaflet.js', 'geographiclib.js', 'proj4.js', 'mgrs.js'))
    scripts += '\nwindow.SIMPLE_CONFIG=' + json.dumps(config).replace('<', '\\u003c') + ';\n'
    scripts += (ASSETS / 'core.js').read_text() + '\n' + (ASSETS / 'simple.js').read_text()
    return (ASSETS / 'simple.html').read_text().replace('/* VENDOR_CSS */', styles).replace('/* SIMPLE_JS */', scripts.replace('</script', '<\\/script'))
