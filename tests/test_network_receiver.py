from datetime import datetime, timezone
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import socket
import threading
import time
import unittest
from unittest.mock import patch

from network_receiver import NetworkSettings, NetworkStream, connect_network
from rtk_receiver import NtripSettings
from test_gnss import gga, gst
from test_rtk_receiver import wait_for, frame


def sentences(quality=4):
    utc = datetime.now(timezone.utc).strftime('%H%M%S.%f')
    return gga(utc=utc, quality=quality).encode(), gst(utc=utc).encode()


@patch.dict(os.environ, {'FSS_ENABLE_LOCAL_GNSS': '1'})
class NetworkReceiverTests(unittest.TestCase):
    def setUp(self):
        self.receiver = None
        self.sockets = []

    def tearDown(self):
        if self.receiver:
            self.receiver.close()
        for sock in self.sockets:
            sock.close()

    def sock(self, kind):
        s = socket.socket(socket.AF_INET, kind)
        s.bind(('127.0.0.1', 0))
        self.sockets.append(s)
        return s

    def tcp(self, confirmed=False):
        listener = self.sock(socket.SOCK_STREAM)
        listener.listen(1)
        self.receiver = connect_network(NetworkSettings('TCP', '127.0.0.1', listener.getsockname()[1], correction_input_confirmed=confirmed))
        peer, _ = listener.accept(); self.sockets.append(peer)
        return peer

    def udp(self, source_ip='127.0.0.1'):
        probe = self.sock(socket.SOCK_DGRAM)
        port = probe.getsockname()[1]; probe.close()
        self.receiver = connect_network(NetworkSettings('UDP', source_ip, port, '127.0.0.1'))
        return port

    def test_tcp_split_sentences_cr_lf_and_disconnect(self):
        peer = self.tcp(); a, b = sentences()
        peer.sendall(a[:15]); peer.sendall(a[15:] + b'\r' + b + b'\r\n')
        self.assertTrue(wait_for(lambda: self.receiver.snapshot()['valid_gst'] == 1))
        state = self.receiver.snapshot()
        self.assertEqual(state['transport'], 'Wi-Fi TCP')
        self.assertEqual(state['valid_gga'], 1)
        self.assertEqual(state['rx_bytes'], len(a)+len(b)+3)
        self.assertEqual(state['fix']['quality'], 4)
        self.assertAlmostEqual(state['fix']['altitude_ellipsoid_m'], 70)
        peer.close()
        self.assertTrue(wait_for(lambda: not self.receiver.snapshot()['connected']))
        self.assertIn('Wi-Fi', self.receiver.snapshot()['receiver_error'])

    def test_udp_complete_datagram_without_newline_and_no_fix(self):
        port = self.udp(); sender = self.sock(socket.SOCK_DGRAM)
        a, b = sentences(); sender.sendto(a, ('127.0.0.1', port)); sender.sendto(b, ('127.0.0.1', port))
        self.assertTrue(wait_for(lambda: self.receiver.snapshot()['valid_gst'] == 1))
        self.assertEqual(self.receiver.snapshot()['fix']['quality'], 4)
        nofix, _ = sentences(0); sender.sendto(nofix, ('127.0.0.1', port))
        self.assertTrue(wait_for(lambda: self.receiver.snapshot()['fix']['quality'] == 0))
        self.assertIsNone(self.receiver.snapshot()['fix']['latitude'])
        self.receiver.close()
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as free:
            free.bind(('127.0.0.1', port))

    def test_udp_filters_other_device_and_tracks_bad_checksum(self):
        port = self.udp('127.0.0.2'); sender = self.sock(socket.SOCK_DGRAM)
        a, _ = sentences(); sender.sendto(a, ('127.0.0.1', port))
        self.assertTrue(wait_for(lambda: self.receiver.snapshot()['ignored_datagrams'] == 1))
        self.assertIsNone(self.receiver.snapshot()['fix'])
        self.receiver.close(); self.receiver = None
        port = self.udp(); bad = a[:-2] + (b'00' if a[-2:] != b'00' else b'FF')
        sender.sendto(bad, ('127.0.0.1', port))
        self.assertTrue(wait_for(lambda: self.receiver.snapshot()['invalid_sentences'] == 1))
        self.assertIsNone(self.receiver.snapshot()['fix'])

    def test_tcp_correction_writes_require_explicit_same_port_confirmation(self):
        peer = self.tcp()
        with self.assertRaisesRegex(ValueError, 'confirmed'):
            self.receiver._serial.write(frame())
        self.receiver.close(); self.receiver = None
        peer = self.tcp(True); peer.settimeout(2)
        self.assertEqual(self.receiver._serial.write(frame()), len(frame()))
        self.assertEqual(peer.recv(4096), frame())

    def test_ntrip_corrections_reach_confirmed_tcp_receiver(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Type', 'gnss/data')
                self.end_headers()
                self.wfile.write(frame())
                self.wfile.flush()
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        try:
            listener = self.sock(socket.SOCK_STREAM); listener.listen(1)
            self.receiver = connect_network(
                NetworkSettings('TCP', '127.0.0.1', listener.getsockname()[1], correction_input_confirmed=True),
                NtripSettings('127.0.0.1', server.server_port, 'test', tls=False))
            peer, _ = listener.accept(); self.sockets.append(peer); peer.settimeout(2)
            a, b = sentences(); peer.sendall(a+b'\r\n'+b+b'\r\n')
            self.assertEqual(peer.recv(4096), frame())
            self.assertTrue(wait_for(lambda: self.receiver.snapshot()['rtcm_bytes'] == len(frame())))
        finally:
            server.shutdown(); server.server_close(); worker.join(timeout=2)

    def test_udp_and_readonly_tcp_cannot_forward_ntrip(self):
        for protocol in ('UDP', 'TCP'):
            with self.assertRaisesRegex(ValueError, 'receiver-managed'):
                connect_network(NetworkSettings(protocol, '127.0.0.1', 12345), NtripSettings('caster.example', 443, 'mount'))

    def test_disabled_installation_never_opens_socket(self):
        with patch.dict(os.environ, {'FSS_ENABLE_LOCAL_GNSS': '0'}), patch('network_receiver.socket.socket') as sock:
            with self.assertRaisesRegex(ValueError, 'not enabled'):
                connect_network(NetworkSettings('TCP', '127.0.0.1', 12345))
            sock.assert_not_called()

    def test_invalid_endpoint_rejected(self):
        for settings in [NetworkSettings('HTTP', '127.0.0.1', 1), NetworkSettings('TCP', 'http://192.168.1.1', 1), NetworkSettings('TCP','0.0.0.0',1),NetworkSettings('UDP','192.168.1.1',0), NetworkSettings('UDP','192.168.1.1',70000)]:
            with self.subTest(settings=settings), self.assertRaises(ValueError):
                settings.validate()
