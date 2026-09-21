import unittest
from html.parser import HTMLParser
from simple_map import simple_map_html

class SimpleMapTests(unittest.TestCase):
    def test_compact_ui_and_script_escaping(self):
        page=simple_map_html({},token='</script><script>bad</script>')
        self.assertNotIn('</script><script>bad',page)
        self.assertNotIn('id="map-toolbar"',page)
        self.assertNotIn('id="panel-select"',page)
        self.assertNotIn('Field tools',page)
        self.assertIn('Measure A',page)
        self.assertIn('leaflet',page)
        self.assertNotIn('/* SIMPLE_JS */',page)
        class Parser(HTMLParser):
            def __init__(self):super().__init__();self.ids=[]
            def handle_starttag(self,tag,attrs):
                d=dict(attrs)
                if 'id' in d:self.ids.append(d['id'])
        p=Parser();p.feed(page);self.assertEqual(len(p.ids),len(set(p.ids)))
