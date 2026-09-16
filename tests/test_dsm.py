"""Validate the image transcription and independently check LCC 2SP mathematics."""
from math import cos, log, pi, radians, sin, sqrt, tan
import unittest

from pyproj import CRS, Proj

from geodesy import (
    DSM_ZONES, dsm_crs, dsm_to_kalianpur, dsm_to_wgs84, dsm_transformer,
    dsm_zone_candidates, kalianpur_to_dsm, wgs84_to_dsm, wgs84_to_kalianpur,
)


def reference_lcc(lat, lon, p):
    """Independent scalar implementation of the EPSG 9802 equations.

    https://gdal.org/en/stable/proj_list/lambert_conic_conformal_2sp.html
    WGS84 a=6378137 m, inverse flattening=298.257223563.
    """
    a, f = 6378137.0, 1 / 298.257223563
    eccentricity = sqrt(2 * f - f * f)

    def m(phi):
        return cos(phi) / sqrt(1 - eccentricity**2 * sin(phi)**2)

    def t(phi):
        return tan(pi / 4 - phi / 2) / (
            (1 - eccentricity * sin(phi)) / (1 + eccentricity * sin(phi))
        )**(eccentricity / 2)

    phi1, phi2 = radians(p["standard_parallel_1"]), radians(p["standard_parallel_2"])
    n = (log(m(phi1)) - log(m(phi2))) / (log(t(phi1)) - log(t(phi2)))
    F = m(phi1) / (n * t(phi1)**n)
    rho0 = a * F * t(radians(p["latitude_of_origin"]))**n
    rho = a * F * t(radians(lat))**n
    theta = n * radians(lon - p["longitude_of_origin"])
    return 500000 + rho * sin(theta), 500000 + rho0 - rho * cos(theta)


class DsmTests(unittest.TestCase):
    def test_transcription_matches_all_eighteen_image_rows(self):
        expected_zones = ["5C", "5D", "5E", "5F", "5G", "5H", "6C", "6D", "6E",
                          "6F", "6G", "6H", "7E", "7F", "8E", "8F", "8G", "8H"]
        bands = {
            "C": ("39 00 39.60", "36 51 26", "41 08 34", .9993035),
            "D": ("33 00 31.84", "30 51 26", "35 08 34", .9993040),
            "E": ("27 00 25.04", "24 51 26", "29 08 34", .9993044),
            "F": ("21 00 18.90", "18 51 26", "23 08 34", .9993048),
            "G": ("15 00 13.21", "12 51 26", "17 08 34", .9993051),
            "H": ("09 00 07.82", "06 51 26", "11 08 34", .9993053),
        }
        self.assertEqual(list(DSM_ZONES), expected_zones)
        for zone, p in DSM_ZONES.items():
            with self.subTest(zone=zone):
                self.assertEqual(p["longitude_of_origin"], {"5":72,"6":80,"7":88,"8":96}[zone[0]])
                self.assertEqual(tuple(p[k] for k in ["latitude_of_origin_dms", "standard_parallel_1_dms",
                                                     "standard_parallel_2_dms", "central_scale_factor_reference"]), bands[zone[1]])
                self.assertEqual((p["false_easting_m"], p["false_northing_m"]), (500000, 500000))
                self.assertNotIn("epsg", p)

    def test_every_origin_has_the_supplied_false_coordinates(self):
        origins = {"C":39 + 39.60/3600, "D":33 + 31.84/3600, "E":27 + 25.04/3600,
                   "F":21 + 18.90/3600, "G":15 + 13.21/3600, "H":9 + 7.82/3600}
        for zone in DSM_ZONES:
            with self.subTest(zone=zone):
                lat, lon = origins[zone[1]], {"5":72,"6":80,"7":88,"8":96}[zone[0]]
                z, e, n = wgs84_to_dsm(lat, lon, zone)
                self.assertEqual(z, zone)
                self.assertAlmostEqual(e, 500000, delta=1e-6)
                self.assertAlmostEqual(n, 500000, delta=1e-6)
                inverse_lon, inverse_lat = dsm_to_wgs84(500000, 500000, zone)
                self.assertAlmostEqual(inverse_lon, lon, delta=1e-10)
                self.assertAlmostEqual(inverse_lat, lat, delta=1e-10)

    def test_projection_is_wgs84_lcc_2sp_without_ballpark_datum_steps(self):
        for zone in DSM_ZONES:
            with self.subTest(zone=zone):
                crs = dsm_crs(zone)
                self.assertTrue(crs.geodetic_crs.equals(CRS.from_epsg(4326)))
                self.assertEqual(crs.coordinate_operation.method_name, "Lambert Conic Conformal (2SP)")
                self.assertTrue(all(axis.unit_name == "metre" for axis in crs.axis_info))
                for inverse in (False, True):
                    self.assertFalse(any(op.has_ballpark_transformation
                                         for op in dsm_transformer(zone, inverse).operations))

    def test_central_scale_matches_photo_and_parallels_keep_unit_scale(self):
        for zone, p in DSM_ZONES.items():
            with self.subTest(zone=zone):
                proj = Proj(dsm_crs(zone))
                scale = proj.get_factors(p["longitude_of_origin"], p["latitude_of_origin"]).meridional_scale
                self.assertAlmostEqual(scale, p["central_scale_factor_reference"], delta=5.1e-8)
                for parallel in [p["standard_parallel_1"], p["standard_parallel_2"]]:
                    self.assertAlmostEqual(proj.get_factors(p["longitude_of_origin"], parallel).meridional_scale,
                                           1.0, delta=1e-8)

    def test_independent_lcc_equations_and_roundtrips_for_each_zone(self):
        for zone, p in DSM_ZONES.items():
            for dy, dx in [(-2.8, -3.8), (1, 2), (2.8, 3.8)]:
                with self.subTest(zone=zone, offset=(dy, dx)):
                    lat, lon = p["latitude_of_origin"] + dy, p["longitude_of_origin"] + dx
                    expected_e, expected_n = reference_lcc(lat, lon, p)
                    _, e, n = wgs84_to_dsm(lat, lon, zone)
                    self.assertAlmostEqual(e, expected_e, delta=2e-6)
                    self.assertAlmostEqual(n, expected_n, delta=2e-6)
                    result_lon, result_lat = dsm_to_wgs84(e, n, zone)
                    self.assertAlmostEqual(result_lon, lon, delta=1e-10)
                    self.assertAlmostEqual(result_lat, lat, delta=1e-10)

    def test_nominal_auto_suggestion_requires_explicit_choice_on_boundaries(self):
        self.assertEqual(wgs84_to_dsm(30.3165, 78.0322)[0], "6D")
        self.assertEqual(dsm_zone_candidates(30, 78), ["6D", "6E"])
        for lat, lon in [(30, 78), (0, 0), (39, 88)]:
            with self.subTest(lat=lat, lon=lon), self.assertRaisesRegex(ValueError, "Select the DSM zone"):
                wgs84_to_dsm(lat, lon)
        self.assertEqual(wgs84_to_dsm(30, 78, "6D")[0], "6D")

    def test_unlisted_zones_and_invalid_numbers_are_rejected(self):
        for zone in ["7C", "7D", "7G", "7H", "8C", "8D", "9E", "2001"]:
            with self.subTest(zone=zone), self.assertRaisesRegex(ValueError, "Unsupported DSM"):
                dsm_to_wgs84(500000, 500000, zone)
        for bad in [None, "bad", float("nan"), float("inf"), float("-inf")]:
            for args in [(bad, 77), (10, bad)]:
                with self.subTest(args=args), self.assertRaises(ValueError):
                    wgs84_to_dsm(*args, "6H")
                with self.assertRaises(ValueError):
                    dsm_to_wgs84(*args, "6H")
        for args in [(91, 77), (10, 181), (90, 80), (-90, 80)]:
            with self.assertRaises(ValueError):
                wgs84_to_dsm(*args, "6D")

    def test_esm_dsm_chains_preserve_axes_and_source_zone(self):
        for lat, lon, dsm_zone in [(30.3165, 78.0322, "6D"), (25, 75, "5E"),
                                    (26, 92, "8E"), (18, 78, "6F"), (10, 77, "6H")]:
            with self.subTest(lat=lat, lon=lon):
                esm_zone, code, e, n = wgs84_to_kalianpur(lat, lon)
                _, de, dn = kalianpur_to_dsm(e, n, esm_zone, dsm_zone)
                _, direct_e, direct_n = wgs84_to_dsm(lat, lon, dsm_zone)
                self.assertAlmostEqual(de, direct_e, delta=.01)
                self.assertAlmostEqual(dn, direct_n, delta=.01)
                result_zone, result_code, ee, en = dsm_to_kalianpur(de, dn, dsm_zone)
                self.assertEqual((result_zone, result_code), (esm_zone, code))
                self.assertAlmostEqual(ee, e, delta=.01)
                self.assertAlmostEqual(en, n, delta=.01)

    def test_dsm_to_esm_does_not_fall_back_for_unsupported_kalianpur_coverage(self):
        with self.assertRaisesRegex(ValueError, "Outside supported Kalianpur"):
            dsm_to_kalianpur(500000, 500000, "6C")


if __name__ == "__main__":
    unittest.main()
