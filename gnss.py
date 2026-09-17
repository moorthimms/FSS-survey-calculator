"""Checksum-checked receiver measurements; no accuracy inferred from FIX or HDOP."""

from math import hypot, isfinite
import re
import time


FIX_LABELS = {
    0: "No fix", 1: "Standalone GNSS", 2: "Differential GNSS",
    3: "PPS", 4: "RTK FIX (receiver reported)",
    5: "RTK FLOAT (receiver reported)", 6: "Estimated / dead reckoning",
    7: "Manual position", 8: "Simulation",
}


def number(value, nonnegative=False):
    if value == "":
        return None
    result = float(value)
    if not isfinite(result) or (nonnegative and result < 0):
        raise ValueError("Invalid numeric receiver field")
    return result


def utc_seconds(value):
    if not re.fullmatch(r"\d{6}(?:\.\d+)?", value):
        raise ValueError("Invalid receiver UTC")
    hour, minute, second = int(value[:2]), int(value[2:4]), float(value[4:])
    if hour >= 24 or minute >= 60 or second >= 60:
        raise ValueError("Invalid receiver UTC")
    return hour * 3600 + minute * 60 + second


def coordinate(value, hemisphere, latitude):
    width, maximum, allowed = (2, 90, "NS") if latitude else (3, 180, "EW")
    if hemisphere not in allowed or len(hemisphere) != 1:
        raise ValueError("Invalid receiver hemisphere")
    if not re.fullmatch(rf"\d{{{width + 2}}}(?:\.\d+)?", value):
        raise ValueError("Invalid receiver coordinate")
    deg, minutes = int(value[:width]), float(value[width:])
    if minutes >= 60 or deg > maximum or (deg == maximum and minutes != 0):
        raise ValueError("Invalid receiver coordinate")
    result = deg + minutes / 60
    return -result if hemisphere in "SW" else result


def parse_nmea(line):
    line = line.strip()
    if not re.fullmatch(r"\$[A-Z]{2}(?:GGA|GST),[^*\r\n]*\*[0-9a-fA-F]{2}", line):
        raise ValueError("Expected checksummed NMEA GGA or GST")
    body, check = line[1:].split("*")
    checksum = 0
    for char in body:
        checksum ^= ord(char)
    if checksum != int(check, 16):
        raise ValueError("NMEA checksum mismatch")
    fields = body.split(",")
    kind = fields[0][-3:]
    if len(fields) != (15 if kind == "GGA" else 9):
        raise ValueError("Incomplete NMEA sentence")
    utc = utc_seconds(fields[1])
    if kind == "GST":
        lat_sd, lon_sd, height_sd = [number(x, True) for x in fields[6:9]]
        return {"type": kind, "utc": utc,
                "horizontal_sigma_rss_m": hypot(lat_sd, lon_sd) if lat_sd is not None and lon_sd is not None else None,
                "height_sigma_m": height_sd}
    quality = int(fields[6])
    if quality not in FIX_LABELS:
        raise ValueError("Unknown receiver fix quality")
    # A valid no-fix sentence must invalidate the previous FIX immediately.
    lat = coordinate(fields[2], fields[3], True) if quality else None
    lon = coordinate(fields[4], fields[5], False) if quality else None
    satellites = int(fields[7]) if fields[7] else None
    if satellites is not None and not 0 <= satellites <= 999:
        raise ValueError("Invalid satellite count")
    msl, separation = number(fields[9]), number(fields[11])
    if (msl is not None and fields[10] != "M") or (separation is not None and fields[12] != "M"):
        raise ValueError("Receiver heights must be metres")
    return {"type": kind, "utc": utc, "latitude": lat, "longitude": lon,
            "quality": quality, "fix_label": FIX_LABELS[quality], "satellites": satellites,
            "hdop": number(fields[8], True), "altitude_msl_m": msl,
            "geoid_separation_m": separation,
            "altitude_ellipsoid_m": msl + separation if msl is not None and separation is not None else None,
            "correction_age_s": number(fields[13], True), "station_id": fields[14],
            "sentence": line}


class ReceiverMeasurements:
    def __init__(self):
        self.fix = None
        self.gst = None
        self.invalid_sentences = 0

    def ingest(self, line, now=None):
        now = time.time() if now is None else now
        try:
            value = parse_nmea(line)
        except (ValueError, TypeError):
            self.invalid_sentences += 1
            return False
        value["received_at"] = now
        day = now // 86400 * 86400
        value["epoch_timestamp"] = min((day + value["utc"] + shift for shift in (-86400, 0, 86400)),
                                       key=lambda epoch: abs(epoch - now))
        if value["type"] == "GGA":
            self.fix = value
        else:
            self.gst = value
        return True

    def snapshot(self, now=None):
        now = time.time() if now is None else now
        if self.fix is None:
            return None
        result = dict(self.fix)
        result["age_s"] = max(0, now - result["received_at"], now - result["epoch_timestamp"])
        result["fresh"] = (0 <= now - result["received_at"] <= 5
                           and -2 <= now - result["epoch_timestamp"] <= 5)
        result["horizontal_sigma_rss_m"] = None
        result["height_sigma_m"] = None
        if self.gst and abs(self.gst["epoch_timestamp"] - result["epoch_timestamp"]) <= 0.0001 and 0 <= now - self.gst["received_at"] <= 5:
            result.update({key: self.gst[key] for key in ("horizontal_sigma_rss_m", "height_sigma_m")})
        return result


def quality_issues(fix, horizontal_limit=0.02, correction_limit=10.0):
    if not fix:
        return ["Waiting for receiver GGA measurements."]
    issues = []
    if not fix["fresh"]:
        issues.append("Position is stale or receiver UTC differs from the computer clock.")
    if fix["quality"] != 4:
        issues.append("Receiver is not reporting RTK FIX.")
    if fix["correction_age_s"] is None or fix["correction_age_s"] > correction_limit:
        issues.append("Correction age is missing or exceeds the selected limit.")
    if fix["horizontal_sigma_rss_m"] is None:
        issues.append("Matching GGA/GST uncertainty measurements are unavailable.")
    elif fix["horizontal_sigma_rss_m"] > horizontal_limit:
        issues.append("Reported horizontal uncertainty exceeds the selected limit.")
    return issues
