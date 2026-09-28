"""Validate Trimble Mobile Manager positions; never infer RTK from browser accuracy."""
from datetime import datetime
import math
import time

STATUS = {1: 'Autonomous', 2: 'DGPS', 4: 'FIXED (receiver reported)', 5: 'FLOAT'}
NUMBERS = ('latitude', 'longitude', 'altitude', 'mslHeight', 'undulation', 'hrms',
           'vrms', 'diffAge', 'hdop', 'battery', 'satellites', 'totalSatInUse')
TEXT = ('receiverModel', 'geoidModel', 'sourceReferenceFrameName',
        'targetReferenceFrameName', 'sourceReferenceFrameEpoch',
        'targetReferenceFrameEpoch', 'sourceReferenceFrameEpsgCode',
        'targetReferenceFrameEpsgCode', 'diffID', 'utcTimeStamp')


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return float(value) if math.isfinite(value) else None
    except (OverflowError, ValueError):
        return None


def position(payload, now=None):
    """Require receiver UTC, not just a recent browser arrival timestamp."""
    now = time.time() if now is None else now
    if not isinstance(payload, dict):
        raise ValueError('No receiver position received.')
    result = {key: number(payload.get(key)) for key in NUMBERS}
    for key in ('hrms', 'vrms', 'diffAge', 'hdop', 'satellites', 'totalSatInUse', 'battery'):
        if result[key] is not None and result[key] < 0:
            result[key] = None
    for key in TEXT:
        value = payload.get(key)
        result[key] = str(value)[:160] if isinstance(value, (str, int, float)) and not isinstance(value, bool) else ''
    lat, lon = result['latitude'], result['longitude']
    if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
        raise ValueError('Receiver has no valid latitude/longitude.')
    try:
        stamp = datetime.fromisoformat(result['utcTimeStamp'].replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            raise ValueError
        age = now - stamp.timestamp()
    except (ValueError, TypeError, OverflowError):
        raise ValueError('Receiver UTC timestamp is missing or invalid; position cannot be verified as current.') from None
    if not -2 <= age <= 5:
        raise ValueError('Receiver position is stale or its UTC clock is incorrect.')
    status = number(payload.get('diffStatus'))
    result['diffStatus'] = int(status) if status in STATUS else None
    result['status'] = STATUS.get(result['diffStatus'], 'No valid solution / unknown')
    result['age_s'] = max(0, age)
    return result


def logging_issues(fix, datum_confirmed, height_confirmed, horizontal=0.02, vertical=0.05, correction=10):
    issues = []
    if fix['diffStatus'] != 4:
        issues.append('Receiver must report FIXED.')
    for key, limit, label in [('hrms', horizontal, 'Horizontal RMS'), ('vrms', vertical, 'Vertical RMS'), ('diffAge', correction, 'Correction age')]:
        if fix[key] is None or fix[key] > limit:
            issues.append(f'{label} is unavailable or exceeds the selected limit.')
    if fix['altitude'] is None and fix['mslHeight'] is None:
        issues.append('Receiver height is unavailable.')
    if not datum_confirmed:
        issues.append('Confirm the output reference frame before grid conversion or recording.')
    if not height_confirmed:
        issues.append('Confirm the height reference and pole-height setting before recording.')
    return issues


def csv_safe(row):
    """Prevent user/receiver text being interpreted as spreadsheet formulas."""
    return {k: "'" + v if isinstance(v, str) and v.lstrip().startswith(('=', '+', '-', '@')) else v
            for k, v in row.items()}
