import unittest
from pathlib import Path
from google_workspace import google_html
from streamlit.testing.v1 import AppTest

class GoogleWorkspaceTests(unittest.TestCase):
    def test_browser_configuration_cannot_close_script(self):
        html=google_html('</script><script>alert(1)</script>')
        self.assertNotIn('</script><script>alert',html)
        self.assertIn('\\u003c/script>',html)
        self.assertEqual(html.count('</script>'),1)
        self.assertNotIn('/* GOOGLE_SCRIPT */',html)

    def test_google_menu_without_credentials_renders(self):
        app=AppTest.from_file(str(Path(__file__).resolve().parents[1] / 'app.py'),default_timeout=30).run()
        app.radio('app_menu').set_value('Map').run()
        app.radio('map_engine').set_value('Google Maps').run()
        self.assertFalse(list(app.exception))
        app.radio('map_engine').set_value('Field workspace').run()
        self.assertFalse(list(app.exception))
