"""Supported Kalianpur 1975 conversions backed by the installed EPSG registry.

EPSG areas of use are bounding boxes, not administrative boundary polygons.
They reject unsupported coverage but do not establish a map's source datum.
"""

from functools import lru_cache
from math import isfinite

from pyproj import CRS, Transformer
from pyproj.exceptions import ProjError


KALIANPUR_EPSG = {
    "Zone I": 24378,
    "Zone IIa": 24379,
    "Zone IIb": 24380,
    "Zone IIIa": 24381,
    "Zone IVa": 24383,
}

DSM_UNAVAILABLE_REASON = (
    "DSM conversion is unavailable: the projection and its datum "
    "transformation have not been verified. An authoritative DSM definition "
    "and control points are required before conversion can be enabled."
)


@lru_cache(maxsize=None)
def kalianpur_crs(zone):
    if zone not in KALIANPUR_EPSG:
        raise ValueError(f"Unsupported Kalianpur 1975 zone: {zone}")
    code = KALIANPUR_EPSG[zone]
    crs = CRS.from_epsg(code)
    expected_name = f"Kalianpur 1975 / India zone {zone.removeprefix('Zone ')}"
    if crs.name != expected_name or crs.datum.name != "Kalianpur 1975":
        raise ValueError(f"EPSG:{code} does not define {expected_name}.")
    return crs


def _zone_metadata(zone):
    crs = kalianpur_crs(zone)
    area = crs.area_of_use
    params = {p.name: p.value for p in crs.coordinate_operation.params}
    return {
        "epsg": KALIANPUR_EPSG[zone],
        "bounds": {
            "lat_min": area.south, "lat_max": area.north,
            "lon_min": area.west, "lon_max": area.east,
        },
        "description": area.name,
        "central_meridian": params["Longitude of natural origin"],
    }


ENHANCED_KALIANPUR_ZONES = {zone: _zone_metadata(zone) for zone in KALIANPUR_EPSG}


def _finite_pair(x, y):
    try:
        x, y = float(x), float(y)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("Coordinates must be valid finite numbers.") from exc
    if not (isfinite(x) and isfinite(y)):
        raise ValueError("Coordinates must be valid finite numbers.")
    return x, y


def _lat_lon(lat, lon):
    lat, lon = _finite_pair(lat, lon)
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        raise ValueError("Latitude must be within ±90° and longitude within ±180°.")
    return lat, lon


def _within_zone(zone, lat, lon, tolerance=0.0):
    area = kalianpur_crs(zone).area_of_use
    return (area.south - tolerance <= lat <= area.north + tolerance
            and area.west - tolerance <= lon <= area.east + tolerance)


def detect_kalianpur_zone(lat, lon):
    """Suggest a supported zone; never substitute a nearest or default zone."""
    try:
        lat, lon = _lat_lon(lat, lon)
    except ValueError:
        return None, None, None
    for zone, info in ENHANCED_KALIANPUR_ZONES.items():
        if _within_zone(zone, lat, lon):
            return zone, info["epsg"], info["description"]
    return None, None, None


@lru_cache(maxsize=None)
def kalianpur_transformer(zone, inverse=False):
    crs = kalianpur_crs(zone)
    source, target = (crs, 4326) if inverse else (4326, crs)
    try:
        return Transformer.from_crs(
            source, target, always_xy=True, allow_ballpark=False,
        )
    except ProjError as exc:
        raise ValueError(f"No verified datum transformation is available for {zone}.") from exc


def wgs84_to_kalianpur(lat, lon):
    lat, lon = _lat_lon(lat, lon)
    zone, code, _ = detect_kalianpur_zone(lat, lon)
    if zone is None:
        raise ValueError("Outside supported Kalianpur 1975 coverage; no default zone is used.")
    easting, northing = kalianpur_transformer(zone).transform(lon, lat, errcheck=True)
    easting, northing = _finite_pair(easting, northing)
    return zone, code, easting, northing


def kalianpur_to_wgs84(easting, northing, zone):
    easting, northing = _finite_pair(easting, northing)
    lon, lat = kalianpur_transformer(zone, inverse=True).transform(
        easting, northing, errcheck=True,
    )
    lat, lon = _lat_lon(lat, lon)
    # A centimetre-scale angular allowance covers floating-point round-off
    # at exact EPSG box edges, not a nearest-zone coverage extension.
    if not _within_zone(zone, lat, lon, tolerance=1e-7):
        raise ValueError(f"Coordinates fall outside the area of use of {zone}; check the source zone.")
    return lon, lat
