import streamlit as st
import pandas as pd
from math import radians, sin, cos, sqrt, atan2, degrees
import re
import json
import os

# ==========================================
# 0. PATH SETUP (Fix for missing images)
# ==========================================
# This ensures images are found regardless of how the app is run
current_dir = os.path.dirname(os.path.abspath(__file__))
logo_path = os.path.join(current_dir, "FSS Logo.png")
icon_path = os.path.join(current_dir, "icon.ico")
result_img_path = os.path.join(current_dir, "result.png")

# ==========================================
# 1. CONFIGURATION & CONSTANTS
# ==========================================

st.set_page_config(
    page_title="FSS Survey Calculator",
    page_icon=icon_path if os.path.exists(icon_path) else None, # Uses the .ico file
    layout="wide",
    initial_sidebar_state="expanded"
)

# --- DEPENDENCY CHECKS ---
try:
    from streamlit_js_eval import streamlit_js_eval
except ImportError:
    st.error("⚠️ Library 'streamlit-js-eval' is missing. Please run: `pip install streamlit-js-eval`")
    st.stop()

try:
    from geodesy import (
        DSM_TABLE, DSM_ZONES, DSM_ZONE_CATALOG, ENHANCED_KALIANPUR_ZONES,
        KALIANPUR_ZONE_CATALOG, ORIGINAL_ZONE_CATALOG,
        detect_dsm_zone, dsm_to_kalianpur, dsm_to_wgs84, dsm_zone_candidates,
        detect_kalianpur_zone, kalianpur_to_dsm, kalianpur_to_wgs84,
        kalianpur_transformer, wgs84_to_dsm, wgs84_to_kalianpur,
        zone_definition_issue, zone_reference_rows,
    )
except ImportError:
    st.error("⚠️ Library 'pyproj' is missing. Please run: `pip install pyproj`")
    st.stop()

# Custom CSS to mimic the Kivy app's style
st.markdown("""
    <style>
    .stButton>button {
        width: 100%;
        background-color: #1976D2;
        color: white;
    }
    .stButton>button:hover {
        background-color: #1565C0;
        color: white;
    }
    .result-box {
        padding: 20px;
        border-radius: 10px;
        background-color: #f0f2f6;
        border-left: 5px solid #1976D2;
        margin-top: 20px;
        margin-bottom: 20px;
    }
    .header-style {
        font-size: 24px;
        font-weight: bold;
        color: #1976D2;
        margin-bottom: 20px;
    }
    </style>
""", unsafe_allow_html=True)

# --- REGIONAL REFERENCES ---

WGS84_ZONES = {
    'India Northeast': {'epsg': 7771, 'bounds': {'lat_min': 21.94, 'lat_max': 29.47, 'lon_min': 89.69, 'lon_max': 97.42}},
    'Uttar Pradesh': {'epsg': 7775, 'bounds': {'lat_min': 25.0, 'lat_max': 31.5, 'lon_min': 78.0, 'lon_max': 84.0}},
    'Kerala': {'epsg': 7781, 'bounds': {'lat_min': 8.0, 'lat_max': 13.0, 'lon_min': 74.0, 'lon_max': 77.0}},
    'Lakshadweep': {'epsg': 7782, 'bounds': {'lat_min': 10.0, 'lat_max': 13.0, 'lon_min': 71.0, 'lon_max': 74.0}},
    'Tamil Nadu': {'epsg': 7785, 'bounds': {'lat_min': 8.02, 'lat_max': 13.59, 'lon_min': 76.22, 'lon_max': 80.4}},
    'Jammu and Kashmir': {'epsg': 7764, 'bounds': {'lat_min': 32.0, 'lat_max': 37.0, 'lon_min': 73.0, 'lon_max': 78.0}},
    'Gujarat': {'epsg': 7761, 'bounds': {'lat_min': 20.0, 'lat_max': 24.0, 'lon_min': 68.0, 'lon_max': 74.0}},
    'Maharashtra': {'epsg': 7767, 'bounds': {'lat_min': 17.0, 'lat_max': 22.0, 'lon_min': 72.0, 'lon_max': 80.0}},
    'India NSF LCC': {'epsg': 7755, 'bounds': {'lat_min': 3.87, 'lat_max': 35.51, 'lon_min': 65.6, 'lon_max': 97.42}},
}

# ==========================================
# 2. HELPER FUNCTIONS
# ==========================================

def validate_input(input_str):
    if input_str is None or str(input_str).strip() == "":
        return None
    try:
        value = float(str(input_str).strip())
        return value if math_isfinite(value) else None
    except ValueError:
        return None

def math_isfinite(value):
    """Return True only for finite numeric values."""
    return not (value != value or value in (float("inf"), float("-inf")))

def validate_lat_lon(lat, lon):
    """Validate WGS84 latitude/longitude values and return an error message."""
    if lat is None or lon is None:
        return "Please enter valid numeric coordinates."
    if not -90 <= lat <= 90:
        return "Latitude must be between -90 and 90 degrees."
    if not -180 <= lon <= 180:
        return "Longitude must be between -180 and 180 degrees."
    return None

def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0
    lat1_rad, lon1_rad = radians(lat1), radians(lon1)
    lat2_rad, lon2_rad = radians(lat2), radians(lon2)
    dlat = lat2_rad - lat1_rad
    dlon = lon2_rad - lon1_rad
    a = sin(dlat / 2)**2 + cos(lat1_rad) * cos(lat2_rad) * sin(dlon / 2)**2
    a = min(1.0, max(0.0, a))
    c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return round(R * c, 3)

def bearing_latlon(lat1, lon1, lat2, lon2):
    lat1_rad, lon1_rad = radians(lat1), radians(lon1)
    lat2_rad, lon2_rad = radians(lat2), radians(lon2)
    dlon = lon2_rad - lon1_rad
    x = sin(dlon) * cos(lat2_rad)
    y = cos(lat1_rad) * sin(lat2_rad) - sin(lat1_rad) * cos(lat2_rad) * cos(dlon)
    bearing_rad = atan2(x, y)
    bearing_deg = degrees(bearing_rad)
    bearing_deg = (bearing_deg + 360) % 360
    return round(bearing_deg, 2)

def format_bearing(bearing_deg):
    total_seconds = round((bearing_deg % 360) * 3600, 1)
    if total_seconds >= 360 * 3600:
        total_seconds = 0.0
    degrees_part = int(total_seconds // 3600)
    minutes_part = int((total_seconds % 3600) // 60)
    seconds_part = total_seconds % 60
    return f"{degrees_part}°{minutes_part}'{seconds_part}\""

def decimal_to_dms(decimal_degrees, coord_type):
    abs_degrees = abs(decimal_degrees)
    degrees = int(abs_degrees)
    minutes_float = (abs_degrees - degrees) * 60
    minutes = int(minutes_float)
    seconds = (minutes_float - minutes) * 60
    if coord_type == 'lat':
        direction = 'N' if decimal_degrees >= 0 else 'S'
    else:
        direction = 'E' if decimal_degrees >= 0 else 'W'
    return f"{degrees}°{minutes}'{seconds:.2f}\"{direction}"

def dms_to_decimal(dms_str, coord_type=None):
    pattern = r"^\s*(\d{1,3})\s*[°º]\s*(\d{1,2})\s*['′]\s*(\d+(?:\.\d+)?)\s*[\"″]?\s*([NSEWnsew])\s*$"
    match = re.match(pattern, str(dms_str))
    if not match:
        raise ValueError(f"Invalid DMS format: {dms_str}")
    degrees, minutes, seconds, hemisphere = match.groups()
    degrees, minutes, seconds = int(degrees), int(minutes), float(seconds)
    hemisphere = hemisphere.upper()
    if minutes >= 60 or seconds >= 60:
        raise ValueError("DMS minutes and seconds must be less than 60")
    if coord_type == "lat" and hemisphere not in ("N", "S"):
        raise ValueError("Latitude hemisphere must be N or S")
    if coord_type == "lon" and hemisphere not in ("E", "W"):
        raise ValueError("Longitude hemisphere must be E or W")
    maximum = 90 if hemisphere in ("N", "S") else 180
    if degrees > maximum or (degrees == maximum and (minutes or seconds)):
        raise ValueError(f"Degrees exceed the valid {maximum}° limit")
    decimal = degrees + minutes / 60 + seconds / 3600
    if hemisphere in ['S', 'W']:
        decimal = -decimal
    return decimal

def detect_wgs84_zone(lat, lon):
    if validate_lat_lon(lat, lon):
        return None, None
    # Exact Match
    for zone_name, zone_info in WGS84_ZONES.items():
        bounds = zone_info['bounds']
        if bounds['lat_min'] <= lat <= bounds['lat_max'] and bounds['lon_min'] <= lon <= bounds['lon_max']:
            return zone_name, zone_info['epsg']
            
    # Nearest Match
    best_zone = None
    min_dist = float('inf')
    
    for zone_name, zone_info in WGS84_ZONES.items():
        bounds = zone_info['bounds']
        d_lat = max(bounds['lat_min'] - lat, 0, lat - bounds['lat_max'])
        d_lon = max(bounds['lon_min'] - lon, 0, lon - bounds['lon_max'])
        dist = sqrt(d_lat**2 + d_lon**2)
        
        if dist < min_dist:
            min_dist = dist
            best_zone = (zone_name, zone_info)
            
    if best_zone and min_dist < 0.5:
        return f"{best_zone[0]} (Nearest)", best_zone[1]['epsg']
        
    return None, None

def distance_3d(x1, y1, z1, x2, y2, z2):
    dx = x2 - x1
    dy = y2 - y1
    dz = z2 - z1
    horizontal_distance = sqrt(dx**2 + dy**2)
    slope_distance = sqrt(dx**2 + dy**2 + dz**2)
    return round(horizontal_distance, 3), round(slope_distance, 3)

def bearing_grid(x1, y1, x2, y2):
    dx = x2 - x1
    dy = y2 - y1
    if dx == 0 and dy == 0:
        return 0.0
    bearing_rad = atan2(dx, dy)
    bearing_deg = degrees(bearing_rad)
    bearing_deg = (bearing_deg + 360) % 360
    return round(bearing_deg, 2)

def show_kalianpur_accuracy(zone):
    accuracy = kalianpur_transformer(zone).accuracy
    if accuracy >= 0:
        st.caption(
            f"Datum transformation expected accuracy: {accuracy:g} m (PROJ). "
            "Displayed decimal places do not imply survey precision."
        )
    else:
        st.caption("Datum transformation accuracy is not specified by PROJ.")

DSM_SYSTEM = "DSM (WGS84 LCC)"
DSM_AUTO = "Auto (nominal zone)"
DSM_NOTE = (
    "Uses the 18-zone parameter table you supplied and WGS84/LCC. "
    "All 24 original zone entries are retained in the catalog. "
    "Confirm the zone printed on your map sheet. Heights are unchanged."
)


def show_zone_definition_status(system, zone):
    issue = zone_definition_issue(system, zone)
    if issue:
        st.info(issue)


def show_zone_catalog(system):
    st.caption("Every original identifier is retained. The conversion definition column identifies what the calculator actually uses.")
    catalog = pd.DataFrame(zone_reference_rows(system))
    st.dataframe(catalog, hide_index=True)
    st.download_button("Download complete original zone catalog",
                       json.dumps(ORIGINAL_ZONE_CATALOG, indent=2),
                       "original_zone_catalog.json", "application/json", key="original_catalog_download")


def dsm_target_selector(key, label="Target DSM zone"):
    value = st.selectbox(label, [DSM_AUTO, *DSM_ZONE_CATALOG], key=key)
    st.caption("Auto uses nominal 8° × 6° bands with supplied parameters. On a shared boundary, select the map sheet zone.")
    if value != DSM_AUTO:
        show_zone_definition_status("DSM", value)
    return None if value == DSM_AUTO else value


def show_dsm_result(zone, easting, northing):
    st.markdown(f"""
    <div class="result-box">
        <h4>DSM Grid Result ({zone})</h4>
        <p><b>Reference:</b> WGS84 / LCC, supplied DSM zone {zone}</p>
        <p><b>Easting:</b> {easting:,.3f} m</p>
        <p><b>Northing:</b> {northing:,.3f} m</p>
    </div>
    """, unsafe_allow_html=True)
    st.code(f"{zone}: E {easting:.3f} m, N {northing:.3f} m", language="text")


def show_dsm_reference():
    show_zone_catalog("DSM")
    st.caption(DSM_NOTE)
    st.caption(f"Datum reference: [Survey of India]({DSM_TABLE['datum_source']}). Conversions use custom LCC definitions; original identifiers are preserved in the catalog above.")
    st.caption("Central scale factors are implied by the two standard parallels and are not multiplied again.")
    rows = []
    for p in DSM_ZONES.values():
        rows.append({
            "Zone": p["zone"], "Longitude of origin (D M S, E)": p["longitude_of_origin_dms"],
            "Latitude of origin (D M S, N)": p["latitude_of_origin_dms"],
            "Parallel 1 (D M S, N)": p["standard_parallel_1_dms"],
            "Parallel 2 (D M S, N)": p["standard_parallel_2_dms"],
            "False easting (m)": p["false_easting_m"], "False northing (m)": p["false_northing_m"],
            "Central scale (reference)": f"{p['central_scale_factor_reference']:.7f}",
        })
    table = pd.DataFrame(rows)
    st.dataframe(table, hide_index=True)
    st.download_button("Download DSM parameter reference", table.to_csv(index=False),
                       "dsm_parameter_reference.csv", "text/csv", key="dsm_reference_download")
    st.caption("At each listed origin, E = 500,000 m and N = 500,000 m. These are mathematical reference points, not independently surveyed controls.")


# ==========================================
# 3. UI LAYOUT & TABS
# ==========================================

# Header area
col1, col2 = st.columns([1, 4])
with col1:
    # Use absolute path to ensure logo loads
    if os.path.exists(logo_path):
        st.image(logo_path, width=120)
    else:
        # Fallback text if image still fails
        st.write("FSS Logo")
with col2:
    st.title("Advanced Surveying Calculator")
    st.caption("Professional Geodetic Calculations & Advanced Coordinate Transformations")

# Tabs
tabs = st.tabs([
    "Lat/Lon Calc", "Grid Calc", "DD to DMS", "DMS to DD", 
    "Lat/Lon to Grid", "Grid to Lat/Lon", "ESM to DSM",
    "DSM to Lat/Lon", "DSM to ESM", "Traverse", "Batch Process", "Own Position", "Zone List", "About"
])

# --- TAB 1: LAT/LON CALCULATION ---
with tabs[0]:
    st.markdown('<div class="header-style">📍 Calculate Distance & Bearing (Lat/Lon)</div>', unsafe_allow_html=True)
    st.info("Input: Decimal degrees (e.g., 30.3165, 78.0322)")
    
    col_a, col_b = st.columns(2)
    with col_a:
        st.subheader("Point A")
        lat1 = st.text_input("Lat A", "30.3165")
        lon1 = st.text_input("Lon A", "78.0322")
    with col_b:
        st.subheader("Point B")
        lat2 = st.text_input("Lat B", "30.5000")
        lon2 = st.text_input("Lon B", "78.5000")
        
    col_btn1, col_btn2 = st.columns([2, 1])
    calc_pressed = col_btn1.button("Calculate Distance & Bearing")
    detect_pressed = col_btn2.button("Auto Detect Zones")
    
    if calc_pressed:
        try:
            l1, ln1 = validate_input(lat1), validate_input(lon1)
            l2, ln2 = validate_input(lat2), validate_input(lon2)
            
            validation_error = validate_lat_lon(l1, ln1) or validate_lat_lon(l2, ln2)
            if validation_error:
                st.error(validation_error)
            else:
                dist_km = haversine(l1, ln1, l2, ln2)
                bearing = bearing_latlon(l1, ln1, l2, ln2)
                
                # Zone detection
                k1, e1, _ = detect_kalianpur_zone(l1, ln1)
                k2, e2, _ = detect_kalianpur_zone(l2, ln2)
                
                st.markdown(f"""
                <div class="result-box">
                    <h4>✅ Results</h4>
                    <p><b>Distance:</b> {dist_km} km ({dist_km * 1000:.2f} m)</p>
                    <p><b>Bearing:</b> {bearing}° ({format_bearing(bearing)})</p>
                    <hr>
                    <p><b>Zones:</b> A: {k1 or 'Outside'} (EPSG:{e1 or 'N/A'}) | B: {k2 or 'Outside'} (EPSG:{e2 or 'N/A'})</p>
                </div>
                """, unsafe_allow_html=True)

                # SHOW RESULT IMAGE HERE
                if os.path.exists(result_img_path):
                    st.image(result_img_path, caption="Reference Map", use_container_width=True)

        except Exception as e:
            st.error(f"Error: {e}")

    if detect_pressed:
        l1, ln1 = validate_input(lat1), validate_input(lon1)
        validation_error = validate_lat_lon(l1, ln1)
        if validation_error:
            st.error(validation_error)
        else:
            k_zone, k_epsg, desc = detect_kalianpur_zone(l1, ln1)
            dsm_candidates = dsm_zone_candidates(l1, ln1)
            dsm_reference = ", ".join(dsm_candidates) if dsm_candidates else "No supplied zone has a nominal match"
            w_zone, w_epsg = detect_wgs84_zone(l1, ln1)
            k_reference = f"{k_zone} (EPSG:{k_epsg}) - {desc}" if k_zone else "Outside supported coverage"
            w_reference = f"{w_zone} (EPSG:{w_epsg})" if w_zone else "No regional projection found"
            
            st.markdown(f"""
            <div class="result-box">
                <h4>🔍 Zone Detection (Point A)</h4>
                <ul>
                    <li><b>Kalianpur:</b> {k_reference}</li>
                    <li><b>DSM Zone:</b> {dsm_reference} (WGS84/LCC; confirm map sheet zone)</li>
                    <li><b>WGS84 Regional Projection:</b> {w_reference}</li>
                </ul>
            </div>
            """, unsafe_allow_html=True)
            
            # Show map in detection as well if useful
            if os.path.exists(result_img_path):
                st.image(result_img_path, caption="Reference Map", use_container_width=True)

# --- TAB 2: GRID CALCULATION ---
with tabs[1]:
    st.markdown('<div class="header-style">📐 Calculate 3D Distance (Grid)</div>', unsafe_allow_html=True)
    st.info("Input: Meters (Indian Grid System)")
    
    c1, c2, c3 = st.columns(3)
    with c1: e1 = st.text_input("Easting A", "3877983.50")
    with c2: n1 = st.text_input("Northing A", "756073.40")
    with c3: h1 = st.text_input("Height A", "600.0")
    
    c4, c5, c6 = st.columns(3)
    with c4: e2 = st.text_input("Easting B", "3878500.20")
    with c5: n2 = st.text_input("Northing B", "756500.10")
    with c6: h2 = st.text_input("Height B", "650.0")
    
    if st.button("Calculate 3D Distance"):
        try:
            ve1, vn1, vh1 = validate_input(e1), validate_input(n1), validate_input(h1)
            ve2, vn2, vh2 = validate_input(e2), validate_input(n2), validate_input(h2)
            
            if None in [ve1, vn1, vh1, ve2, vn2, vh2]:
                st.error("Invalid Grid Coordinates")
            else:
                h_dist, s_dist = distance_3d(ve1, vn1, vh1, ve2, vn2, vh2)
                b_grid = bearing_grid(ve1, vn1, ve2, vn2)
                dh = vh2 - vh1
                
                st.markdown(f"""
                <div class="result-box">
                    <h4>✅ 3D Calculation Results</h4>
                    <p><b>Horizontal Dist:</b> {h_dist} m | <b>Slope Dist:</b> {s_dist} m</p>
                    <p><b>Bearing:</b> {b_grid}° ({format_bearing(b_grid)})</p>
                    <p><b>Height Diff:</b> {dh:.3f} m</p>
                </div>
                """, unsafe_allow_html=True)
        except Exception as e:
            st.error(f"Error: {e}")

# --- TAB 3: DD TO DMS ---
with tabs[2]:
    st.markdown('<div class="header-style">🔄 Decimal Degrees to DMS</div>', unsafe_allow_html=True)
    dd_lat = st.text_input("Latitude (DD)", "30.3165")
    dd_lon = st.text_input("Longitude (DD)", "78.0322")
    
    if st.button("Convert to DMS"):
        try:
            vlat, vlon = validate_input(dd_lat), validate_input(dd_lon)
            validation_error = validate_lat_lon(vlat, vlon)
            if not validation_error:
                dms_lat = decimal_to_dms(vlat, 'lat')
                dms_lon = decimal_to_dms(vlon, 'lon')
                st.success(f"Latitude: {dms_lat}")
                st.success(f"Longitude: {dms_lon}")
            else:
                st.error(validation_error)
        except Exception as e:
            st.error(e)

# --- TAB 4: DMS TO DD ---
with tabs[3]:
    st.markdown('<div class="header-style">↩️ DMS to Decimal Degrees</div>', unsafe_allow_html=True)
    st.info("Format: D°M'S\"H (e.g., 30°18'59.4\"N)")
    dms_in_lat = st.text_input("Latitude (DMS)", "30°18'59.4\"N")
    dms_in_lon = st.text_input("Longitude (DMS)", "78°1'55.92\"E")
    
    if st.button("Convert to Decimal"):
        try:
            res_lat = dms_to_decimal(dms_in_lat, "lat")
            res_lon = dms_to_decimal(dms_in_lon, "lon")
            st.success(f"Latitude: {res_lat:.6f}°")
            st.success(f"Longitude: {res_lon:.6f}°")
            
            # Auto zone detect
            kz, ke, _ = detect_kalianpur_zone(res_lat, res_lon)
            if kz:
                st.info(f"Suggested Zone: {kz} (EPSG:{ke}); confirm the map datum and zone.")
            else:
                st.warning("Outside supported Kalianpur 1975 coverage.")
        except ValueError as ve:
            st.error(f"Format Error: {ve}")

# --- TAB 5: LAT/LON TO GRID ---
with tabs[4]:
    st.markdown('<div class="header-style">🔄 WGS84 Lat/Lon to Indian Grid</div>', unsafe_allow_html=True)
    forward_system = st.selectbox("Target grid system", ["Kalianpur 1975", DSM_SYSTEM], key="forward_grid_system")
    if forward_system == DSM_SYSTEM:
        forward_dsm_zone = dsm_target_selector("forward_dsm_zone")
        st.caption(DSM_NOTE)
    else:
        st.caption("EPSG:4326 → supported Kalianpur 1975 zone. Detection uses EPSG area bounds; confirm the map datum and zone.")
    
    c_l1, c_l2, c_l3 = st.columns(3)
    with c_l1: l_lat = st.text_input("Lat (Deg)", "30.3165")
    with c_l2: l_lon = st.text_input("Lon (Deg)", "78.0322")
    with c_l3: l_h = st.text_input("Alt (m)", "0")
    
    if st.button("Convert to Grid"):
        try:
            v_lat, v_lon = validate_input(l_lat), validate_input(l_lon)
            v_h = validate_input(l_h)
            validation_error = validate_lat_lon(v_lat, v_lon)
            if validation_error:
                raise ValueError(validation_error)
            if v_h is None:
                v_h = 0.0
            
            if forward_system == DSM_SYSTEM:
                zone, easting, northing = wgs84_to_dsm(v_lat, v_lon, forward_dsm_zone)
                show_dsm_result(zone, easting, northing)
                st.write(f"Height (unchanged): {v_h} m")
            else:
                kz, ke, easting, northing = wgs84_to_kalianpur(v_lat, v_lon)
                show_kalianpur_accuracy(kz)
            
                st.markdown(f"""
                <div class="result-box">
                    <h4>🎯 Indian Grid Result ({kz})</h4>
                    <p><b>Easting:</b> {easting:,.3f} m</p>
                    <p><b>Northing:</b> {northing:,.3f} m</p>
                    <p><b>Height (unchanged):</b> {v_h} m</p>
                </div>
                """, unsafe_allow_html=True)
        except Exception as e:
            st.error(f"Conversion Error: {e}")

# --- TAB 6: GRID TO LAT/LON ---
with tabs[5]:
    st.markdown('<div class="header-style">↩️ Indian Grid to WGS84 Lat/Lon</div>', unsafe_allow_html=True)
    
    grid_zone = st.selectbox(
        "Source Kalianpur Zone",
        list(KALIANPUR_ZONE_CATALOG),
        key="grid_to_latlon_zone",
    )
    show_zone_definition_status("Kalianpur 1975", grid_zone)
    cg1, cg2, cg3 = st.columns(3)
    with cg1: g_e = st.text_input("Easting (m)", "3877983.50")
    with cg2: g_n = st.text_input("Northing (m)", "756073.40")
    with cg3: g_h = st.text_input("Height (m)", "0")
    
    if st.button("Convert to Lat/Lon"):
        try:
            ve, vn = validate_input(g_e), validate_input(g_n)
            vh = validate_input(g_h)
            if ve is None or vn is None:
                raise ValueError("Easting and northing must be valid finite numbers.")
            if vh is None:
                vh = 0.0

            wgs_lon, wgs_lat = kalianpur_to_wgs84(ve, vn, grid_zone)
            source_epsg = ENHANCED_KALIANPUR_ZONES[grid_zone]["epsg"]
            show_kalianpur_accuracy(grid_zone)
            
            st.markdown(f"""
            <div class="result-box">
                <h4>📍 WGS84 Result ({grid_zone}, EPSG:{source_epsg})</h4>
                <p><b>Latitude:</b> {wgs_lat:.6f}° ({decimal_to_dms(wgs_lat, 'lat')})</p>
                <p><b>Longitude:</b> {wgs_lon:.6f}° ({decimal_to_dms(wgs_lon, 'lon')})</p>
            </div>
            """, unsafe_allow_html=True)
        except Exception as e:
            st.error(f"Error: {e}")

# --- DSM CONVERSIONS: SUPPLIED LCC PARAMETERS ON WGS84 ---
with tabs[6]:
    st.markdown('<div class="header-style">🔄 ESM Grid to DSM Grid</div>', unsafe_allow_html=True)
    st.caption(DSM_NOTE)
    esm_source_zone = st.selectbox("Source ESM zone", list(KALIANPUR_ZONE_CATALOG), key="esm_dsm_source")
    show_zone_definition_status("Kalianpur 1975", esm_source_zone)
    esm_target_zone = dsm_target_selector("esm_dsm_target")
    esm_e = st.text_input("ESM Easting (m)", "3877983.50", key="esm_dsm_e")
    esm_n = st.text_input("ESM Northing (m)", "756073.40", key="esm_dsm_n")
    if st.button("Convert ESM -> DSM"):
        try:
            zone, e, n = kalianpur_to_dsm(esm_e, esm_n, esm_source_zone, esm_target_zone)
            show_dsm_result(zone, e, n)
            show_kalianpur_accuracy(esm_source_zone)
        except Exception as exc:
            st.error(f"Conversion Error: {exc}")

with tabs[7]:
    st.markdown('<div class="header-style">↩️ DSM Grid to WGS84 Lat/Lon</div>', unsafe_allow_html=True)
    st.caption(DSM_NOTE)
    st.caption("Enter full metre coordinates. Shortened grid references also require their grid-square identification.")
    dsm_source_zone = st.selectbox("Source DSM zone", list(DSM_ZONE_CATALOG), index=7, key="dsm_latlon_source")
    show_zone_definition_status("DSM", dsm_source_zone)
    dsm_e = st.text_input("DSM Easting (m)", "500000", key="dsm_latlon_e")
    dsm_n = st.text_input("DSM Northing (m)", "500000", key="dsm_latlon_n")
    if st.button("Convert DSM -> Lat/Lon"):
        try:
            lon, lat = dsm_to_wgs84(dsm_e, dsm_n, dsm_source_zone)
            st.success(f"DSM {dsm_source_zone} → WGS84 (EPSG:4326): {lat:.8f}°, {lon:.8f}°")
            st.code(f"{decimal_to_dms(lat, 'lat')}, {decimal_to_dms(lon, 'lon')}", language="text")
        except Exception as exc:
            st.error(f"Conversion Error: {exc}")

with tabs[8]:
    st.markdown('<div class="header-style">↩️ DSM Grid to ESM Grid</div>', unsafe_allow_html=True)
    st.caption(DSM_NOTE)
    dsm_esm_zone = st.selectbox("Source DSM zone", list(DSM_ZONE_CATALOG), index=7, key="dsm_esm_source")
    show_zone_definition_status("DSM", dsm_esm_zone)
    dsm_esm_e = st.text_input("DSM Easting (m)", "500000", key="dsm_esm_e")
    dsm_esm_n = st.text_input("DSM Northing (m)", "500000", key="dsm_esm_n")
    if st.button("Convert DSM -> ESM"):
        try:
            zone, epsg, e, n = dsm_to_kalianpur(dsm_esm_e, dsm_esm_n, dsm_esm_zone)
            st.success(f"ESM Grid Result ({zone}, EPSG:{epsg}): E {e:.3f} m, N {n:.3f} m")
            show_kalianpur_accuracy(zone)
        except Exception as exc:
            st.error(f"Conversion Error: {exc}")

# --- TAB 10: TRAVERSE ---
with tabs[9]:
    st.markdown('<div class="header-style">📐 Traverse (Deg & Dist to Coordinate)</div>', unsafe_allow_html=True)
    st.info("Calculate Target Coordinate using Start Point, Bearing & Distance")
    
    # Input Layout
    col_t1, col_t2 = st.columns(2)
    with col_t1:
        st.subheader("Start Location")
        start_e = st.text_input("Start Easting (m)", "3877983.50")
        start_n = st.text_input("Start Northing (m)", "756073.40")
    with col_t2:
        st.subheader("Vector")
        bearing_in = st.text_input("Bearing (Degrees)", "45.0")
        dist_in = st.text_input("Distance (Meters)", "100.0")
        
    if st.button("Calculate Target Coordinate"):
        try:
            # Validation
            ve, vn = validate_input(start_e), validate_input(start_n)
            vb, vd = validate_input(bearing_in), validate_input(dist_in)
            
            if None in [ve, vn, vb, vd]:
                st.error("Please enter valid numeric values for all fields.")
            else:
                # Calculation (Plane Geometry)
                rad = radians(vb)
                delta_e = vd * sin(rad)
                delta_n = vd * cos(rad)
                final_e = ve + delta_e
                final_n = vn + delta_n
                
                st.markdown(f"""
                <div class="result-box">
                    <h4>📍 Target Location Results</h4>
                    <p><b>Target Easting:</b> {final_e:,.3f} m</p>
                    <p><b>Target Northing:</b> {final_n:,.3f} m</p>
                    <hr>
                    <p><b>Shift Details:</b></p>
                    <ul>
                        <li>Delta Easting: {delta_e:+.3f} m</li>
                        <li>Delta Northing: {delta_n:+.3f} m</li>
                    </ul>
                </div>
                """, unsafe_allow_html=True)
                
        except Exception as e:
            st.error(f"Calculation Error: {e}")

# --- TAB 11: BATCH PROCESSING ---
with tabs[10]:
    st.markdown('<div class="header-style">📊 Batch Processing (CSV)</div>', unsafe_allow_html=True)
    batch_operation = st.selectbox("Batch conversion", [
        "Kalianpur grid -> WGS84", "DSM grid -> WGS84", "WGS84 -> DSM grid",
        "Kalianpur grid -> DSM grid", "DSM grid -> Kalianpur grid",
    ], key="batch_operation")
    batch_from_dsm = batch_operation.startswith("DSM grid")
    batch_from_wgs = batch_operation.startswith("WGS84")
    batch_to_dsm = batch_operation.endswith("-> DSM grid")
    if batch_from_dsm:
        batch_dsm_source = st.selectbox("Source DSM zone", list(DSM_ZONE_CATALOG), index=7, key="batch_dsm_source")
        show_zone_definition_status("DSM", batch_dsm_source)
        st.caption("All uploaded rows must use this source DSM zone and full metre coordinates.")
    elif not batch_from_wgs:
        batch_zone = st.selectbox("Source Kalianpur Zone", list(KALIANPUR_ZONE_CATALOG), key="batch_source_zone")
        show_zone_definition_status("Kalianpur 1975", batch_zone)
    if batch_to_dsm:
        batch_dsm_target = dsm_target_selector("batch_dsm_target")
    if "DSM" in batch_operation:
        st.caption(DSM_NOTE)

    if batch_from_wgs:
        required_columns = {"lat", "lon"}
        template_data = "lat,lon,height,point_id\n30.3165,78.0322,600.0,P1\n27.006955555556,80,0,P2"
    else:
        required_columns = {"easting", "northing"}
        if batch_from_dsm:
            template_data = "easting,northing,height,point_id\n500000,500000,0,P1\n501000,501000,0,P2"
        else:
            template_data = "easting,northing,height,point_id\n3877983.50,756073.40,600.0,P1\n3878500.20,756500.10,650.0,P2"
    st.info("Required columns: " + ", ".join(sorted(required_columns)) + ". Optional: height, point_id. Heights are unchanged.")
    st.download_button("📥 Download CSV Template", template_data, "template.csv", "text/csv")
    uploaded_file = st.file_uploader("Upload CSV", type=['csv'])

    if uploaded_file:
        try:
            df = pd.read_csv(uploaded_file)
        except Exception as exc:
            st.error(f"CSV Error: {exc}")
            df = None
        if df is not None:
            st.dataframe(df.head())
            batch_button = "Start Batch Processing (Grid -> Lat/Lon)" if batch_operation.endswith("WGS84") else "Start Batch Processing"
            if st.button(batch_button):
                results = []
                progress_bar = st.progress(0)
                try:
                    missing = required_columns.difference(df.columns)
                    if missing:
                        raise ValueError("Missing required column(s): " + ", ".join(sorted(missing)))
                    if df.empty:
                        raise ValueError("The uploaded CSV contains no data rows.")
                    if not batch_from_dsm and not batch_from_wgs and batch_zone in ENHANCED_KALIANPUR_ZONES:
                        show_kalianpur_accuracy(batch_zone)
                    for i, row in df.iterrows():
                        result = {"point_id": row.get("point_id", f"P{i}"), "height": row.get("height", 0)}
                        if not batch_from_wgs:
                            result["source_zone"] = batch_dsm_source if batch_from_dsm else batch_zone
                        try:
                            if batch_operation == "Kalianpur grid -> WGS84":
                                lon, lat = kalianpur_to_wgs84(row["easting"], row["northing"], batch_zone)
                                result.update(lat=lat, lon=lon, source_zone=batch_zone, target_crs="EPSG:4326")
                            elif batch_operation == "DSM grid -> WGS84":
                                lon, lat = dsm_to_wgs84(row["easting"], row["northing"], batch_dsm_source)
                                result.update(lat=lat, lon=lon, source_zone=batch_dsm_source, target_crs="EPSG:4326")
                            elif batch_operation == "WGS84 -> DSM grid":
                                zone, e, n = wgs84_to_dsm(row["lat"], row["lon"], batch_dsm_target)
                                result.update(easting=e, northing=n, target_zone=zone, target_crs="DSM / WGS84 LCC (supplied parameters)")
                            elif batch_operation == "Kalianpur grid -> DSM grid":
                                zone, e, n = kalianpur_to_dsm(row["easting"], row["northing"], batch_zone, batch_dsm_target)
                                result.update(easting=e, northing=n, source_zone=batch_zone, target_zone=zone,
                                              target_crs="DSM / WGS84 LCC (supplied parameters)",
                                              datum_accuracy_m=kalianpur_transformer(batch_zone).accuracy)
                            else:
                                zone, epsg, e, n = dsm_to_kalianpur(row["easting"], row["northing"], batch_dsm_source)
                                result.update(easting=e, northing=n, source_zone=batch_dsm_source, target_zone=zone,
                                              target_crs=f"EPSG:{epsg}", datum_accuracy_m=kalianpur_transformer(zone).accuracy)
                            result["status"] = "Success"
                        except Exception as exc:
                            result["status"] = f"Error: {exc}"
                        results.append(result)
                        progress_bar.progress((i + 1) / len(df))
                    res_df = pd.DataFrame(results)
                    success_count = sum(result["status"] == "Success" for result in results)
                    st.success(f"Processing complete: {success_count} succeeded, {len(results) - success_count} failed.")
                    st.dataframe(res_df)
                    st.download_button("💾 Export Results", res_df.to_csv(index=False), "results.csv", "text/csv")
                except Exception as exc:
                    st.error(f"Batch Error: {exc}")

# --- TAB 11: OWN POSITION FINDER ---
with tabs[11]:
    st.markdown('<div class="header-style">📍 Own Position Finder</div>', unsafe_allow_html=True)
    st.write("Enable the checkbox below to retrieve your current coordinates.")
    position_dsm_zone = dsm_target_selector("position_dsm_zone", "DSM zone for own position")
    st.caption("Note: Please allow location access. The system will scan for up to 15 seconds to achieve <1m accuracy.")

    if st.checkbox("Get Own Position", key="get_pos_checkbox"):
        # We replace the standard geolocation call with a direct call to streamlit_js_eval
        # to pass the enableHighAccuracy option to the browser's Geolocation API for better accuracy.
        js_code = """
            new Promise((resolve, reject) => {
                const targetAcc = 1.0; // Target accuracy in meters
                const maxWait = 15000; // Max wait time in ms (15s)
                let bestPos = null;
                let watchId = null;
                
                const finish = (pos) => {
                    if (watchId) navigator.geolocation.clearWatch(watchId);
                    if (pos) {
                        resolve({
                            coords: {
                                latitude: pos.coords.latitude,
                                longitude: pos.coords.longitude,
                                altitude: pos.coords.altitude,
                                accuracy: pos.coords.accuracy,
                                altitudeAccuracy: pos.coords.altitudeAccuracy,
                                heading: pos.coords.heading,
                                speed: pos.coords.speed
                            },
                            timestamp: pos.timestamp
                        });
                    } else {
                        resolve({error: {code: 3, message: "Timeout: No position acquired"}});
                    }
                };

                const timer = setTimeout(() => finish(bestPos), maxWait);

                watchId = navigator.geolocation.watchPosition(
                    (pos) => {
                        if (!bestPos || pos.coords.accuracy < bestPos.coords.accuracy) {
                            bestPos = pos;
                        }
                        if (pos.coords.accuracy <= targetAcc) {
                            clearTimeout(timer);
                            finish(pos);
                        }
                    },
                    (err) => {
                        if (err.code === 1) { // Permission denied
                            clearTimeout(timer);
                            if (watchId) navigator.geolocation.clearWatch(watchId);
                            resolve({error: {code: err.code, message: err.message}});
                        }
                    },
                    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
                );
            })
        """
        loc = streamlit_js_eval(
            js_expressions=js_code,
            key="get_loc_accurate", # Using a unique key
            want_output=True,
            button_text="Get Precise Location (Scanning...)"
        )
    else:
        loc = None

    if loc:
        if 'coords' in loc:
            lat = loc['coords']['latitude']
            lon = loc['coords']['longitude']
            acc = loc['coords']['accuracy']
        elif 'error' in loc and loc.get('error'):
            st.warning(f"Could not retrieve location. Error: {loc['error']['message']} (Code: {loc['error']['code']})")
            # Stop further execution in this block if location failed
            st.stop()
        else:
            # Handle cases where loc is not None but doesn't have the expected structure
            st.warning("Received an unexpected location format.")
            st.stop()

        # Accuracy feedback
        if acc <= 2:
            acc_status = "Excellent (High Accuracy)"
        elif acc <= 10:
            acc_status = "Good (GPS)"
        else:
            acc_status = "Low (Approximate)"
        
        st.success(f"Location Acquired. Accuracy: ±{acc:.1f}m ({acc_status})")
        st.caption("Browser/device location is not a substitute for a calibrated survey-grade GNSS receiver.")

        # 1. Geographic Coordinates
        st.subheader("1. Geographic Coordinates (WGS84)")
        
        w_zone, w_epsg = detect_wgs84_zone(lat, lon)
        if w_zone:
            st.write(f"**Suggested regional projection:** {w_zone} (EPSG:{w_epsg})")
        st.caption("Latitude and longitude below use WGS84 (EPSG:4326).")
            
        c1, c2 = st.columns(2)
        c1.metric("Latitude (DD)", f"{lat:.7f}")
        c2.metric("Longitude (DD)", f"{lon:.7f}")
        st.caption("Copy Coordinates (DD & DMS):")
        st.code(f"{lat:.7f}, {lon:.7f}", language="text")
        st.code(f"{decimal_to_dms(lat, 'lat')}, {decimal_to_dms(lon, 'lon')}", language="text")

        # 2. ESM (Kalianpur / Indian Grid)
        st.subheader("2. ESM (Indian Grid)")
        try:
            kz, ke, e, n = wgs84_to_kalianpur(lat, lon)
            st.write(f"**Zone:** {kz} (EPSG:{ke})")
            show_kalianpur_accuracy(kz)
            c3, c4 = st.columns(2)
            c3.metric("Easting", f"{e:.3f}")
            c4.metric("Northing", f"{n:.3f}")
            st.code(f"{e:.3f}, {n:.3f}", language="text")
        except Exception as exc:
            st.warning(f"Kalianpur conversion unavailable: {exc}")

        # 3. DSM WGS84/LCC grid, using the supplied parameter table.
        st.subheader("3. DSM Grid (WGS84/LCC)")
        try:
            zone, e, n = wgs84_to_dsm(lat, lon, position_dsm_zone)
            st.write(f"**DSM zone:** {zone}")
            st.caption(DSM_NOTE)
            c5, c6 = st.columns(2)
            c5.metric("DSM Easting", f"{e:.3f}")
            c6.metric("DSM Northing", f"{n:.3f}")
            st.code(f"{zone}: E {e:.3f} m, N {n:.3f} m", language="text")
        except Exception as exc:
            st.warning(f"DSM conversion unavailable: {exc}")

        # 4. Google Maps Link
        st.markdown(f"""<a href="https://www.google.com/maps/search/?api=1&query={lat},{lon}" target="_blank"><button style="background-color:#4CAF50; color:white; padding:10px 20px; border:none; border-radius:5px; cursor:pointer;">Open in Google Maps 🗺️</button></a>""", unsafe_allow_html=True)

# --- TAB 12: ZONE LIST ---
with tabs[12]:
    st.markdown('<div class="header-style">🗺️ Zone Reference</div>', unsafe_allow_html=True)
    
    z_type = st.radio("Select System", ["Kalianpur 1975", DSM_SYSTEM, "WGS84"])
    
    if z_type == "Kalianpur 1975":
        show_zone_catalog("Kalianpur 1975")
        st.caption("Verified areas are EPSG bounding boxes, not exact coverage polygons. Original metadata is retained separately for reference.")
        for zone, original in KALIANPUR_ZONE_CATALOG.items():
            with st.expander(f"{zone} (original identifier EPSG:{original['epsg']})"):
                verified = ENHANCED_KALIANPUR_ZONES.get(zone)
                if verified:
                    st.write(f"Verified bounds: {verified['bounds']}\n\nDescription: {verified['description']}")
                else:
                    show_zone_definition_status("Kalianpur 1975", zone)
                st.write({"Original metadata (reference only)": original})
    elif z_type == DSM_SYSTEM:
        show_dsm_reference()
    else:
        for k, v in WGS84_ZONES.items():
            st.write(f"**{k}**: EPSG {v['epsg']}")

# --- TAB 13: ABOUT ---
with tabs[13]:
    st.markdown('<div class="header-style">About</div>', unsafe_allow_html=True)
    
    # Use logo_path logic here as well
    if os.path.exists(logo_path):
        st.image(logo_path, width=150)
    
    st.write("### Advanced Surveying Calculator")
    st.write("Version 5.0 Enhanced Web Edition")
    st.write("© 2025 ByteFixx Solution")
    st.write("Developer: Moorthi M")
    st.write("Contact: bytefixx33@gmail.com")
    st.write("Built with ❤️ for surveyors and geodetic professionals.")
