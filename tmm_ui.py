"""Phone-side Mobile Manager integration for hosted and local Streamlit."""
from datetime import datetime, timezone
from pathlib import Path
import time
import uuid

import pandas as pd
import streamlit as st
import streamlit.components.v1 as components

from tmm import position, logging_issues, csv_safe

_component = components.declare_component('fss_trimble_mobile_manager', path=str(Path(__file__).parent / 'tmm_component'))


def setup_help():
    with st.expander('R12 phone setup and connection help'):
        st.markdown('''1. Install **Trimble Mobile Manager (TMM)** on this phone and connect your R12 in TMM.
2. Configure your NTRIP/CORS, base or supported correction service in TMM/receiver. Check solution quality there first.
3. Confirm the output reference frame, geoid and antenna/pole height. Apply the pole offset only once.
4. Keep TMM running, return here, select the API and press **Connect Mobile Manager**. Allow local-network access if your browser asks.

**V1 compatibility** needs no Application ID; Trimble still supports it but recommends V2 for new integrations. **V2** must already be unlocked by registering a valid Trimble Application ID through its supported native integration. This website cannot perform native app registration or invent an ID. [Trimble integration instructions](https://developer.trimble.com/docs/mobile-manager/guides/integrate/).

Connections use TMM's secure local service on **this phone**, not a cloud-server connection. Internet/DNS is required for the Trimble service hostname. If a port was reassigned, enter the secure WebSocket port reported by your TMM integration. Browser/OS restrictions or an older TMM version may prevent this connection. Do not disable browser security.

**Alternative: Phone / browser mode.** Android: select TMM as the mock location provider and disable its battery optimization. iPhone: receiver location can be shared through iOS; its accuracy is reported no better than 5 m, and TMM output transformations are not applied on that path. Verify the feed on your device. Ordinary browser location cannot confirm FIX status or detect every fallback to internal GPS.

[Trimble location sharing](https://help.fieldsystems.trimble.com/trimble-mobile-manager/location-sharing.htm) · [API ports](https://developer.trimble.com/docs/mobile-manager/guides/servers/)''')


def fresh_payload(payload, received_at, now=None):
    now = time.time() if now is None else now
    if isinstance(received_at, bool) or not isinstance(received_at, (int, float)) or not -2 <= now - received_at / 1000 <= 5:
        raise ValueError('Phone data is missing or stale. Reconnect for a fresh position.')
    return position(payload, now=now)


def metric_value(value, unit=''):
    return 'Unavailable' if value is None else f'{value:.3f}{unit}'


@st.fragment(run_every=1)
def render_tmm(display_coordinates):
    st.subheader('Trimble R12 / Mobile Manager')
    st.caption('Receiver position, quality and height via Mobile Manager on this phone. Corrections remain managed in TMM or the receiver.')
    setup_help()
    version_label = st.selectbox('Mobile Manager API', ['V1 compatibility — no Application ID', 'V2 — registered integration'], key='tmm_api')
    version = 'V2' if version_label.startswith('V2') else 'V1'
    if version == 'V2':
        st.info('V2 requires a valid Trimble Application ID registered with TMM. If not yet registered, use the supported V1 compatibility option.')
    port = st.number_input('Secure TMM WebSocket port', min_value=1, max_value=65535,
                           value=9640 if version == 'V2' else 9636, key='tmm_port_' + version)
    datum = st.checkbox('TMM output reference frame is confirmed compatible with WGS84 for this survey', key='tmm_datum')
    height = st.checkbox('I confirmed the height reference and pole-height correction in TMM; no second offset is needed', key='tmm_height')
    with st.expander('Point recording settings'):
        horizontal = st.number_input('Maximum horizontal RMS (m)', min_value=0.001, max_value=10.0, value=0.020, step=0.001, format='%.3f', key='tmm_hrms')
        vertical = st.number_input('Maximum vertical RMS (m)', min_value=0.001, max_value=10.0, value=0.050, step=0.001, format='%.3f', key='tmm_vrms')
        correction = st.number_input('Maximum correction age (s)', min_value=1.0, max_value=60.0, value=10.0, key='tmm_correction')
        name = st.text_input('Point name', key='tmm_point_name')
    nonce = st.session_state.setdefault('tmm_nonce', uuid.uuid4().hex) + ':' + version + ':' + str(port)
    points = st.session_state.setdefault('tmm_points', [])
    value = _component(nonce=nonce, version=version, port=int(port), canRecord=datum and height and len(points) < 10000,
                       key='tmm_live_' + nonce, default=None)
    current = None
    if isinstance(value, dict) and value.get('nonce') == nonce:
        if value.get('connected') is True:
            try:
                current = fresh_payload(value.get('payload'), value.get('receivedAt'))
            except ValueError as exc:
                st.warning(str(exc))
        else:
            st.info(str(value.get('status', 'Disconnected.'))[:500])
    else:
        st.info('Open Mobile Manager on this phone, then use Connect above.')
    if current:
        st.write(f"**Solution:** {current['status']} · **Receiver:** {current['receiverModel'] or 'Unavailable'}")
        a, b, c = st.columns(3)
        a.metric('Horizontal RMS (receiver)', metric_value(current['hrms'], ' m'))
        b.metric('Vertical RMS (receiver)', metric_value(current['vrms'], ' m'))
        c.metric('Correction age', metric_value(current['diffAge'], ' s'))
        st.caption(f"UTC: {current['utcTimeStamp']} · Position age: {current['age_s']:.1f} s · Satellites used: {current['totalSatInUse'] if current['totalSatInUse'] is not None else 'Unavailable'} · Satellites visible: {current['satellites'] if current['satellites'] is not None else 'Unavailable'}")
        st.caption('RMS values are receiver estimates, not browser accuracy radii or independently measured field error. FIXED alone does not guarantee centimetre accuracy.')
        issues = logging_issues(current, datum, height, horizontal, vertical, correction)
        if issues:
            st.warning(' '.join(issues))
        else:
            st.success('Current receiver measurements meet your recording limits. Record next position captures and rechecks the next receiver sample.')
        if current['diffStatus'] in (1, 2, 4, 5):
            st.subheader('Automatic height')
            h1, h2 = st.columns(2)
            h1.metric('Altitude (TMM output)', metric_value(current['altitude'], ' m'))
            h2.metric('MSL height (TMM output)', metric_value(current['mslHeight'], ' m'))
            st.caption(f"Geoid: {current['geoidModel'] or 'Unavailable'} · Undulation: {metric_value(current['undulation'], ' m')}. TMM height settings are retained; the app applies no additional pole offset. Altitude is not relabelled ellipsoidal or ground height without a confirmed reference.")
            st.write(f"**Source frame:** {current['sourceReferenceFrameName'] or 'Unavailable'} · **Output frame:** {current['targetReferenceFrameName'] or 'Unavailable'}")
            if datum:
                display_coordinates(current['latitude'], current['longitude'])
                st.map(pd.DataFrame([{'lat':current['latitude'], 'lon':current['longitude']}]))
            else:
                st.write(f"Receiver coordinates: {current['latitude']:.9f}, {current['longitude']:.9f}")
    capture = value.get('capture') if isinstance(value, dict) and value.get('nonce') == nonce else None
    if isinstance(capture, dict) and isinstance(capture.get('id'), str):
        token = nonce + ':' + capture['id']
        if st.session_state.get('tmm_last_capture') != token:
            st.session_state['tmm_last_capture'] = token
            try:
                if not current or len(points) >= 10000:
                    raise ValueError('No current connection/position, or the session point limit was reached.')
                fix = fresh_payload(capture.get('payload'), capture.get('receivedAt'))
                issues = logging_issues(fix, datum, height, horizontal, vertical, correction)
                issues += logging_issues(current, datum, height, horizontal, vertical, correction)
                if issues:
                    raise ValueError(' '.join(dict.fromkeys(issues)))
                row = dict(fix, point_name=name, source='Trimble Mobile Manager ' + version,
                           recorded_at_utc=datetime.now(timezone.utc).isoformat(),
                           datum_confirmation='User-confirmed WGS84 compatible',
                           height_confirmation='TMM height reference/offset confirmed; no app offset',
                           horizontal_limit_m=horizontal, vertical_limit_m=vertical, correction_limit_s=correction)
                points.append(row)
                st.session_state['tmm_record_result'] = ('success', f'Point {len(points)} recorded.')
            except ValueError as exc:
                st.session_state['tmm_record_result'] = ('warning', 'Point not recorded: ' + str(exc))
    result = st.session_state.get('tmm_record_result')
    if result:
        getattr(st, result[0])(result[1])
    if points:
        st.caption(f'{len(points)} TMM points held in this session; download before closing. Maximum 10,000 points.')
        st.download_button('Download Trimble points (CSV)', pd.DataFrame([csv_safe(p) for p in points]).to_csv(index=False),
                           'trimble_points.csv', 'text/csv', key='tmm_export')
