import unittest

from gnss import ReceiverMeasurements, parse_nmea, quality_issues


def sentence(body):
    checksum = 0
    for byte in body.encode("ascii"):
        checksum ^= byte
    return f"${body}*{checksum:02X}"


def gga(utc="120000.00", quality=4, age="1.0", hdop="0.8"):
    return sentence(f"GNGGA,{utc},3018.990000,N,07801.932000,E,{quality},18,{hdop},100.0,M,-30.0,M,{age},0123")


def gst(utc="120000.00", lat="0.01", lon="0.01"):
    return sentence(f"GNGST,{utc},0.01,0.02,0.01,0.0,{lat},{lon},0.025")


class GnssTests(unittest.TestCase):
    def test_known_checksum_coordinate_and_height_reference(self):
        fix = parse_nmea("$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47")
        self.assertAlmostEqual(fix["latitude"], 48.1173)
        self.assertAlmostEqual(fix["longitude"], 11.5166666667)
        self.assertAlmostEqual(fix["altitude_ellipsoid_m"], 592.3)
        self.assertIsNone(fix["correction_age_s"])
        self.assertEqual(fix["quality"], 1)

    def test_fixed_does_not_invent_uncertainty_from_hdop(self):
        measurements = ReceiverMeasurements()
        measurements.ingest(gga(hdop="0.01"), now=43200)
        fix = measurements.snapshot(now=43200)
        self.assertIsNone(fix["horizontal_sigma_rss_m"])
        self.assertTrue(quality_issues(fix))
        measurements.ingest(gst(), now=43200)
        self.assertFalse(quality_issues(measurements.snapshot(now=43200)))

    def test_gst_uncertainty_is_same_epoch_component_rss(self):
        measurements = ReceiverMeasurements()
        measurements.ingest(gga(), now=43200)
        measurements.ingest(gst(lat="0.03", lon="0.04"), now=43200)
        self.assertAlmostEqual(measurements.snapshot(now=43200)["horizontal_sigma_rss_m"], 0.05)
        self.assertTrue(quality_issues(measurements.snapshot(now=43200), horizontal_limit=0.02))
        measurements.ingest(gga(utc="120000.05"), now=43200.05)
        self.assertIsNone(measurements.snapshot(now=43200.05)["horizontal_sigma_rss_m"])
        measurements.ingest(gga(utc="120001.00"), now=43201)
        self.assertIsNone(measurements.snapshot(now=43201)["horizontal_sigma_rss_m"])

    def test_stale_replayed_and_future_epochs_cannot_pass_quality_gate(self):
        for now, receipt in [(43206, 43200), (43210, 43210), (43190, 43190)]:
            with self.subTest(now=now, receipt=receipt):
                m = ReceiverMeasurements()
                m.ingest(gga(), now=receipt)
                m.ingest(gst(), now=receipt)
                self.assertFalse(m.snapshot(now=now)["fresh"])
                self.assertTrue(quality_issues(m.snapshot(now=now)))

    def test_midnight_wrap_keeps_matching_gga_gst(self):
        m = ReceiverMeasurements()
        m.ingest(gga(utc="235959.00"), now=86400)
        m.ingest(gst(utc="235959.00"), now=86400)
        self.assertFalse(quality_issues(m.snapshot(now=86401)))

    def test_float_and_no_fix_invalidate_logging_immediately(self):
        m = ReceiverMeasurements()
        m.ingest(gga(), now=43200)
        m.ingest(gst(), now=43200)
        self.assertFalse(quality_issues(m.snapshot(now=43200)))
        for quality in (5, 1, 2, 6, 7, 8, 0):
            m.ingest(gga(quality=quality), now=43200)
            self.assertTrue(quality_issues(m.snapshot(now=43200)))
        self.assertIsNone(m.snapshot(now=43200)["latitude"])
        m.ingest(sentence("GNGGA,120000.00,,,,,0,00,,,,,,,"), now=43200)
        self.assertEqual(m.snapshot(now=43200)["quality"], 0)

    def test_missing_or_old_corrections_prevent_quality_acceptance(self):
        for age in ("", "11"):
            m = ReceiverMeasurements()
            m.ingest(gga(age=age), now=43200)
            m.ingest(gst(), now=43200)
            self.assertTrue(quality_issues(m.snapshot(now=43200)))

    def test_corrupt_invalid_and_nonfinite_data_is_rejected(self):
        bad = [gga()[:-2] + "00", gga().split("*")[0],
               sentence("GNGGA,120000.00,3060.0,N,07801.932,E,4,18,1,100,M,0,M,1,1"),
               sentence("GNGGA,250000.00,3018.99,N,07801.932,E,4,18,1,100,M,0,M,1,1"),
               gga(hdop="nan"), gga(age="-1"), gst(lat="inf"),
               sentence("GNGGA,120000.00,3018.99,,07801.932,E,4,18,1,100,M,0,M,1,1")]
        for line in bad:
            with self.subTest(line=line), self.assertRaises(ValueError):
                parse_nmea(line)

    def test_southern_and_western_hemispheres(self):
        body = gga()[1:].split("*")[0].replace(",N,", ",S,").replace(",E,", ",W,")
        fix = parse_nmea(sentence(body))
        self.assertAlmostEqual(fix["latitude"], -30.3165)
        self.assertAlmostEqual(fix["longitude"], -78.0322)


if __name__ == "__main__":
    unittest.main()
