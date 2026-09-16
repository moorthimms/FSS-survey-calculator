import unittest

from pyproj import CRS

from geodesy import (
    ENHANCED_KALIANPUR_ZONES, KALIANPUR_EPSG, detect_kalianpur_zone,
    kalianpur_crs, kalianpur_to_wgs84, kalianpur_transformer, wgs84_to_kalianpur,
)


# Numerical regressions from PROJ 9.8.1 / EPSG v12.029, not field control points.
REFERENCE_POINTS = (
    ("Zone I", 30.3165, 78.0322, 3706177.799422, 717909.404595),
    ("Zone IIa", 25.0, 75.0, 2844118.235115, 804102.817959),
    ("Zone IIb", 26.0, 92.0, 2943473.719722, 915875.877476),
    ("Zone IIIa", 18.0, 78.0, 2531777.657278, 804940.259546),
    ("Zone IVa", 10.0, 77.0, 2414647.898609, 695018.087787),
)


class GeodesyTests(unittest.TestCase):
    def test_identifiers_match_datum_zone_and_metre_units(self):
        for zone, code in KALIANPUR_EPSG.items():
            with self.subTest(zone=zone):
                crs = CRS.from_epsg(code)
                self.assertEqual(crs.name, f"Kalianpur 1975 / India zone {zone[5:]}")
                self.assertEqual(crs.datum.name, "Kalianpur 1975")
                self.assertTrue(all(axis.unit_name == "metre" for axis in crs.axis_info))

    def test_registry_meridians_replace_incorrect_legacy_metadata(self):
        expected = {"Zone I": 68, "Zone IIa": 74, "Zone IIb": 90,
                    "Zone IIIa": 80, "Zone IVa": 80}
        for zone, meridian in expected.items():
            self.assertEqual(ENHANCED_KALIANPUR_ZONES[zone]["central_meridian"], meridian)

    def test_forward_and_inverse_regression_points_for_every_zone(self):
        for zone, lat, lon, easting, northing in REFERENCE_POINTS:
            with self.subTest(zone=zone):
                actual_zone, code, e, n = wgs84_to_kalianpur(lat, lon)
                self.assertEqual(actual_zone, zone)
                self.assertEqual(code, KALIANPUR_EPSG[zone])
                self.assertAlmostEqual(e, easting, delta=0.002)
                self.assertAlmostEqual(n, northing, delta=0.002)
                result_lon, result_lat = kalianpur_to_wgs84(easting, northing, zone)
                self.assertAlmostEqual(result_lon, lon, delta=1e-7)
                self.assertAlmostEqual(result_lat, lat, delta=1e-7)

    def test_outside_coordinates_never_use_default_or_nearest_zone(self):
        for lat, lon in [(0, 0), (-33, 151), (7.9, 77), (10, 80.6),
                         (18, 87.3), (18, 95), (6, 84)]:
            with self.subTest(lat=lat, lon=lon):
                self.assertEqual(detect_kalianpur_zone(lat, lon), (None, None, None))
                with self.assertRaisesRegex(ValueError, "Outside supported"):
                    wgs84_to_kalianpur(lat, lon)

    def test_invalid_geographic_values_are_rejected(self):
        for lat, lon in [(None, 77), (float("nan"), 77), (10, float("inf")),
                         (float("-inf"), 77), (90.1, 77), (10, 181), ("bad", 77)]:
            with self.subTest(lat=lat, lon=lon):
                self.assertEqual(detect_kalianpur_zone(lat, lon), (None, None, None))
                with self.assertRaises(ValueError):
                    wgs84_to_kalianpur(lat, lon)

    def test_invalid_grid_values_are_rejected_in_both_axes(self):
        for value in [None, "bad", float("nan"), float("inf"), float("-inf")]:
            for e, n in [(value, 700000), (2400000, value)]:
                with self.subTest(e=e, n=n), self.assertRaisesRegex(ValueError, "finite"):
                    kalianpur_to_wgs84(e, n, "Zone IVa")

    def test_unregistered_or_wrong_datum_zone_labels_are_rejected(self):
        for zone in ["Zone IIIb", "Zone IVb", "Zone Va", "Zone Vb", "Zone I (Nearest)"]:
            with self.subTest(zone=zone), self.assertRaisesRegex(ValueError, "Unsupported"):
                kalianpur_crs(zone)

    def test_obviously_wrong_inverse_zone_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "area of use"):
            kalianpur_to_wgs84(2531777.657278, 804940.259546, "Zone I")

    def test_numerical_roundoff_at_coverage_edge_is_accepted(self):
        zone, _, e, n = wgs84_to_kalianpur(10, 80.4)
        lon, lat = kalianpur_to_wgs84(e, n, zone)
        self.assertAlmostEqual(lon, 80.4, delta=1e-7)
        self.assertAlmostEqual(lat, 10, delta=1e-7)

    def test_supported_operations_have_no_ballpark_datum_step(self):
        for zone in KALIANPUR_EPSG:
            for inverse in (False, True):
                with self.subTest(zone=zone, inverse=inverse):
                    transformer = kalianpur_transformer(zone, inverse)
                    self.assertGreaterEqual(transformer.accuracy, 0)
                    self.assertTrue(transformer.operations)
                    self.assertFalse(any(op.has_ballpark_transformation
                                         for op in transformer.operations))


if __name__ == "__main__":
    unittest.main()
