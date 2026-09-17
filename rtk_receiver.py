"""Opt-in local serial rover and NTRIP v2 / RTCM3 transport.

The receiver resolves RTK; this module only reads NMEA and forwards corrections.
No process-global connection or credential cache is used.
"""

import base64
from dataclasses import dataclass, field
import http.client
import os
import re
import ssl
import threading
import time
from urllib.parse import quote

from gnss import ReceiverMeasurements

GGA_INTERVAL_SECONDS = 10


def local_receiver_enabled():
    return os.environ.get("FSS_ENABLE_LOCAL_GNSS") == "1"


@dataclass(frozen=True)
class NtripSettings:
    host: str
    port: int
    mountpoint: str
    username: str = field(default="", repr=False)
    password: str = field(default="", repr=False)
    tls: bool = True

    def validate(self):
        if not re.fullmatch(r"[A-Za-z0-9.:-]+", self.host) or not 1 <= self.port <= 65535:
            raise ValueError("Enter a caster hostname and a port from 1 to 65535.")
        if not self.mountpoint.strip("/") or any(c in self.mountpoint for c in "\r\n"):
            raise ValueError("Enter a valid NTRIP mountpoint.")
        if ":" in self.username:
            raise ValueError("NTRIP usernames cannot contain a colon.")


def crc24q(data):
    crc = 0
    for byte in data:
        crc ^= byte << 16
        for _ in range(8):
            crc <<= 1
            if crc & 0x1000000:
                crc ^= 0x1864CFB
    return crc & 0xFFFFFF


class Rtcm3Frames:
    """Reassemble and checksum RTCM3; never forward HTTP error text as RTCM."""
    def __init__(self):
        self.buffer = bytearray()

    def feed(self, data):
        self.buffer.extend(data)
        frames = []
        while self.buffer:
            start = self.buffer.find(b"\xd3")
            if start < 0:
                self.buffer.clear()
                break
            del self.buffer[:start]
            if len(self.buffer) < 3:
                break
            if self.buffer[1] & 0xFC:
                del self.buffer[0]
                continue
            length = ((self.buffer[1] & 3) << 8) + self.buffer[2] + 6
            if len(self.buffer) < length:
                break
            frame = bytes(self.buffer[:length])
            if crc24q(frame[:-3]) == int.from_bytes(frame[-3:], "big"):
                frames.append(frame)
                del self.buffer[:length]
            else:
                del self.buffer[0]
        return frames


class LiveReceiver:
    def __init__(self, port, baudrate=115200, ntrip=None, serial_factory=None):
        if not local_receiver_enabled():
            raise ValueError("Local receiver access is not enabled on this app installation.")
        if ntrip:
            ntrip.validate()
        if serial_factory is None:
            from serial import Serial
            serial_factory = Serial
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._measurements = ReceiverMeasurements()
        self._heartbeat = time.monotonic()
        self._connection = None
        self._serial = serial_factory(port=port, baudrate=baudrate, timeout=0.2, write_timeout=2)
        try:
            self._serial.reset_input_buffer()
        except Exception:
            self._serial.close()
            raise
        self._state = {"connected": True, "receiver_error": None,
                       "ntrip_enabled": bool(ntrip),
                       "ntrip_status": "Waiting for rover GGA" if ntrip else "Receiver supplies its own corrections",
                       "rtcm_bytes": 0, "last_rtcm_at": None}
        self._threads = [threading.Thread(target=self._read, daemon=True)]
        if ntrip:
            self._threads.append(threading.Thread(target=self._corrections, args=(ntrip,), daemon=True))
        for thread in self._threads:
            thread.start()

    def _set(self, **values):
        with self._lock:
            self._state.update(values)

    def snapshot(self):
        # A disconnected browser loses its heartbeat; release the port after 30 s.
        self._heartbeat = time.monotonic()
        with self._lock:
            return {**self._state, "fix": self._measurements.snapshot(),
                    "invalid_sentences": self._measurements.invalid_sentences}

    def _gga(self):
        with self._lock:
            fix = self._measurements.snapshot()
        if fix and fix["fresh"] and fix["quality"] in (1, 2, 3, 4, 5):
            return fix["sentence"]
        return None

    def _read(self):
        pending = bytearray()
        try:
            while not self._stop.is_set():
                if time.monotonic() - self._heartbeat > 30:
                    self._set(receiver_error="Receiver disconnected after 30 seconds without an active app session.")
                    break
                pending.extend(self._serial.read(min(max(self._serial.in_waiting, 1), 4096)))
                while b"\n" in pending:
                    raw, _, pending = pending.partition(b"\n")
                    start = raw.find(b"$")
                    if start < 0:
                        continue
                    try:
                        line = raw[start:].decode("ascii")
                    except UnicodeDecodeError:
                        continue
                    if len(line) >= 6 and line[3:6] in ("GGA", "GST"):
                        with self._lock:
                            self._measurements.ingest(line)
                if len(pending) > 4096:
                    pending.clear()
        except Exception:
            if not self._stop.is_set():
                self._set(receiver_error="Receiver read failed. Check the cable, Bluetooth COM port and baud rate; reconnect.")
        finally:
            self.close(join=False)

    def _corrections(self, settings):
        connection = None
        try:
            while not self._stop.is_set():
                gga = self._gga()
                if gga:
                    break
                self._stop.wait(0.2)
            if self._stop.is_set():
                return
            headers = {"User-Agent": "NTRIP FSS-Survey/1.0", "Ntrip-Version": "Ntrip/2.0",
                       "Ntrip-GGA": gga, "Accept": "gnss/data", "Connection": "keep-alive"}
            if settings.username or settings.password:
                auth = base64.b64encode(f"{settings.username}:{settings.password}".encode()).decode()
                headers["Authorization"] = f"Basic {auth}"
            cls = http.client.HTTPSConnection if settings.tls else http.client.HTTPConnection
            kwargs = {"context": ssl.create_default_context()} if settings.tls else {}
            connection = cls(settings.host, settings.port, timeout=10, **kwargs)
            self._connection = connection
            self._set(ntrip_status="Connecting to caster")
            connection.request("GET", "/" + quote(settings.mountpoint.strip("/"), safe="/"), headers=headers)
            response = connection.getresponse()
            if response.status != 200:
                self._set(ntrip_status=f"NTRIP rejected the request (HTTP {response.status}); check credentials and mountpoint.")
                return
            content_type = response.getheader("Content-Type", "").lower()
            if any(word in content_type for word in ("sourcetable", "text/", "json", "html")):
                self._set(ntrip_status="Caster returned a source table or text instead of RTCM3; check mountpoint.")
                return
            decoder = Rtcm3Frames()
            last_gga = time.monotonic()
            last_frame = time.monotonic()
            self._set(ntrip_status="Connected; waiting for verified RTCM3 frames")
            while not self._stop.is_set():
                # HTTPResponse handles v2 chunked transfer framing before CRC checks.
                data = response.read1(4096)
                if not data:
                    raise ConnectionError("Correction stream ended")
                for frame in decoder.feed(data):
                    written = self._serial.write(frame)
                    if written != len(frame):
                        raise IOError("Incomplete correction write")
                    last_frame = time.monotonic()
                    with self._lock:
                        self._state["rtcm_bytes"] += written
                        self._state["last_rtcm_at"] = time.time()
                        self._state["ntrip_status"] = "Streaming RTCM3 to rover"
                if time.monotonic() - last_frame > 15:
                    raise ConnectionError("No valid RTCM3 frames")
                if time.monotonic() - last_gga >= GGA_INTERVAL_SECONDS:
                    gga = self._gga()
                    if gga and connection.sock:
                        connection.sock.sendall((gga + "\r\n").encode("ascii"))
                        last_gga = time.monotonic()
        except Exception:
            if not self._stop.is_set():
                self._set(ntrip_status="NTRIP stopped. Check network, TLS, NTRIP v2/RTCM3 support and mountpoint; reconnect.")
        finally:
            if connection:
                connection.close()

    def close(self, join=True):
        self._stop.set()
        self._set(connected=False)
        if self._connection:
            self._connection.close()
        self._serial.close()
        if join:
            for thread in self._threads:
                if thread is not threading.current_thread():
                    thread.join(timeout=0.5)
