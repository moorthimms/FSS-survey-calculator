import unittest
from unittest.mock import patch

from geodesy import (
    DSM_ZONE_CATALOG, KALIANPUR_ZONE_CATALOG, dsm_crs, kalianpur_crs,
    original_identifier_name, zone_reference_rows,
)


class ZoneCatalogTests(unittest.TestCase):
    def test_every_original_identifier_is_preserved(self):
        expected_kalianpur = dict(zip(
            ["Zone I", "Zone IIa", "Zone IIb", "Zone IIIa", "Zone IIIb",
             "Zone IVa", "Zone IVb", "Zone Va", "Zone Vb"],
            range(24378, 24387),
        ))
        self.assertEqual({z: p["epsg"] for z, p in KALIANPUR_ZONE_CATALOG.items()},
                         expected_kalianpur)
        expected_dsm = {
            "5C": 2001, "5D": 2007, "5E": 2013, "5F": 2019, "5G": 2025, "5H": 2031,
            "6C": 2002, "6D": 2008, "6E": 2014, "6F": 2020, "6G": 2026, "6H": 2032,
            "7C": 2003, "7D": 2009, "7E": 2015, "7F": 2021, "7G": 2027, "7H": 2033,
            "8C": 2004, "8D": 2010, "8E": 2016, "8F": 2022, "8G": 2028, "8H": 2034,
        }
        self.assertEqual({z: p["epsg"] for z, p in DSM_ZONE_CATALOG.items()}, expected_dsm)

    def test_missing_definitions_never_reach_the_projection_engine(self):
        cases = [
            (kalianpur_crs, KALIANPUR_ZONE_CATALOG, ["Zone IIIb", "Zone IVb", "Zone Va", "Zone Vb"]),
            (dsm_crs, DSM_ZONE_CATALOG, ["7C", "7D", "7G", "7H", "8C", "8D"]),
        ]
        with patch("geodesy.CRS.from_epsg", side_effect=AssertionError("Unrelated CRS used")):
            for build_crs, catalog, zones in cases:
                for zone in zones:
                    with self.subTest(zone=zone), self.assertRaises(ValueError) as caught:
                        build_crs(zone)
                    self.assertIn("Parameters required", str(caught.exception))
                    self.assertIn(f"EPSG:{catalog[zone]['epsg']}", str(caught.exception))

    def test_reference_distinguishes_original_id_from_calculation(self):
        dsm = {row["Zone"]: row for row in zone_reference_rows("DSM")}
        self.assertEqual(dsm["5C"]["Original identifier"], "EPSG:2001")
        self.assertIn("Antigua", dsm["5C"]["Registry meaning of original identifier"])
        self.assertIn("WGS84 / LCC", dsm["5C"]["Conversion definition"])
        self.assertEqual(sum(row["Status"] == "Ready" for row in dsm.values()), 18)
        kalianpur = zone_reference_rows("Kalianpur 1975")
        self.assertEqual(sum(row["Status"] == "Ready" for row in kalianpur), 5)
        self.assertEqual(original_identifier_name(24382), "Kalianpur 1880 / India zone IIb")
        self.assertIn("No CRS record", original_identifier_name(24384))


if __name__ == "__main__":
    unittest.main()
