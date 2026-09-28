"""Opt-in LAN NMEA receiver transport. Sockets run on the app host, not the phone."""
from dataclasses import dataclass
import ipaddress
import re
import socket
import threading

from rtk_receiver import LiveReceiver, local_receiver_enabled


@dataclass(frozen=True)
class NetworkSettings:
    protocol: str
    receiver_ip: str
    port: int
    bind_ip: str = '0.0.0.0'
    correction_input_confirmed: bool = False

    def validate(self):
        if self.protocol not in ('TCP', 'UDP'):
            raise ValueError('Choose TCP or UDP from the receiver configuration.')
        try:
            peer = ipaddress.IPv4Address(self.receiver_ip)
            bind = ipaddress.IPv4Address(self.bind_ip)
        except ipaddress.AddressValueError:
            raise ValueError('Enter IPv4 addresses, without http:// or a port suffix.') from None
        if peer.is_unspecified or peer.is_multicast or str(peer) == '255.255.255.255':
            raise ValueError('Enter the receiver device address, not a broadcast or multicast address.')
        if bind.is_multicast or str(bind) == '255.255.255.255':
            raise ValueError('Enter this computer’s interface address or 0.0.0.0 for UDP listening.')
        if isinstance(self.port, bool) or not isinstance(self.port, int) or not 1 <= self.port <= 65535:
            raise ValueError('Enter the actual NMEA TCP port or UDP destination port (1–65535).')


class NetworkStream:
    """Small serial-compatible adapter, so NMEA quality/logging checks stay shared.

    TCP connects to the receiver's server. UDP listens for its configured push
    output and filters sender IP. UDP is receive-only; no guessed correction peer.
    """
    def __init__(self, settings):
        if not local_receiver_enabled():
            raise ValueError('Local receiver access is not enabled on this app installation.')
        settings.validate()
        self.settings = settings
        self._write_lock = threading.Lock()
        self._closed = False
        self._pending = bytearray()
        self.ignored_datagrams = 0
        self.wire_bytes = 0
        if settings.protocol == 'TCP':
            self.sock = socket.create_connection((settings.receiver_ip, settings.port), timeout=5)
        else:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                self.sock.bind((settings.bind_ip, settings.port))
            except Exception:
                self.sock.close()
                raise
        self.sock.settimeout(.2)

    @property
    def in_waiting(self):
        return len(self._pending) or 4096

    def reset_input_buffer(self):
        # Preserve any bytes already sent as soon as TCP connects.
        pass

    def read(self, size):
        if self._pending:
            out = bytes(self._pending[:size]); del self._pending[:size]
            return out
        try:
            if self.settings.protocol == 'TCP':
                data = self.sock.recv(size)
                if not data:
                    raise ConnectionError('Receiver closed the TCP stream.')
                self.wire_bytes += len(data)
                return data
            data, sender = self.sock.recvfrom(65535)
            if sender[0] != self.settings.receiver_ip:
                self.ignored_datagrams += 1
                return b''
            self.wire_bytes += len(data)
            # Some receivers send one complete sentence/datagram without CRLF.
            if re.search(rb'\$[^\r\n]*\*[0-9a-fA-F]{2}$', data):
                data += b'\n'
            self._pending.extend(data[size:])
            return data[:size]
        except socket.timeout:
            return b''

    def write(self, data):
        if self.settings.protocol != 'TCP' or not self.settings.correction_input_confirmed:
            raise ValueError('Correction forwarding requires a confirmed bidirectional TCP receiver port.')
        with self._write_lock:
            self.sock.sendall(data)
        return len(data)

    def close(self):
        if self._closed:
            return
        self._closed = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()


def connect_network(settings, ntrip=None):
    if not local_receiver_enabled():
        raise ValueError('Local receiver access is not enabled on this app installation.')
    settings.validate()
    if ntrip and (settings.protocol != 'TCP' or not settings.correction_input_confirmed):
        raise ValueError('Use receiver-managed corrections for UDP or a receive-only TCP port.')
    return LiveReceiver(
        f'{settings.receiver_ip}:{settings.port}', ntrip=ntrip,
        serial_factory=lambda **unused: NetworkStream(settings),
        transport=f'Wi-Fi {settings.protocol}',
        read_error='Receiver read failed. Check Wi-Fi, receiver IP/port and NMEA output; reconnect.',
    )
