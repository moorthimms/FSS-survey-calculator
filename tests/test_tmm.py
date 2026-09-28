from datetime import datetime, timezone
import copy
import time
import unittest
from unittest.mock import patch
from streamlit.testing.v1 import AppTest
from tmm import position, logging_issues, csv_safe
from tmm_ui import fresh_payload


def sample(now=None):
    return dict(latitude=30.3, longitude=78.0, altitude=1550.2, mslHeight=1580.1,
                hrms=.008, vrms=.015, diffStatus=4, diffAge=1, satellites=24, totalSatInUse=20,
                receiverModel='R12', utcTimeStamp=datetime.fromtimestamp(now or time.time(), timezone.utc).isoformat())


class TmmValidationTests(unittest.TestCase):
    def test_valid_fix_and_zero_values(self):
        p = sample(100)
        p.update(latitude=0, longitude=0, mslHeight=0, altitude=0, hrms=0, vrms=0, diffAge=0)
        fix = fresh_payload(p, 100000, now=100)
        self.assertFalse(logging_issues(fix, True, True))
        self.assertEqual(fix['altitude'], 0)

    def test_rejects_stale_future_missing_utc_and_invalid_coordinates(self):
        for patch_value in [dict(utcTimeStamp=None), dict(utcTimeStamp='1970-01-01T00:01:40'),
                            dict(utcTimeStamp='1970-01-01T00:00:00Z'),
                            dict(utcTimeStamp='1970-01-01T00:05:00Z'), dict(latitude=True),
                            dict(longitude=float('nan')), dict(latitude=91), dict(longitude='78')]:
            with self.subTest(patch_value=patch_value), self.assertRaises(ValueError):
                position(dict(sample(100), **patch_value), now=100)
        for stamp in [0, 200000, True, None, float('nan')]:
            with self.assertRaises(ValueError):
                fresh_payload(sample(100), stamp, now=100)

    def test_fixed_is_insufficient_and_unknown_accuracy_not_inferred(self):
        for changes in [dict(diffStatus=5), dict(diffStatus=0), dict(diffStatus=True),
                        dict(hrms=None, accuracy=.001), dict(vrms=None), dict(diffAge=11),
                        dict(hrms=-1), dict(vrms=.1), dict(altitude=None, mslHeight=None)]:
            fix = position(dict(sample(100), **changes), now=100)
            self.assertTrue(logging_issues(fix, True, True))
        fix = position(sample(100), now=100)
        self.assertTrue(logging_issues(fix, False, True))
        self.assertTrue(logging_issues(fix, True, False))

    def test_csv_injection_and_missing_fields(self):
        self.assertEqual(csv_safe({'name':'=CMD()', 'altitude':-10}), {'name':"'=CMD()", 'altitude':-10})
        self.assertIsNone(position(sample(100), now=100)['undulation'])


class TmmUiTests(unittest.TestCase):
    def setUp(self):
        self.app = AppTest.from_string('from tmm_ui import render_tmm\nrender_tmm(lambda lat, lon: None)')
        self.payload = sample()
        self.capture = None
        self.connected = True

    def component(self, **kw):
        return dict(nonce=kw['nonce'], connected=self.connected, status='Disconnected',
                    payload=self.payload, receivedAt=time.time()*1000, capture=self.capture)

    def run_app(self):
        with patch('tmm_ui._component', side_effect=self.component):
            self.app.run(timeout=15)
        self.assertFalse(self.app.exception)

    def test_cloud_ui_and_quality_checked_next_sample_capture(self):
        self.run_app()
        self.assertTrue(any('FIXED' in m.value for m in self.app.markdown))
        self.assertFalse(self.app.session_state['tmm_points'])
        self.app.checkbox('tmm_datum').check()
        self.app.checkbox('tmm_height').check()
        self.capture = dict(id='one', payload=sample(), receivedAt=time.time()*1000)
        self.run_app()
        self.assertEqual(len(self.app.session_state['tmm_points']), 1)
        self.run_app()
        self.assertEqual(len(self.app.session_state['tmm_points']), 1)
        self.capture = dict(id='two', payload=dict(sample(), diffStatus=5), receivedAt=time.time()*1000)
        self.run_app()
        self.assertEqual(len(self.app.session_state['tmm_points']), 1)
        self.assertTrue(any('not recorded' in w.value for w in self.app.warning))

    def test_disconnect_does_not_show_previous_fix_or_log(self):
        self.run_app()
        self.connected = False
        self.capture = dict(id='one', payload=sample(), receivedAt=time.time()*1000)
        self.run_app()
        self.assertFalse(self.app.metric)
        self.assertFalse(self.app.session_state['tmm_points'])

    def test_unknown_solution_does_not_show_height_or_coordinates(self):
        self.payload['diffStatus'] = 0
        self.run_app()
        self.assertFalse(any(m.label == 'Altitude (TMM output)' for m in self.app.metric))

    def test_source_is_available_on_hosted_app_and_closes_raw_receiver(self):
        app = AppTest.from_string('from own_position import render_own_position\nrender_own_position(lambda lat, lon: None)').run()
        from unittest.mock import Mock
        receiver = Mock()
        app.session_state['live_receiver'] = receiver
        app.radio('position_source').set_value('Trimble R12 / Mobile Manager')
        with patch('tmm_ui._component', return_value=None):
            app.run()
        self.assertFalse(app.exception)
        receiver.close.assert_called_once()
        self.assertEqual(app.selectbox('tmm_api').value, 'V1 compatibility — no Application ID')

    def test_v2_port_and_registration_explanation(self):
        self.run_app()
        self.app.selectbox('tmm_api').set_value('V2 — registered integration')
        self.run_app()
        self.assertEqual(self.app.number_input('tmm_port_V2').value, 9640)
        self.assertTrue(any('Application ID' in i.value for i in self.app.info))


if __name__ == '__main__':
    unittest.main()
