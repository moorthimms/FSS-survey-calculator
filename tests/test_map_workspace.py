import hashlib
import json
from pathlib import Path
import unittest
from html.parser import HTMLParser

from map_workspace import ASSETS, map_html


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.external_scripts = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if 'id' in attributes:
            self.ids.append(attributes['id'])
        if tag == 'script' and 'src' in attributes:
            self.external_scripts.append(attributes['src'])


class MapWorkspaceTests(unittest.TestCase):
    def test_generated_workspace_is_self_contained_and_has_no_duplicate_controls(self):
        html = map_html()
        parser = PageParser()
        parser.feed(html)
        self.assertFalse(parser.external_scripts)
        self.assertEqual(len(parser.ids), len(set(parser.ids)))
        self.assertIn('profile-y2', parser.ids)
        self.assertIn('hgt-files', parser.ids)
        self.assertIn('mbtiles-file', parser.ids)
        self.assertNotIn('/* FSS_SCRIPTS */', html)
        self.assertNotIn('/* FSS_STYLES */', html)

    def test_vendor_assets_match_recorded_digests(self):
        manifest = json.loads((ASSETS / 'vendor' / 'manifest.json').read_text())
        for name, metadata in manifest.items():
            with self.subTest(asset=name):
                actual = hashlib.sha256((ASSETS / 'vendor' / name).read_bytes()).hexdigest()
                self.assertEqual(actual, metadata['sha256'])

    def test_map_uses_the_existing_catalog_and_supplied_dsm_table(self):
        from geodesy import DSM_ZONE_CATALOG, DSM_ZONES
        html = map_html()
        marker = 'window.FSS_CONFIG = '
        config, _ = json.JSONDecoder().raw_decode(html.split(marker, 1)[1])
        self.assertEqual(config['catalog'], list(DSM_ZONE_CATALOG))
        self.assertEqual(config['dsm'], DSM_ZONES)

    def test_user_geometry_is_not_interpolated_into_executable_html(self):
        # Personal points enter through browser-side DOM/file handlers, not a
        # server HTML template or session-state string interpolation.
        source = (Path(__file__).resolve().parents[1] / 'map_workspace.py').read_text()
        self.assertNotIn('session_state', source)
        self.assertNotIn('file_uploader', source)


if __name__ == '__main__':
    unittest.main()
