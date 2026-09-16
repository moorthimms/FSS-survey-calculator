import io
from pathlib import Path
import unittest
from unittest.mock import patch

from streamlit.testing.v1 import AppTest


APP = str(Path(__file__).resolve().parents[1] / "app.py")


def labeled(elements, label):
    return next(element for element in elements if element.label == label)


class AppDsmTests(unittest.TestCase):
    def setUp(self):
        self.app = AppTest.from_file(APP).run(timeout=20)
        self.assertFalse(self.app.exception)

    def test_wgs84_to_dsm_uses_full_zone_parameters(self):
        self.app.selectbox("forward_grid_system").select("DSM (WGS84 LCC)").run()
        labeled(self.app.button, "Convert to Grid").click().run()
        self.assertFalse(self.app.error)
        result = next(x.value for x in self.app.markdown if "DSM Grid Result" in x.value)
        self.assertIn("6D", result)
        self.assertIn("310,676.547", result)
        self.assertIn("203,340.560", result)
        self.assertNotIn("EPSG:", result)

    def test_dsm_inverse_uses_the_selected_zone(self):
        self.app.selectbox("dsm_latlon_source").select("8E")
        labeled(self.app.button, "Convert DSM -> Lat/Lon").click().run()
        self.assertFalse(self.app.error)
        result = next(x.value for x in self.app.success if "DSM 8E" in x.value)
        self.assertIn("27.00695556", result)
        self.assertIn("96.00000000", result)

    def test_esm_and_dsm_conversion_screens_work(self):
        labeled(self.app.button, "Convert ESM -> DSM").click().run()
        self.assertFalse(self.app.error)
        self.assertTrue(any("DSM Grid Result (6D)" in x.value for x in self.app.markdown))
        labeled(self.app.button, "Convert DSM -> ESM").click().run()
        self.assertFalse(self.app.error)
        self.assertTrue(any("ESM Grid Result (Zone I, EPSG:24378)" in x.value for x in self.app.success))
        self.assertTrue(any("expected accuracy: 22 m" in x.value for x in self.app.caption))

    def test_unsupported_esm_result_does_not_fall_back_to_zone_i(self):
        self.app.selectbox("dsm_esm_source").select("6C")
        labeled(self.app.button, "Convert DSM -> ESM").click().run()
        self.assertTrue(any("Outside supported Kalianpur" in x.value for x in self.app.error))
        self.assertFalse(any("ESM Grid Result" in x.value for x in self.app.success))

    def test_ambiguous_dsm_auto_zone_requires_a_selection(self):
        self.app.selectbox("forward_grid_system").select("DSM (WGS84 LCC)").run()
        labeled(self.app.text_input, "Lat (Deg)").input("30")
        labeled(self.app.text_input, "Lon (Deg)").input("78")
        labeled(self.app.button, "Convert to Grid").click().run()
        self.assertTrue(any("Select the DSM zone" in x.value for x in self.app.error))
        self.app.selectbox("forward_dsm_zone").select("6D")
        labeled(self.app.button, "Convert to Grid").click().run()
        self.assertFalse(self.app.error)
        self.assertTrue(any("DSM Grid Result (6D)" in x.value for x in self.app.markdown))

    def test_batch_dsm_inverse_uses_selected_source_and_rejects_nan(self):
        csv = "easting,northing,point_id\n500000,500000,P1\nnan,500000,P2\n"
        with patch("streamlit.file_uploader", side_effect=lambda *a, **k: io.StringIO(csv)):
            self.app.selectbox("batch_operation").select("DSM grid -> WGS84").run()
            self.app.selectbox("batch_dsm_source").select("8E")
            labeled(self.app.button, "Start Batch Processing (Grid -> Lat/Lon)").click().run()
        self.assertFalse(self.app.exception)
        results = self.app.dataframe[-1].value
        self.assertEqual(results.iloc[0]["source_zone"], "8E")
        self.assertAlmostEqual(results.iloc[0]["lat"], 27 + 25.04/3600, delta=1e-10)
        self.assertAlmostEqual(results.iloc[0]["lon"], 96, delta=1e-10)
        self.assertTrue(results.iloc[1]["status"].startswith("Error:"))

    def test_batch_wgs84_to_dsm_includes_zone_and_rejects_missing_coverage(self):
        csv = "lat,lon,point_id\n30.3165,78.0322,P1\n39,88,P2\n"
        with patch("streamlit.file_uploader", side_effect=lambda *a, **k: io.StringIO(csv)):
            self.app.selectbox("batch_operation").select("WGS84 -> DSM grid").run()
            labeled(self.app.button, "Start Batch Processing").click().run()
        self.assertFalse(self.app.exception)
        results = self.app.dataframe[-1].value
        self.assertEqual(results.iloc[0]["target_zone"], "6D")
        self.assertAlmostEqual(results.iloc[0]["easting"], 310676.546960736, delta=.001)
        self.assertTrue(results.iloc[1]["status"].startswith("Error:"))

    def test_both_esm_dsm_batch_directions(self):
        cases = [
            ("Kalianpur grid -> DSM grid", "3877983.50,756073.40", "6D"),
            ("DSM grid -> Kalianpur grid", "500000,500000", "Zone I"),
        ]
        for operation, coordinates, target in cases:
            with self.subTest(operation=operation):
                csv = f"easting,northing\n{coordinates}\n"
                with patch("streamlit.file_uploader", side_effect=lambda *a, **k: io.StringIO(csv)):
                    self.app.selectbox("batch_operation").select(operation).run()
                    labeled(self.app.button, "Start Batch Processing").click().run()
                self.assertFalse(self.app.exception)
                result = self.app.dataframe[-1].value.iloc[0]
                self.assertEqual(result["status"], "Success")
                self.assertEqual(result["target_zone"], target)
                self.assertEqual(result["datum_accuracy_m"], 22)

    def test_own_position_can_show_dsm_outside_kalianpur_coverage(self):
        location = {"coords": {"latitude": 7.9, "longitude": 77, "accuracy": 5}}
        with patch("streamlit_js_eval.streamlit_js_eval", return_value=location):
            self.app.checkbox("get_pos_checkbox").check().run()
        self.assertFalse(self.app.exception)
        self.assertEqual([x.label for x in self.app.metric],
                         ["Latitude (DD)", "Longitude (DD)", "DSM Easting", "DSM Northing"])
        self.assertTrue(any("**DSM zone:** 6H" in x.value for x in self.app.markdown))

    def test_reference_displays_only_supplied_rows_and_precise_scales(self):
        labeled(self.app.radio, "Select System").set_value("DSM (WGS84 LCC)").run()
        self.assertFalse(self.app.exception)
        table = self.app.dataframe[-1].value
        self.assertEqual(len(table), 18)
        self.assertEqual(table.iloc[0]["Latitude of origin (D M S, N)"], "39 00 39.60")
        self.assertEqual(table.iloc[0]["Central scale (reference)"], "0.9993035")
        self.assertNotIn("7C", table["Zone"].tolist())


if __name__ == "__main__":
    unittest.main()
