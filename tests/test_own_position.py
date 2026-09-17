import copy
import os
from pathlib import Path
import time
import unittest
from unittest.mock import patch

from streamlit.testing.v1 import AppTest

from own_position import browser_coordinates, gnss_dms


APP = str(Path(__file__).resolve().parents[1] / "app.py")
EXTERNAL = "External RTK receiver (local USB/Bluetooth)"


def labeled(elements, label):
    return next(element for element in elements if element.label == label)


class FakeReceiver:
    def __init__(self):
        self.closed = False
        self.calls = 0
        self.fail_after = None
        self.state = {"connected": True, "ntrip_enabled": False, "ntrip_status": "Receiver supplies its own corrections",
                      "rtcm_bytes": 0, "last_rtcm_at": None, "invalid_sentences": 0, "receiver_error": None,
                      "fix": {"fresh": True, "age_s": 0.1, "quality": 4, "fix_label": "RTK FIX (receiver reported)",
                              "latitude": 30.3165, "longitude": 78.0322, "satellites": 18, "hdop": 0.8,
                              "correction_age_s": 1.0, "station_id": "0123", "horizontal_sigma_rss_m": 0.014,
                              "height_sigma_m": 0.025, "altitude_msl_m": 100.0, "geoid_separation_m": -30.0,
                              "altitude_ellipsoid_m": 70.0, "received_at": time.time(), "epoch_timestamp": time.time()}}

    def snapshot(self):
        self.calls += 1
        result = copy.deepcopy(self.state)
        if self.fail_after and self.calls >= self.fail_after:
            result["fix"]["quality"] = 5
        return result

    def close(self):
        self.closed = True
        self.state["connected"] = False


class PositionValidationTests(unittest.TestCase):
    def test_browser_freshness_numbers_and_accuracy(self):
        loc = {"coords": {"latitude": 30, "longitude": 78, "accuracy": 5}, "timestamp": 100000}
        self.assertEqual(browser_coordinates(loc, now=100), (30, 78, 5, 100))
        for bad in [dict(loc, timestamp=0), dict(loc, timestamp=200000), dict(loc, timestamp=float("nan")),
                    {"coords": {"latitude": 91, "longitude": 78, "accuracy": 1}, "timestamp": 100000},
                    {"coords": {"latitude": 30, "longitude": 78, "accuracy": -1}, "timestamp": 100000},
                    {"coords": loc["coords"]}]:
            with self.subTest(location=bad), self.assertRaises(ValueError):
                browser_coordinates(bad, now=100)

    def test_dms_keeps_rtk_precision_and_carries_roundoff(self):
        self.assertEqual(gnss_dms(30.3165, True), "30°18′59.4000″N")
        self.assertEqual(gnss_dms(-78.0322, False), "78°01′55.9200″W")
        self.assertEqual(gnss_dms(10 + 59/60 + 59.999999/3600, True), "11°00′00.0000″N")


class OwnPositionAppTests(unittest.TestCase):
    def setUp(self):
        self.app = AppTest.from_file(APP).run(timeout=20)
        self.assertFalse(self.app.exception)

    def external(self, receiver=None):
        self.app.radio("position_source").set_value(EXTERNAL)
        if receiver:
            self.app.session_state["live_receiver"] = receiver
        self.app.run()
        self.assertFalse(self.app.exception)

    def test_hosted_app_explains_hardware_location_without_opening_ports(self):
        with patch.dict(os.environ, {"FSS_ENABLE_LOCAL_GNSS": "0"}), patch("own_position.LiveReceiver") as connect:
            self.external()
            connect.assert_not_called()
        self.assertEqual(len(self.app.tabs), 14)
        self.assertTrue(any("hosted server" in x.value for x in self.app.info))

    def test_browser_error_does_not_stop_other_tabs(self):
        with patch("streamlit_js_eval.streamlit_js_eval", return_value={"error": {"code": 1}}):
            self.app.checkbox("get_pos_checkbox").check().run()
        self.assertFalse(self.app.exception)
        self.assertEqual(len(self.app.tabs), 14)
        self.assertTrue(any("Could not retrieve location" in x.value for x in self.app.warning))
        self.assertTrue(self.app.dataframe)

    def test_stale_browser_fix_is_not_converted(self):
        location = {"coords": {"latitude": 30, "longitude": 78, "accuracy": 0.01}, "timestamp": 0}
        with patch("streamlit_js_eval.streamlit_js_eval", return_value=location):
            self.app.checkbox("get_pos_checkbox").check().run()
        self.assertFalse(self.app.metric)
        self.assertTrue(any("stale" in x.value for x in self.app.warning))

    @patch.dict(os.environ, {"FSS_ENABLE_LOCAL_GNSS": "1"})
    def test_fixed_position_requires_datum_confirmation_then_logs_quality(self):
        receiver = FakeReceiver()
        self.external(receiver)
        self.assertTrue(labeled(self.app.button, "Log RTK point").disabled)
        self.app.checkbox("rtk_datum_confirmed").check().run()
        self.assertFalse(labeled(self.app.button, "Log RTK point").disabled)
        self.assertTrue(any(x.label == "DSM Easting" for x in self.app.metric))
        self.assertTrue(any("expected accuracy: 22 m" in x.value for x in self.app.caption))
        self.app.text_input("rtk_point_name").input("P1")
        labeled(self.app.button, "Log RTK point").click().run()
        self.assertFalse(self.app.exception)
        row = self.app.session_state["rtk_points"][0]
        self.assertEqual(row["point_name"], "P1")
        self.assertEqual(row["quality"], 4)
        self.assertEqual(row["correction_age_s"], 1.0)
        self.assertEqual(row["horizontal_sigma_rss_m"], 0.014)
        self.assertAlmostEqual(row["latitude"], 30.3165)

    @patch.dict(os.environ, {"FSS_ENABLE_LOCAL_GNSS": "1"})
    def test_float_stale_and_missing_uncertainty_disable_logging(self):
        receiver = FakeReceiver()
        self.external(receiver)
        self.app.checkbox("rtk_datum_confirmed").check().run()
        original = copy.deepcopy(receiver.state["fix"])
        for changes in ({"quality": 5}, {"fresh": False}, {"horizontal_sigma_rss_m": None}, {"correction_age_s": 99}):
            receiver.state["fix"] = {**original, **changes}
            self.app.run()
            self.assertTrue(labeled(self.app.button, "Log RTK point").disabled)
        self.assertEqual(self.app.session_state["rtk_points"], [])

    @patch.dict(os.environ, {"FSS_ENABLE_LOCAL_GNSS": "1"})
    def test_record_click_rechecks_fix_after_quality_changes(self):
        receiver = FakeReceiver()
        self.external(receiver)
        self.app.checkbox("rtk_datum_confirmed").check().run()
        receiver.fail_after = receiver.calls + 2
        labeled(self.app.button, "Log RTK point").click().run()
        self.assertEqual(self.app.session_state["rtk_points"], [])
        self.assertTrue(any("quality changed" in x.value for x in self.app.warning))

    @patch.dict(os.environ, {"FSS_ENABLE_LOCAL_GNSS": "1"})
    def test_stale_app_correction_stream_blocks_logging(self):
        receiver = FakeReceiver()
        receiver.state["ntrip_enabled"] = True
        self.external(receiver)
        self.app.checkbox("rtk_datum_confirmed").check().run()
        self.assertTrue(labeled(self.app.button, "Log RTK point").disabled)
        self.assertTrue(any("correction stream" in x.value for x in self.app.warning))

    @patch.dict(os.environ, {"FSS_ENABLE_LOCAL_GNSS": "1"})
    def test_changing_source_closes_local_receiver(self):
        receiver = FakeReceiver()
        self.external(receiver)
        self.app.radio("position_source").set_value("Phone / browser").run()
        self.assertTrue(receiver.closed)
        self.assertNotIn("live_receiver", self.app.session_state)

    @patch.dict(os.environ, {"FSS_ENABLE_LOCAL_GNSS": "1"})
    def test_connect_and_disconnect_controls(self):
        self.external()
        labeled(self.app.text_input, "Receiver serial port").input("COM5")
        receiver = FakeReceiver()
        with patch("own_position.LiveReceiver", return_value=receiver) as connect:
            labeled(self.app.button, "Connect receiver").click().run()
            connect.assert_called_once_with("COM5", 115200, None)
        self.assertFalse(self.app.exception)
        labeled(self.app.button, "Disconnect receiver").click().run()
        self.assertFalse(self.app.exception)
        self.assertTrue(receiver.closed)


if __name__ == "__main__":
    unittest.main()
