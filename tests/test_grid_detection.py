"""Independent PROJ/proj4js parity and conservative source-zone detection."""
import json
import subprocess
import unittest
from pathlib import Path
from geodesy import (AUTO_SOURCE_ZONE, inverse_zone_candidates, resolve_source_zone,
                     kalianpur_transformer, dsm_to_wgs84)
from map_workspace import map_config

ROOT = Path(__file__).resolve().parents[1]


class GridDetectionTests(unittest.TestCase):
    def test_browser_kalianpur_agrees_with_proj_in_all_five_zones(self):
        config = map_config()
        cases = []
        for zone, definition in config['kalianpur'].items():
            self.assertEqual(definition['accuracy'], 22)
            self.assertIn('+towgs84=295.0,736.0,257.0', definition['def'])
            b = definition['bounds']
            for f in [.05, .5, .95]:
                p = [b['lon_min'] + (b['lon_max']-b['lon_min'])*f,
                     b['lat_min'] + (b['lat_max']-b['lat_min'])*f]
                grid = kalianpur_transformer(zone).transform(*p)
                # Compare inverse with PROJ rather than assuming datum shift is
                # perfectly reversible after discarding the ellipsoid height.
                inverse = kalianpur_transformer(zone, inverse=True).transform(*grid)
                cases.append(dict(zone=zone, p=p, grid=grid, inverse=inverse))
        script = r'''
const fs=require('fs'), assert=require('assert/strict');
const C=require('./map_assets/core'), proj4=require('./map_assets/vendor/proj4');
const {config,cases}=JSON.parse(fs.readFileSync(0,'utf8'));
for (const c of cases) {
 const def=C.projection('Kalianpur '+c.zone,c.p,config).def;
 const grid=proj4('EPSG:4326',def,c.p);
 grid.forEach((x,i)=>assert.ok(Math.abs(x-c.grid[i])<.001));
 const inverse=C.parsePosition(c.grid.join(','),'Kalianpur '+c.zone,config);
 inverse.forEach((x,i)=>assert.ok(Math.abs(x-c.inverse[i])<1e-8));
 assert.ok(C.zoneCandidates(c.p,'Kalianpur',config).includes(c.zone));
 assert.equal(C.formatCoord([...c.p,5000],'Kalianpur '+c.zone,config), C.formatCoord(c.p,'Kalianpur '+c.zone,config));
}
assert.equal(C.zoneCandidates([0,0],'Kalianpur',config).length,0);
assert.equal(C.inverseCandidates('500000,500000','DSM',config).length,18);
assert.throws(()=>C.formatCoord([88,39],'DSM 7C',config),/parameters required/);
assert.throws(()=>C.formatCoord([78,30],'Kalianpur Zone IVb',config),/parameters required/);
assert.match(C.autoReferences([78,30],'DSM',config),/overlapping candidates/);
'''
        result = subprocess.run(['node', '-e', script], input=json.dumps(dict(config=config, cases=cases)),
                                text=True, capture_output=True, cwd=ROOT, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_dsm_false_origin_has_18_candidates_and_never_defaults(self):
        candidates = inverse_zone_candidates('DSM', 500000, 500000)
        self.assertEqual(len(candidates), 18)
        for c in candidates:
            lon, lat = dsm_to_wgs84(500000, 500000, c['zone'])
            self.assertEqual((lon, lat), (c['longitude'], c['latitude']))
        with self.assertRaisesRegex(ValueError, 'Ambiguous source zone'):
            resolve_source_zone('DSM', 500000, 500000, AUTO_SOURCE_ZONE)
        self.assertEqual(resolve_source_zone('DSM', 500000, 500000, '8E'), '8E')

    def test_unique_kalianpur_source_is_resolved(self):
        e, n = kalianpur_transformer('Zone I').transform(77, 35)
        self.assertEqual(resolve_source_zone('Kalianpur 1975', e, n, AUTO_SOURCE_ZONE), 'Zone I')
        candidates = inverse_zone_candidates('Kalianpur 1975', e, n)
        self.assertEqual(len(candidates), 1)
        self.assertAlmostEqual(candidates[0]['latitude'], 35, places=6)
        self.assertAlmostEqual(candidates[0]['longitude'], 77, places=6)

    def test_invalid_values_and_no_coverage_cannot_autoselect(self):
        for e in [float('nan'), float('inf'), None]:
            with self.assertRaises(ValueError):
                inverse_zone_candidates('DSM', e, 0)
        with self.assertRaisesRegex(ValueError, 'No supported source zone'):
            resolve_source_zone('Kalianpur 1975', -1e9, -1e9, AUTO_SOURCE_ZONE)
        self.assertNotIn('Zone IVb', [c['zone'] for c in inverse_zone_candidates('Kalianpur 1975', 2414647, 695018)])

if __name__ == '__main__':
    unittest.main()
