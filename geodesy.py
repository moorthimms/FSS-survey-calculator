"""Kalianpur EPSG conversions and DSM LCC zones from the supplied parameter table.

EPSG areas of use are bounding boxes, not administrative boundary polygons.
They reject unsupported coverage but do not establish a map's source datum.
"""

from functools import lru_cache
import json
from math import isfinite
from pathlib import Path

from pyproj import CRS, Transformer
from pyproj.crs import ProjectedCRS
from pyproj.crs.coordinate_operation import LambertConformalConic2SPConversion
from pyproj.exceptions import ProjError


KALIANPUR_EPSG = {
    "Zone I": 24378,
    "Zone IIa": 24379,
    "Zone IIb": 24380,
    "Zone IIIa": 24381,
    "Zone IVa": 24383,
}

DSM_TABLE = json.loads(
    (Path(__file__).resolve().parent / "data" / "dsm_zones.json").read_text(encoding="utf-8")
)


def _table_degrees(text):
    degrees, minutes, seconds = map(float, text.split())
    return degrees + minutes / 60 + seconds / 3600


# Original DMS values and rounded scale factors are retained for reference.
DSM_ZONES = {
    row["zone"]: {
        **row,
        "longitude_of_origin": _table_degrees(row["longitude_of_origin_dms"]),
        "latitude_of_origin": _table_degrees(row["latitude_of_origin_dms"]),
        "standard_parallel_1": _table_degrees(row["standard_parallel_1_dms"]),
        "standard_parallel_2": _table_degrees(row["standard_parallel_2_dms"]),
    }
    for row in DSM_TABLE["zones"]
}


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


@lru_cache(maxsize=None)
def dsm_crs(zone):
    """Build a custom WGS84 LCC 2SP CRS; never invent an EPSG identifier."""
    if zone not in DSM_ZONES:
        raise ValueError(f"Unsupported DSM zone: {zone}; it is not in the supplied table.")
    p = DSM_ZONES[zone]
    # The 2SP definition already determines central scale. Passing the printed
    # factor as k_0 would add a second scaling (PROJ's Michigan variant).
    conversion = LambertConformalConic2SPConversion(
        latitude_first_parallel=p["standard_parallel_1"],
        latitude_second_parallel=p["standard_parallel_2"],
        latitude_false_origin=p["latitude_of_origin"],
        longitude_false_origin=p["longitude_of_origin"],
        easting_false_origin=p["false_easting_m"],
        northing_false_origin=p["false_northing_m"],
    )
    return ProjectedCRS(
        name=f"DSM {zone} / WGS 84 LCC (supplied parameters)",
        conversion=conversion, geodetic_crs=CRS.from_epsg(4326),
    )


def dsm_zone_candidates(lat, lon):
    """Suggest zones using nominal 8° x 6° bands, not authoritative boundaries.

    The photo provides projection parameters, not coverage polygons. A point
    on a shared band edge has multiple candidates and needs a selected zone.
    """
    try:
        lat, lon = _lat_lon(lat, lon)
    except ValueError:
        return []
    candidates = []
    for zone, p in DSM_ZONES.items():
        latitude_band_centre = int(p["latitude_of_origin"])
        if (latitude_band_centre - 3 <= lat <= latitude_band_centre + 3
                and p["longitude_of_origin"] - 4 <= lon <= p["longitude_of_origin"] + 4):
            candidates.append(zone)
    return candidates


def detect_dsm_zone(lat, lon):
    candidates = dsm_zone_candidates(lat, lon)
    return candidates[0] if len(candidates) == 1 else None


@lru_cache(maxsize=None)
def dsm_transformer(zone, inverse=False):
    crs = dsm_crs(zone)
    source, target = (crs, 4326) if inverse else (4326, crs)
    return Transformer.from_crs(source, target, always_xy=True, allow_ballpark=False)


def wgs84_to_dsm(lat, lon, zone=None):
    lat, lon = _lat_lon(lat, lon)
    if abs(lat) == 90:
        raise ValueError("DSM LCC conversion is not defined for this application at the poles.")
    if zone is None:
        candidates = dsm_zone_candidates(lat, lon)
        if len(candidates) != 1:
            detail = ", ".join(candidates) if candidates else "no nominal match"
            raise ValueError(f"Select the DSM zone from the map sheet ({detail}).")
        zone = candidates[0]
    e, n = dsm_transformer(zone).transform(lon, lat, errcheck=True)
    e, n = _finite_pair(e, n)
    return zone, e, n


def dsm_to_wgs84(easting, northing, zone):
    easting, northing = _finite_pair(easting, northing)
    lon, lat = dsm_transformer(zone, inverse=True).transform(easting, northing, errcheck=True)
    lat, lon = _lat_lon(lat, lon)
    if abs(lat) == 90:
        raise ValueError("DSM LCC conversion is not defined for this application at the poles.")
    return lon, lat


def kalianpur_to_dsm(easting, northing, source_zone, target_zone=None):
    lon, lat = kalianpur_to_wgs84(easting, northing, source_zone)
    return wgs84_to_dsm(lat, lon, target_zone)


def dsm_to_kalianpur(easting, northing, source_zone):
    lon, lat = dsm_to_wgs84(easting, northing, source_zone)
    return wgs84_to_kalianpur(lat, lon)
