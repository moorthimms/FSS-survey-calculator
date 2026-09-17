from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import select
import threading
import time
import unittest
from unittest.mock import patch

from rtk_receiver import LiveReceiver, NtripSettings, Rtcm3Frames, crc24q
from test_gnss import gga, gst


def frame():
    payload = b"\x3e\xd0" + bytes(17)  # Synthetic RTCM 1005 framing fixture.
    data = b"\xd3\x00" + bytes([len(payload)]) + payload
    return data + crc24q(data).to_bytes(3, "big")


def wait_for(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        threading.Event().wait(0.02)
    return False


class RtcmTests(unittest.TestCase):
    def test_crc_known_check_value_and_split_frames(self):
        self.assertEqual(crc24q(b"123456789"), 0xCDE703)
        parser = Rtcm3Frames()
        data = frame()
        self.assertEqual(parser.feed(b"HTTP error text" + data[:7]), [])
        self.assertEqual(parser.feed(data[7:]), [data])
        corrupt = data[:-1] + bytes([data[-1] ^ 1])
        self.assertEqual(parser.feed(corrupt + data), [data])

    def test_local_access_requires_explicit_installation_opt_in(self):
        with patch.dict(os.environ, {"FSS_ENABLE_LOCAL_GNSS": "0"}):
            with self.assertRaisesRegex(ValueError, "not enabled"):
                LiveReceiver("COM5")

    def test_caster_configuration_and_credential_repr(self):
        settings = NtripSettings("caster.example", 443, "mount", "synthetic-user", "synthetic-secret")
        self.assertNotIn("synthetic-secret", repr(settings))
        self.assertNotIn("synthetic-user", repr(settings))
        settings.validate()
        for host, port, mount in [("https://caster.example", 443, "a"), ("host", 0, "a"), ("host", 443, ""), ("host", 443, "a\r\nX: y")]:
            with self.subTest(host=host, port=port, mount=mount), self.assertRaises(ValueError):
                NtripSettings(host, port, mount).validate()


@unittest.skipUnless(os.name == "posix", "PTY serial integration requires POSIX")
@patch.dict(os.environ, {"FSS_ENABLE_LOCAL_GNSS": "1"})
class SerialIntegrationTests(unittest.TestCase):
    def setUp(self):
        import pty
        self.master, self.slave = pty.openpty()
        self.port = os.ttyname(self.slave)
        self.receiver = None
        self.server = None

    def tearDown(self):
        if self.receiver:
            self.receiver.close()
        if self.server:
            self.server.shutdown()
            self.server.server_close()
        for fd in (self.master, self.slave):
            if fd is not None:
                os.close(fd)

    def send_fix(self, quality=4):
        utc = datetime.now(timezone.utc).strftime("%H%M%S.%f")
        os.write(self.master, (gga(utc=utc, quality=quality) + "\r\n" + gst(utc=utc) + "\r\n").encode())

    def start_caster(self, status=200, content_type="gnss/data", expect_update=False):
        parent = self
        self.request_headers = {}
        self.gga_update = b""
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *args):
                pass

            def do_GET(self):
                parent.request_headers.update(self.headers)
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                if status == 200 and content_type == "gnss/data":
                    data = frame()
                    for part in (data[:5], data[5:]):
                        self.wfile.write(f"{len(part):X}\r\n".encode() + part + b"\r\n")
                    self.wfile.flush()
                    if expect_update:
                        self.connection.settimeout(2)
                        parent.gga_update = self.rfile.readline()
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                self.close_connection = True
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return NtripSettings("127.0.0.1", self.server.server_port, "test", "synthetic-user", "synthetic-secret", False)

    def test_actual_pyserial_reads_fixed_then_no_fix_and_closes_port(self):
        self.receiver = LiveReceiver(self.port)
        self.send_fix()
        self.assertTrue(wait_for(lambda: self.receiver.snapshot()["fix"] is not None))
        self.assertEqual(self.receiver.snapshot()["fix"]["quality"], 4)
        self.assertAlmostEqual(self.receiver.snapshot()["fix"]["latitude"], 30.3165)
        self.send_fix(quality=0)
        self.assertTrue(wait_for(lambda: self.receiver.snapshot()["fix"]["quality"] == 0))
        self.assertIsNone(self.receiver.snapshot()["fix"]["latitude"])
        self.receiver.close()
        self.assertFalse(self.receiver.snapshot()["connected"])
        self.assertFalse(self.receiver._serial.is_open)

    def test_chunked_ntrip_is_forwarded_byte_exactly_to_serial(self):
        settings = self.start_caster()
        self.receiver = LiveReceiver(self.port, ntrip=settings)
        self.send_fix()
        self.assertTrue(wait_for(lambda: self.receiver.snapshot()["rtcm_bytes"] == len(frame())))
        ready, _, _ = select.select([self.master], [], [], 2)
        self.assertTrue(ready)
        self.assertEqual(os.read(self.master, 4096), frame())
        self.assertEqual(self.request_headers["Ntrip-Version"], "Ntrip/2.0")
        self.assertTrue(self.request_headers["Ntrip-GGA"].startswith("$GNGGA,"))
        self.assertTrue(self.request_headers["Authorization"].startswith("Basic "))
        self.assertTrue(wait_for(lambda: "stopped" in self.receiver.snapshot()["ntrip_status"]))

    def test_authentication_failure_does_not_leak_credentials(self):
        settings = self.start_caster(status=401)
        self.receiver = LiveReceiver(self.port, ntrip=settings)
        self.send_fix()
        self.assertTrue(wait_for(lambda: "401" in self.receiver.snapshot()["ntrip_status"]))
        self.assertEqual(self.receiver.snapshot()["rtcm_bytes"], 0)
        self.assertNotIn("synthetic-secret", str(self.receiver.snapshot()))

    @patch("rtk_receiver.GGA_INTERVAL_SECONDS", 0)
    def test_periodic_rover_gga_is_sent_back_to_caster(self):
        settings = self.start_caster(expect_update=True)
        self.receiver = LiveReceiver(self.port, ntrip=settings)
        self.send_fix()
        self.assertTrue(wait_for(lambda: self.gga_update.startswith(b"$GNGGA,")))
        self.assertTrue(self.gga_update.endswith(b"\r\n"))

    def test_sourcetable_is_not_sent_to_rover_as_corrections(self):
        settings = self.start_caster(content_type="gnss/sourcetable")
        self.receiver = LiveReceiver(self.port, ntrip=settings)
        self.send_fix()
        self.assertTrue(wait_for(lambda: "source table" in self.receiver.snapshot()["ntrip_status"]))
        self.assertEqual(self.receiver.snapshot()["rtcm_bytes"], 0)

    def test_lost_browser_heartbeat_releases_receiver(self):
        self.receiver = LiveReceiver(self.port)
        self.receiver._heartbeat = time.monotonic() - 31
        self.assertTrue(self.receiver._stop.wait(2))
        self.receiver.close()
        self.assertFalse(self.receiver.snapshot()["connected"])

    def test_unplugged_receiver_does_not_keep_a_live_fix(self):
        self.receiver = LiveReceiver(self.port)
        self.send_fix()
        self.assertTrue(wait_for(lambda: self.receiver.snapshot()["fix"] is not None))
        os.close(self.master)
        self.master = None
        self.assertTrue(wait_for(lambda: not self.receiver.snapshot()["connected"]))
        self.assertIn("read failed", self.receiver.snapshot()["receiver_error"])


if __name__ == "__main__":
    unittest.main()
