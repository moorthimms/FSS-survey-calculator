"""Phone snapshots and opt-in live local RTK receiver controls."""

from datetime import datetime, timezone
import math
import time

import pandas as pd
import streamlit as st
import streamlit_js_eval

from gnss import quality_issues
from rtk_receiver import LiveReceiver, NtripSettings, local_receiver_enabled


def gnss_dms(value, latitude):
    ticks = round(abs(value) * 3600 * 10000)
    degrees, ticks = divmod(ticks, 3600 * 10000)
    minutes, ticks = divmod(ticks, 60 * 10000)
    direction = ("N" if value >= 0 else "S") if latitude else ("E" if value >= 0 else "W")
    return f"{degrees}°{minutes:02d}′{ticks / 10000:07.4f}″{direction}"


def reported(value, unit=""):
    return "unreported" if value is None else f"{value}{unit}"


def optional_height_number(value, nonnegative=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) and (not nonnegative or number >= 0) else None


def show_browser_height(location):
    coords = location["coords"]
    height = optional_height_number(coords.get("altitude"))
    accuracy = optional_height_number(coords.get("altitudeAccuracy"), nonnegative=True)
    st.subheader("Automatic height")
    if height is None:
        st.info("Height unavailable: this device/browser did not report a valid altitude.")
        return
    h, a = st.columns(2)
    h.metric("Height (WGS84 ellipsoid)", f"{height:.2f} m")
    a.metric("Vertical accuracy (browser)", f"{accuracy:.2f} m" if accuracy is not None else "Unreported")
    st.caption("Device-reported height for this position and timestamp, relative to the WGS84 ellipsoid. Sea-level elevation needs a geoid correction. No device-height offset is applied.")
    st.code(f"Ellipsoidal height: {height:.3f} m", language="text")


def show_receiver_height(fix):
    msl = optional_height_number(fix.get("altitude_msl_m"))
    ellipsoid = optional_height_number(fix.get("altitude_ellipsoid_m"))
    separation = optional_height_number(fix.get("geoid_separation_m"))
    uncertainty = optional_height_number(fix.get("height_sigma_m"), nonnegative=True)
    st.subheader("Automatic height")
    if msl is None and ellipsoid is None:
        st.info("Height unavailable: the current receiver fix did not report a valid altitude.")
        return
    h1, h2, h3 = st.columns(3)
    h1.metric("Height (MSL, receiver)", f"{msl:.3f} m" if msl is not None else "Unreported")
    h2.metric("Height (ellipsoid, receiver)", f"{ellipsoid:.3f} m" if ellipsoid is not None else "Unreported")
    h3.metric("Vertical uncertainty (GST, 1σ)", f"{uncertainty:.3f} m" if uncertainty is not None else "Unreported")
    st.caption(f"Receiver geoid separation: {reported(separation, ' m')}. Ellipsoidal height = receiver MSL height + geoid separation. Heights refer to the antenna; no pole-height or vertical-datum correction is applied.")
    st.caption("Height uncertainty is reported separately from the horizontal limits used for point logging. Available height fields are retained in RTK CSV exports.")


BROWSER_SCAN = """
new Promise((resolve) => {
    let best = null, watchId = null, timer = null, done = false;
    const finish = (result) => {
        if (done) return;
        done = true;
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        if (timer !== null) clearTimeout(timer);
        resolve(result);
    };
    const error = (code, message) => ({error: {code, message}});
    if (!navigator.geolocation) {
        finish(error(2, 'Geolocation is unavailable in this browser.'));
        return;
    }
    timer = setTimeout(() => finish(best || error(3, 'No fresh position acquired.')), 15000);
    try {
        watchId = navigator.geolocation.watchPosition((pos) => {
            const c = pos.coords;
            if (![c.latitude, c.longitude, c.accuracy, pos.timestamp].every(Number.isFinite)
                || c.accuracy < 0 || Math.abs(c.latitude) > 90 || Math.abs(c.longitude) > 180
                || Math.abs(Date.now() - pos.timestamp) > 30000) return;
            const hasHeight = Number.isFinite(c.altitude);
            const value = {coords: {latitude: c.latitude, longitude: c.longitude,
                accuracy: c.accuracy, altitude: hasHeight ? c.altitude : null,
                altitudeAccuracy: hasHeight && Number.isFinite(c.altitudeAccuracy) && c.altitudeAccuracy >= 0
                    ? c.altitudeAccuracy : null},
                timestamp: pos.timestamp};
            // Prefer a complete 3D sample. Keep its coordinates and height together.
            const bestHasHeight = best && Number.isFinite(best.coords.altitude);
            if (!best || (hasHeight && !bestHasHeight)
                || (hasHeight === bestHasHeight && c.accuracy < best.coords.accuracy)) best = value;
            // Continue the bounded scan when an early horizontal fix lacks altitude.
            if (c.accuracy <= 1 && hasHeight) finish(best);
        }, (err) => {
            if (err.code === 1) finish(error(err.code, err.message));
        }, {enableHighAccuracy: true, maximumAge: 0, timeout: 15000});
        if (done && watchId !== null) navigator.geolocation.clearWatch(watchId);
    } catch (err) { finish(error(2, err.message)); }
})
"""


def browser_coordinates(location, now=None):
    now = time.time() if now is None else now
    try:
        coords = location["coords"]
        lat, lon, accuracy = [float(coords[key]) for key in ("latitude", "longitude", "accuracy")]
        stamp = float(location["timestamp"]) / 1000
        if not all(math.isfinite(x) for x in (lat, lon, accuracy, stamp)):
            raise ValueError
        if abs(lat) > 90 or abs(lon) > 180 or accuracy < 0:
            raise ValueError
    except (KeyError, TypeError, ValueError, OverflowError):
        raise ValueError("Browser returned invalid or incomplete position data.") from None
    if not -5 <= now - stamp <= 30:
        raise ValueError("Browser position is stale. Press Refresh position to scan again.")
    return lat, lon, accuracy, stamp


def render_browser(display_coordinates):
    st.caption("Requests browser location and height for up to 15 seconds, preferring a complete 3D sample when available. Metre or centimetre accuracy is not guaranteed; this does not apply RTK corrections.")
    if not st.checkbox("Get Own Position", key="get_pos_checkbox"):
        return
    if st.button("Refresh position", key="refresh_browser_position"):
        st.session_state["position_scan"] = st.session_state.get("position_scan", 0) + 1
    location = streamlit_js_eval.streamlit_js_eval(js_expressions=BROWSER_SCAN, want_output=True,
                                key=f"get_loc_accurate_{st.session_state.get('position_scan', 0)}")
    if not location:
        st.info("Waiting for location permission and a fresh position…")
        return
    if isinstance(location, dict) and location.get("error"):
        st.warning("Could not retrieve location. Allow location access and press Refresh position.")
        return
    try:
        lat, lon, accuracy, stamp = browser_coordinates(location)
    except ValueError as exc:
        st.warning(str(exc))
        return
    st.success(f"Location acquired. Browser-reported horizontal accuracy: {accuracy:.2f} m.")
    st.caption("Browser accuracy is an estimated radius, not an RTK FIX or a measurement of field error. Refresh after moving.")
    st.caption(f"Position time (UTC): {datetime.fromtimestamp(stamp, timezone.utc).isoformat()}")
    show_browser_height(location)
    display_coordinates(lat, lon)


def receiver_issues(snapshot, horizontal_limit, correction_limit):
    issues = quality_issues(snapshot["fix"], horizontal_limit, correction_limit)
    if not snapshot["connected"]:
        issues.append("Receiver is disconnected.")
    if snapshot.get("ntrip_enabled"):
        stamp = snapshot["last_rtcm_at"]
        if stamp is None or time.time() - stamp > correction_limit:
            issues.append("The app's correction stream is missing or stale.")
    return issues


@st.fragment(run_every=1)
def render_external(display_coordinates):
    if not local_receiver_enabled():
        st.info("Live serial mode requires this app to run on the computer connected to your RTK receiver. The hosted server cannot access your phone or computer's Bluetooth port.")
        st.caption("For local setup, follow the RTK section in README: pair USB/Bluetooth COM, enable FSS_ENABLE_LOCAL_GNSS=1, then run Streamlit. For direct Android/iPhone support, the receiver model and its connection protocol are needed.")
        return
    st.caption("Use a receiver configured to output checksummed NMEA GGA and GST at 1 Hz or faster. Correction input must accept RTCM3 on this same serial port. The receiver computes RTK; the app forwards corrections and displays its measurements.")
    receiver = st.session_state.get("live_receiver")
    snapshot = receiver.snapshot() if receiver else None
    if not receiver or not snapshot["connected"]:
        if receiver:
            if snapshot["receiver_error"]:
                st.warning(snapshot["receiver_error"])
            receiver.close()
            st.session_state.pop("live_receiver", None)
        from serial.tools.list_ports import comports
        ports = [port.device for port in comports()]
        st.caption("Detected serial ports: " + (", ".join(ports) or "none; pair the receiver first or enter its port"))
        use_ntrip = st.checkbox("Forward NTRIP corrections through this app", key="use_ntrip")
        st.caption("Leave this off if your receiver already receives corrections through its own radio, modem or receiver app.")
        with st.form("receiver_connection", clear_on_submit=True):
            port = st.text_input("Receiver serial port", value=ports[0] if ports else "", placeholder="COM5 or /dev/ttyUSB0")
            baud = st.selectbox("Receiver baud rate", [9600, 38400, 57600, 115200, 230400, 460800], index=3)
            host = st.text_input("NTRIP caster hostname", disabled=not use_ntrip)
            caster_port = st.number_input("NTRIP port", min_value=1, max_value=65535, value=443, disabled=not use_ntrip)
            mount = st.text_input("NTRIP mountpoint", disabled=not use_ntrip)
            tls = st.checkbox("Use TLS (HTTPS)", value=True, disabled=not use_ntrip)
            username = st.text_input("NTRIP username", disabled=not use_ntrip)
            password = st.text_input("NTRIP password", type="password", disabled=not use_ntrip)
            st.caption("NTRIP v2 / RTCM3 is supported. GGA is sent to the caster for VRS. Credentials stay in this local session; plain HTTP sends credentials without encryption.")
            if st.form_submit_button("Connect receiver"):
                try:
                    settings = NtripSettings(host.strip(), int(caster_port), mount.strip(), username, password, tls) if use_ntrip else None
                    if not port.strip():
                        raise ValueError("Receiver serial port is required.")
                    st.session_state["live_receiver"] = LiveReceiver(port.strip(), baud, settings)
                    st.rerun()
                except ValueError as exc:
                    st.error(str(exc))
                except Exception:
                    st.error("Could not open receiver. Check the port, driver and baud rate, and close other apps using the port.")
        return
    if st.button("Disconnect receiver", key="disconnect_receiver"):
        receiver.close()
        st.session_state.pop("live_receiver", None)
        st.rerun()
    st.write(f"**Correction link:** {snapshot['ntrip_status']}")
    st.caption(f"RTCM3 bytes forwarded: {snapshot['rtcm_bytes']}; rejected GGA/GST sentences: {snapshot['invalid_sentences']}")
    if snapshot["last_rtcm_at"] is not None:
        st.caption(f"Last verified correction frame: {max(0, time.time() - snapshot['last_rtcm_at']):.1f} seconds ago")
    fix = snapshot["fix"]
    if not fix:
        st.info("Waiting for receiver GGA. Check that NMEA output is enabled on this port.")
        return
    st.write(f"**Fix status:** {fix['fix_label']}")
    st.write(f"**Position age:** {fix['age_s']:.1f} s · **Satellites:** {reported(fix['satellites'])} · **HDOP:** {reported(fix['hdop'])}")
    st.write(f"**Correction age:** {reported(fix['correction_age_s'], ' s')} · **Reference station:** {fix['station_id'] or 'unreported'}")
    uncertainty = fix["horizontal_sigma_rss_m"]
    st.write("**Horizontal uncertainty (GST, 1σ RSS):** " + (f"{uncertainty:.4f} m" if uncertainty is not None else "unreported for this epoch"))
    st.caption("HDOP is dimensionless. RTK FIX alone does not establish 1–2 cm accuracy. GST is the receiver's estimated uncertainty, not independently measured error.")
    horizontal_limit = st.number_input("Maximum horizontal uncertainty for logging (m)", min_value=0.001, max_value=10.0, value=0.02, step=0.001, format="%.3f", key="rtk_horizontal_limit")
    correction_limit = st.number_input("Maximum correction age for logging (s)", min_value=1.0, max_value=60.0, value=10.0, key="rtk_correction_limit")
    datum_confirmed = st.checkbox("Receiver output datum/realization is confirmed compatible with WGS84 for this survey", key="rtk_datum_confirmed")
    issues = receiver_issues(snapshot, horizontal_limit, correction_limit)
    if not datum_confirmed:
        issues.append("Confirm the receiver output datum before WGS84 grid conversion and point logging.")
    if issues:
        st.warning(" ".join(issues))
    else:
        st.success("Receiver measurements meet the selected logging limits.")
    if fix["fresh"] and fix["quality"] in (1, 2, 3, 4, 5):
        if datum_confirmed:
            display_coordinates(fix["latitude"], fix["longitude"])
        else:
            st.write(f"Receiver latitude/longitude: {fix['latitude']:.9f}, {fix['longitude']:.9f}")
        show_receiver_height(fix)
    point_name = st.text_input("Point name", key="rtk_point_name")
    points = st.session_state.setdefault("rtk_points", [])
    if st.button("Log RTK point", disabled=bool(issues) or len(points) >= 10000):
        # Re-read on the click; never log a previously displayed FIX after loss.
        latest = receiver.snapshot()
        if not datum_confirmed or receiver_issues(latest, horizontal_limit, correction_limit):
            st.warning("Receiver quality changed. Point was not logged.")
        else:
            row = {key: value for key, value in latest["fix"].items()
                   if key not in ("sentence", "type", "fresh")}
            row.update(point_name=point_name, source="External RTK receiver", recorded_at_utc=datetime.now(timezone.utc).isoformat(),
                       datum="User-confirmed WGS84-compatible receiver output",
                       horizontal_limit_m=horizontal_limit, correction_limit_s=correction_limit)
            points.append(row)
            st.success(f"Logged point {len(points)}.")
    if points:
        st.caption(f"{len(points)} points held in this session. Download before closing the app; maximum 10,000 points.")
        st.download_button("Download RTK points (CSV)", pd.DataFrame(points).to_csv(index=False),
                           "rtk_points.csv", "text/csv", key="rtk_point_export")


def render_own_position(display_coordinates):
    source = st.radio("Position source", ["Phone / browser", "External RTK receiver (local USB/Bluetooth)"], key="position_source")
    if source == "Phone / browser":
        receiver = st.session_state.pop("live_receiver", None)
        if receiver:
            receiver.close()
        render_browser(display_coordinates)
    else:
        render_external(display_coordinates)
