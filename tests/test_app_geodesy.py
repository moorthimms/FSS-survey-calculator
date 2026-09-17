import io
import time
from pathlib import Path
import unittest
from unittest.mock import patch

from streamlit.testing.v1 import AppTest


APP = str(Path(__file__).resolve().parents[1] / "app.py")


def labeled(elements, label):
    return next(element for element in elements if element.label == label)


class AppGeodesyTests(unittest.TestCase):
    def setUp(self):
        self.app = AppTest.from_file(APP).run(timeout=20)
        self.assertEqual(len(self.app.exception), 0)

    def test_all_tabs_render_and_supplied_dsm_actions_are_enabled(self):
        self.assertEqual(len(self.app.tabs), 14)
        for label in ["Convert ESM -> DSM", "Convert DSM -> Lat/Lon", "Convert DSM -> ESM"]:
            self.assertFalse(labeled(self.app.button, label).disabled)

    def test_source_selectors_preserve_all_original_zones(self):
        expected = ["Zone I", "Zone IIa", "Zone IIb", "Zone IIIa", "Zone IIIb",
                    "Zone IVa", "Zone IVb", "Zone Va", "Zone Vb"]
        for key in ["grid_to_latlon_zone", "batch_source_zone", "esm_dsm_source"]:
            self.assertEqual(self.app.selectbox(key).options, expected)

    def test_original_kalianpur_identifier_is_visible_with_missing_definition(self):
        self.app.selectbox("grid_to_latlon_zone").select("Zone IVb").run()
        table = self.app.dataframe[-1].value.set_index("Zone")
        self.assertEqual(len(table), 9)
        self.assertEqual(table.loc["Zone IVb", "Original identifier"], "EPSG:24384")
        self.assertEqual(table.loc["Zone IVb", "Status"], "Parameters required")
        labeled(self.app.button, "Convert to Lat/Lon").click().run()
        self.assertFalse(self.app.exception)
        self.assertTrue(any("EPSG:24384" in x.value and "Parameters required" in x.value
                            for x in self.app.error))
        self.assertFalse(any("WGS84 Result" in x.value for x in self.app.markdown))

    def test_batch_retains_unresolved_zone_in_each_row(self):
        csv = "point_id,easting,northing\nP1,500000,500000\nP2,501000,501000\n"
        with patch("streamlit.file_uploader", side_effect=lambda *a, **k: io.StringIO(csv)):
            self.app.run()
            self.app.selectbox("batch_source_zone").select("Zone IIIb")
            labeled(self.app.button, "Start Batch Processing (Grid -> Lat/Lon)").click().run()
        self.assertFalse(self.app.exception)
        results = next(x.value for x in self.app.dataframe if "status" in x.value.columns)
        self.assertEqual(results["source_zone"].tolist(), ["Zone IIIb", "Zone IIIb"])
        self.assertTrue(all("EPSG:24382" in status and "Parameters required" in status
                            for status in results["status"]))
        self.assertNotIn("lat", results.columns)

    def test_outside_and_nearby_unsupported_coordinates_do_not_produce_grid(self):
        for lat, lon in [(0, 0), (7.9, 77), (10, 80.6), (18, 87.3)]:
            with self.subTest(lat=lat, lon=lon):
                labeled(self.app.text_input, "Lat (Deg)").input(str(lat))
                labeled(self.app.text_input, "Lon (Deg)").input(str(lon))
                labeled(self.app.button, "Convert to Grid").click().run()
                self.assertEqual(len(self.app.exception), 0)
                self.assertTrue(any("Outside supported" in x.value for x in self.app.error))
                self.assertFalse(any("Indian Grid Result" in x.value for x in self.app.markdown))

    def test_supported_forward_conversion_reports_zone_and_accuracy(self):
        labeled(self.app.text_input, "Lat (Deg)").input("10")
        labeled(self.app.text_input, "Lon (Deg)").input("77")
        labeled(self.app.button, "Convert to Grid").click().run()
        self.assertEqual(len(self.app.error), 0)
        result = next(x.value for x in self.app.markdown if "Indian Grid Result" in x.value)
        self.assertIn("Zone IVa", result)
        self.assertIn("2,414,647.899", result)
        self.assertTrue(any("expected accuracy: 22 m" in x.value for x in self.app.caption))

    def test_inverse_uses_selected_zone(self):
        self.app.selectbox("grid_to_latlon_zone").select("Zone IVa")
        labeled(self.app.text_input, "Easting (m)").input("2414647.898609")
        labeled(self.app.text_input, "Northing (m)").input("695018.087787")
        labeled(self.app.button, "Convert to Lat/Lon").click().run()
        self.assertEqual(len(self.app.error), 0)
        result = next(x.value for x in self.app.markdown if "WGS84 Result" in x.value)
        self.assertIn("Zone IVa, EPSG:24383", result)
        self.assertIn("10.000000°", result)
        self.assertIn("77.000000°", result)

    def test_inverse_rejects_nonfinite_input(self):
        labeled(self.app.text_input, "Easting (m)").input("nan")
        labeled(self.app.button, "Convert to Lat/Lon").click().run()
        self.assertTrue(any("finite" in x.value for x in self.app.error))
        self.assertFalse(any("WGS84 Result" in x.value for x in self.app.markdown))

    def test_batch_rejects_nonfinite_and_out_of_area_rows(self):
        csv = ("point_id,easting,northing\n"
               "ok,2414647.898609,695018.087787\n"
               "nan,nan,695018.087787\n"
               "infinity,2414647.898609,inf\n"
               "outside,0,0\n")
        with patch("streamlit.file_uploader", side_effect=lambda *a, **k: io.StringIO(csv)):
            self.app.run()
            self.app.selectbox("batch_source_zone").select("Zone IVa")
            labeled(self.app.button, "Start Batch Processing (Grid -> Lat/Lon)").click().run()
        self.assertEqual(len(self.app.exception), 0)
        results = next(x.value for x in self.app.dataframe if "status" in x.value.columns)
        self.assertEqual(results.iloc[0]["status"], "Success")
        self.assertAlmostEqual(results.iloc[0]["lat"], 10, delta=1e-7)
        self.assertTrue(all(status.startswith("Error:") for status in results["status"].iloc[1:]))

    def test_own_position_outside_coverage_keeps_wgs84_without_grid_output(self):
        location = {"timestamp": time.time() * 1000, "coords": {"latitude": 0, "longitude": 0, "accuracy": 5}}
        with patch("streamlit_js_eval.streamlit_js_eval", return_value=location):
            self.app.checkbox("get_pos_checkbox").check().run()
        self.assertEqual(len(self.app.exception), 0)
        self.assertEqual([x.label for x in self.app.metric], ["Latitude (DD)", "Longitude (DD)"])
        self.assertTrue(any("Outside supported" in x.value for x in self.app.warning))
        self.assertTrue(any("DSM conversion unavailable" in x.value for x in self.app.warning))


if __name__ == "__main__":
    unittest.main()
