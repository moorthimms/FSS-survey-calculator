import streamlit as st
import pandas as pd
import math
from math import radians, sin, cos, sqrt, atan2, degrees
from pyproj import Transformer, CRS
import re
import io
import os

# ==========================================
# 0. PATH SETUP (Fix for missing images)
# ==========================================
# This ensures images are found regardless of how the app is run
current_dir = os.path.dirname(os.path.abspath(__file__))
logo_path = os.path.join(current_dir, "FSS Logo.png")
icon_path = os.path.join(current_dir, "icon.ico")
result_img_path = os.path.join(current_dir, "result.jpg")

# ==========================================
# 1. CONFIGURATION & CONSTANTS
# ==========================================

st.set_page_config(
    page_title="FSS Survey Calculator",
    page_icon=icon_path if os.path.exists(icon_path) else None, # Uses the .ico file
    layout="wide",
    initial_sidebar_state="expanded"
)

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

# --- ZONE DEFINITIONS (Ported exactly from Kivy App) ---

ENHANCED_KALIANPUR_ZONES = {
    'Zone I': {'epsg': 24378, 'bounds': {'lat_min': 28.0, 'lat_max': 35.51, 'lon_min': 70.35, 'lon_max': 81.64}, 'description': 'Northern India (J&K, HP, Punjab, Haryana, Uttarakhand, North UP)', 'central_meridian': 78.0},
    'Zone IIa': {'epsg': 24379, 'bounds': {'lat_min': 21.0, 'lat_max': 28.01, 'lon_min': 68.13, 'lon_max': 82.01}, 'description': 'Northwest India (Rajasthan, Gujarat, West MP, South UP)', 'central_meridian': 75.0},
    'Zone IIb': {'epsg': 24380, 'bounds': {'lat_min': 21.0, 'lat_max': 29.47, 'lon_min': 82.0, 'lon_max': 97.42}, 'description': 'Northeast India (Assam, Meghalaya, Manipur, Mizoram)', 'central_meridian': 90.0},
    'Zone IIIa': {'epsg': 24381, 'bounds': {'lat_min': 15.0, 'lat_max': 21.01, 'lon_min': 70.14, 'lon_max': 87.15}, 'description': 'Central India (Maharashtra, East MP, Chhattisgarh)', 'central_meridian': 78.0},
    'Zone IIIb': {'epsg': 24382, 'bounds': {'lat_min': 15.0, 'lat_max': 21.01, 'lon_min': 87.15, 'lon_max': 97.42}, 'description': 'East Central India (Jharkhand, Odisha, East Bengal)', 'central_meridian': 92.0},
    'Zone IVa': {'epsg': 24383, 'bounds': {'lat_min': 8.02, 'lat_max': 15.01, 'lon_min': 73.94, 'lon_max': 80.4}, 'description': 'Southwest India (Karnataka, Kerala, Tamil Nadu West)', 'central_meridian': 77.0},
    'Zone IVb': {'epsg': 24384, 'bounds': {'lat_min': 8.02, 'lat_max': 15.01, 'lon_min': 80.4, 'lon_max': 87.18}, 'description': 'Southeast India (Andhra Pradesh, Tamil Nadu East)', 'central_meridian': 84.0},
    'Zone Va': {'epsg': 24385, 'bounds': {'lat_min': 5.0, 'lat_max': 8.02, 'lon_min': 73.94, 'lon_max': 80.4}, 'description': 'Far South India (South Kerala, South Tamil Nadu)', 'central_meridian': 77.0},
    'Zone Vb': {'epsg': 24386, 'bounds': {'lat_min': 5.0, 'lat_max': 8.02, 'lon_min': 80.4, 'lon_max': 87.18}, 'description': 'Far Southeast India (South Tamil Nadu, South Andhra)', 'central_meridian': 84.0}
}

DSM_LCC_ZONES = {
    "5C": {"epsg": 2001, "extent": (68.00, 36.00, 76.00, 42.00)}, "5D": {"epsg": 2007, "extent": (68.00, 30.00, 76.00, 36.00)},
    "5E": {"epsg": 2013, "extent": (68.00, 24.00, 76.00, 30.00)}, "5F": {"epsg": 2019, "extent": (68.00, 18.00, 76.00, 24.00)},
    "5G": {"epsg": 2025, "extent": (68.00, 12.00, 76.00, 18.00)}, "5H": {"epsg": 2031, "extent": (68.00, 6.00, 76.00, 12.00)},
    "6C": {"epsg": 2002, "extent": (76.00, 36.00, 84.00, 42.00)}, "6D": {"epsg": 2008, "extent": (76.00, 30.00, 84.00, 36.00)},
    "6E": {"epsg": 2014, "extent": (76.00, 24.00, 84.00, 30.00)}, "6F": {"epsg": 2020, "extent": (76.00, 18.00, 84.00, 24.00)},
    "6G": {"epsg": 2026, "extent": (76.00, 12.00, 84.00, 18.00)}, "6H": {"epsg": 2032, "extent": (76.00, 6.00, 84.00, 12.00)},
    "7C": {"epsg": 2003, "extent": (84.00, 36.00, 92.00, 42.00)}, "7D": {"epsg": 2009, "extent": (84.00, 30.00, 92.00, 36.00)},
    "7E": {"epsg": 2015, "extent": (84.00, 24.00, 92.00, 30.00)}, "7F": {"epsg": 2021, "extent": (84.00, 18.00, 92.00, 24.00)},
    "7G": {"epsg": 2027, "extent": (84.00, 12.00, 92.00, 18.00)}, "7H": {"epsg": 2033, "extent": (84.00, 6.00, 92.00, 12.00)},
    "8C": {"epsg": 2004, "extent": (92.00, 36.00, 100.00, 42.00)}, "8D": {"epsg": 2010, "extent": (92.00, 30.00, 100.00, 36.00)},
    "8E": {"epsg": 2016, "extent": (92.00, 24.00, 100.00, 30.00)}, "8F": {"epsg": 2022, "extent": (92.00, 18.00, 100.00, 24.00)},
    "8G": {"epsg": 2028, "extent": (92.00, 12.00, 100.00, 18.00)}, "8H": {"epsg": 2034, "extent": (92.00, 6.00, 100.00, 12.00)},
}

WGS84_ZONES = {
    'India Northeast': {'epsg': 7771, 'bounds': {'lat_min': 21.94, 'lat_max': 29.47, 'lon_min': 89.69, 'lon_max': 97.42}},
    'India NSF LCC': {'epsg': 7755, 'bounds': {'lat_min': 3.87, 'lat_max': 35.51, 'lon_min': 65.6, 'lon_max': 97.42}},
    'Uttar Pradesh': {'epsg': 7775, 'bounds': {'lat_min': 25.0, 'lat_max': 31.5, 'lon_min': 78.0, 'lon_max': 84.0}},
    'Kerala': {'epsg': 7781, 'bounds': {'lat_min': 8.0, 'lat_max': 13.0, 'lon_min': 74.0, 'lon_max': 77.0}},
    'Lakshadweep': {'epsg': 7782, 'bounds': {'lat_min': 10.0, 'lat_max': 13.0, 'lon_min': 71.0, 'lon_max': 74.0}},
    'Tamil Nadu': {'epsg': 7785, 'bounds': {'lat_min': 8.02, 'lat_max': 13.59, 'lon_min': 76.22, 'lon_max': 80.4}},
    'Jammu and Kashmir': {'epsg': 7764, 'bounds': {'lat_min': 32.0, 'lat_max': 37.0, 'lon_min': 73.0, 'lon_max': 78.0}},
    'Gujarat': {'epsg': 7761, 'bounds': {'lat_min': 20.0, 'lat_max': 24.0, 'lon_min': 68.0, 'lon_max': 74.0}},
    'Maharashtra': {'epsg': 7767, 'bounds': {'lat_min': 17.0, 'lat_max': 22.0, 'lon_min': 72.0, 'lon_max': 80.0}},
}

DSM_PARAMS = {
    "5": {"central_meridian": 72, "latitude_of_origin": 4, "false_easting": 500000, "false_northing": -2010760, "scale_factor": 0.9999, "semi_major": 6377276.345, "semi_minor": 6356075.413, "projection": "tmerc"},
    "6": {"central_meridian": 80, "latitude_of_origin": 4, "false_easting": 500010, "false_northing": -2010750, "scale_factor": 0.9999, "semi_major": 6377276.345, "semi_minor": 6356075.413, "projection": "tmerc"},
    "7": {"central_meridian": 88, "latitude_of_origin": 4, "false_easting": 500000, "false_northing": -2010760, "scale_factor": 0.9999, "semi_major": 6377276.345, "semi_minor": 6356075.413, "projection": "tmerc"},
    "8": {"central_meridian": 96, "latitude_of_origin": 4, "false_easting": 500000, "false_northing": -2010760, "scale_factor": 0.9999, "semi_major": 6377276.345, "semi_minor": 6356075.413, "projection": "tmerc"}
}

# ==========================================
# 2. HELPER FUNCTIONS
# ==========================================

def validate_input(input_str):
    if not input_str or str(input_str).strip() == "":
        return None
    try:
        return float(str(input_str).strip())
    except ValueError:
        return None

def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0
    lat1_rad, lon1_rad = radians(lat1), radians(lon1)
    lat2_rad, lon2_rad = radians(lat2), radians(lon2)
    dlat = lat2_rad - lat1_rad
    dlon = lon2_rad - lon1_rad
    a = sin(dlat / 2)**2 + cos(lat1_rad) * cos(lat2_rad) * sin(dlon / 2)**2
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
    degrees_part = int(bearing_deg)
    minutes_float = (bearing_deg - degrees_part) * 60
    minutes_part = int(minutes_float)
    seconds_part = round((minutes_float - minutes_part) * 60, 1)
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

def dms_to_decimal(dms_str):
    pattern = r"(\d+)°(\d+)'(\d+(?:\.\d+)?)\"?([NSEW])"
    match = re.match(pattern, dms_str.strip())
    if not match:
        raise ValueError(f"Invalid DMS format: {dms_str}")
    degrees, minutes, seconds, hemisphere = match.groups()
    decimal = float(degrees) + float(minutes) / 60 + float(seconds) / 3600
    if hemisphere in ['S', 'W']:
        decimal = -decimal
    return decimal

def detect_kalianpur_zone(lat, lon):
    for zone_name, zone_info in ENHANCED_KALIANPUR_ZONES.items():
        bounds = zone_info['bounds']
        if bounds['lat_min'] <= lat <= bounds['lat_max'] and bounds['lon_min'] <= lon <= bounds['lon_max']:
            return zone_name, zone_info['epsg'], zone_info['description']
    return None, None, None

def detect_dsm_zone(lat, lon):
    for zone_name, zone_info in DSM_LCC_ZONES.items():
        extent = zone_info['extent']
        if extent[1] <= lat <= extent[3] and extent[0] <= lon <= extent[2]:
            return zone_name, zone_info['epsg']
    return None, None

def detect_wgs84_zone(lat, lon):
    for zone_name, zone_info in WGS84_ZONES.items():
        bounds = zone_info['bounds']
        if bounds['lat_min'] <= lat <= bounds['lat_max'] and bounds['lon_min'] <= lon <= bounds['lon_max']:
            return zone_name, zone_info['epsg']
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
    "DSM to Lat/Lon", "DSM to ESM", "Batch Process", "Zone List", "About"
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
            
            if None in [l1, ln1, l2, ln2]:
                st.error("Please enter valid numeric coordinates.")
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
        try:
            l1, ln1 = validate_input(lat1), validate_input(lon1)
            k_zone, k_epsg, desc = detect_kalianpur_zone(l1, ln1)
            dsm_zone, dsm_epsg = detect_dsm_zone(l1, ln1)
            
            st.markdown(f"""
            <div class="result-box">
                <h4>🔍 Zone Detection (Point A)</h4>
                <ul>
                    <li><b>Kalianpur:</b> {k_zone} (EPSG:{k_epsg}) - {desc}</li>
                    <li><b>DSM Zone:</b> {dsm_zone} (EPSG:{dsm_epsg})</li>
                </ul>
            </div>
            """, unsafe_allow_html=True)
            
            # Show map in detection as well if useful
            if os.path.exists(result_img_path):
                st.image(result_img_path, caption="Reference Map", use_container_width=True)
        except:
            st.error("Invalid input for Point A")

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
            if vlat is not None and vlon is not None:
                dms_lat = decimal_to_dms(vlat, 'lat')
                dms_lon = decimal_to_dms(vlon, 'lon')
                st.success(f"Latitude: {dms_lat}")
                st.success(f"Longitude: {dms_lon}")
            else:
                st.error("Invalid Input")
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
            res_lat = dms_to_decimal(dms_in_lat)
            res_lon = dms_to_decimal(dms_in_lon)
            st.success(f"Latitude: {res_lat:.6f}°")
            st.success(f"Longitude: {res_lon:.6f}°")
            
            # Auto zone detect
            kz, ke, _ = detect_kalianpur_zone(res_lat, res_lon)
            st.info(f"Detected Zone: {kz} (EPSG:{ke})")
        except ValueError as ve:
            st.error(f"Format Error: {ve}")

# --- TAB 5: LAT/LON TO GRID ---
with tabs[4]:
    st.markdown('<div class="header-style">🔄 WGS84 Lat/Lon to Indian Grid</div>', unsafe_allow_html=True)
    st.caption("EPSG:4326 → EPSG:24378 (Kalianpur 1975)")
    
    c_l1, c_l2, c_l3 = st.columns(3)
    with c_l1: l_lat = st.text_input("Lat (Deg)", "30.3165")
    with c_l2: l_lon = st.text_input("Lon (Deg)", "78.0322")
    with c_l3: l_h = st.text_input("Alt (m)", "0")
    
    if st.button("Convert to Grid"):
        try:
            v_lat, v_lon = validate_input(l_lat), validate_input(l_lon)
            v_h = validate_input(l_h) or 0.0
            
            # Detect zone
            kz, ke, _ = detect_kalianpur_zone(v_lat, v_lon)
            if ke is None:
                ke = 24378
                kz = "Default (Zone I)"
            
            transformer = Transformer.from_crs("epsg:4326", f"epsg:{ke}", always_xy=True)
            easting, northing = transformer.transform(v_lon, v_lat)
            
            st.markdown(f"""
            <div class="result-box">
                <h4>🎯 Indian Grid Result ({kz})</h4>
                <p><b>Easting:</b> {easting:,.3f} m</p>
                <p><b>Northing:</b> {northing:,.3f} m</p>
                <p><b>Height:</b> {v_h} m</p>
            </div>
            """, unsafe_allow_html=True)
        except Exception as e:
            st.error(f"Conversion Error: {e}")

# --- TAB 6: GRID TO LAT/LON ---
with tabs[5]:
    st.markdown('<div class="header-style">↩️ Indian Grid to WGS84 Lat/Lon</div>', unsafe_allow_html=True)
    
    cg1, cg2, cg3 = st.columns(3)
    with cg1: g_e = st.text_input("Easting (m)", "3877983.50")
    with cg2: g_n = st.text_input("Northing (m)", "756073.40")
    with cg3: g_h = st.text_input("Height (m)", "0")
    
    if st.button("Convert to Lat/Lon"):
        try:
            ve, vn = validate_input(g_e), validate_input(g_n)
            vh = validate_input(g_h) or 0.0
            
            # Assumption: Input is Zone I (EPSG:24378) as per original logic if not specified
            transformer = Transformer.from_crs("epsg:24378", "epsg:4326", always_xy=True)
            wgs_lon, wgs_lat = transformer.transform(ve, vn)
            
            st.markdown(f"""
            <div class="result-box">
                <h4>📍 WGS84 Result</h4>
                <p><b>Latitude:</b> {wgs_lat:.6f}° ({decimal_to_dms(wgs_lat, 'lat')})</p>
                <p><b>Longitude:</b> {wgs_lon:.6f}° ({decimal_to_dms(wgs_lon, 'lon')})</p>
            </div>
            """, unsafe_allow_html=True)
        except Exception as e:
            st.error(f"Error: {e}")

# --- TAB 7: ESM TO DSM ---
with tabs[6]:
    st.markdown('<div class="header-style">🔄 ESM Grid to DSM Grid</div>', unsafe_allow_html=True)
    st.caption("ESM (Kalianpur) → WGS84 → DSM (LCC)")
    
    ce1, ce2 = st.columns(2)
    with ce1: 
        esm_zone = st.selectbox("Select ESM Zone", list(ENHANCED_KALIANPUR_ZONES.keys()))
    with ce2:
        esm_e = st.text_input("ESM Easting", "3856789.12")
        esm_n = st.text_input("ESM Northing", "756073.40")
        esm_h = st.text_input("Height", "600.0")
        
    if st.button("Convert ESM -> DSM"):
        try:
            ve, vn = validate_input(esm_e), validate_input(esm_n)
            vh = validate_input(esm_h) or 0.0
            
            src_epsg = ENHANCED_KALIANPUR_ZONES[esm_zone]['epsg']
            
            # 1. ESM -> WGS84
            t1 = Transformer.from_crs(f"epsg:{src_epsg}", "epsg:4326", always_xy=True)
            lon, lat = t1.transform(ve, vn)
            
            # 2. Detect DSM
            d_zone, d_epsg = detect_dsm_zone(lat, lon)
            if not d_zone:
                st.error("Coordinates outside DSM coverage.")
            else:
                # 3. WGS84 -> DSM
                p = DSM_PARAMS[d_zone[0]]
                dsm_proj = f"+proj={p['projection']} +lat_0={p['latitude_of_origin']} +lon_0={p['central_meridian']} +k={p['scale_factor']} +x_0={p['false_easting']} +y_0={p['false_northing']} +a={p['semi_major']} +b={p['semi_minor']} +units=m +no_defs"
                
                dsm_crs = CRS.from_proj4(dsm_proj)
                t2 = Transformer.from_crs("epsg:4326", dsm_crs, always_xy=True)
                de, dn = t2.transform(lon, lat)
                
                st.markdown(f"""
                <div class="result-box">
                    <h4>✅ DSM Output ({d_zone})</h4>
                    <p><b>Easting:</b> {de:.3f} m</p>
                    <p><b>Northing:</b> {dn:.3f} m</p>
                    <p><b>Intermediate WGS84:</b> {lat:.5f}, {lon:.5f}</p>
                </div>
                """, unsafe_allow_html=True)
                
        except Exception as e:
            st.error(f"Error: {e}")

# --- TAB 8: DSM TO LAT/LON ---
with tabs[7]:
    st.markdown('<div class="header-style">↩️ DSM Grid to Lat/Lon</div>', unsafe_allow_html=True)
    
    cd1, cd2 = st.columns(2)
    with cd1:
        dsm_z_sel = st.selectbox("DSM Zone", list(DSM_LCC_ZONES.keys()))
    with cd2:
        d_e = st.text_input("DSM Easting", "484789.12")
        d_n = st.text_input("DSM Northing", "966073.40")
        d_h = st.text_input("DSM Height", "600.0")
        
    if st.button("Convert DSM -> Lat/Lon"):
        try:
            ve, vn = validate_input(d_e), validate_input(d_n)
            
            major_zone = dsm_z_sel[0]
            p = DSM_PARAMS[major_zone]
            dsm_proj = f"+proj={p['projection']} +lat_0={p['latitude_of_origin']} +lon_0={p['central_meridian']} +k={p['scale_factor']} +x_0={p['false_easting']} +y_0={p['false_northing']} +a={p['semi_major']} +b={p['semi_minor']} +units=m +no_defs"
            
            dsm_crs = CRS.from_proj4(dsm_proj)
            t = Transformer.from_crs(dsm_crs, "epsg:4326", always_xy=True)
            lon, lat = t.transform(ve, vn)
            
            st.markdown(f"""
            <div class="result-box">
                <h4>📍 Result</h4>
                <p><b>Lat:</b> {lat:.6f}°</p>
                <p><b>Lon:</b> {lon:.6f}°</p>
            </div>
            """, unsafe_allow_html=True)
        except Exception as e:
            st.error(f"Error: {e}")

# --- TAB 9: DSM TO ESM ---
with tabs[8]:
    st.markdown('<div class="header-style">↩️ DSM Grid to ESM Grid</div>', unsafe_allow_html=True)
    st.caption("DSM (LCC) → WGS84 → ESM (Kalianpur)")
    
    cde1, cde2 = st.columns(2)
    with cde1:
        dz_in = st.selectbox("Source DSM Zone", list(DSM_LCC_ZONES.keys()), key="dsm2esm_zone")
    with cde2:
        de_in = st.text_input("DSM Easting", "484789.12", key="dsm2esm_e")
        dn_in = st.text_input("DSM Northing", "966073.40", key="dsm2esm_n")
        dh_in = st.text_input("Height", "600.0", key="dsm2esm_h")
        
    if st.button("Convert DSM -> ESM"):
        try:
            ve, vn = validate_input(de_in), validate_input(dn_in)
            
            # 1. DSM -> WGS84
            major_zone = dz_in[0]
            p = DSM_PARAMS[major_zone]
            dsm_proj = f"+proj={p['projection']} +lat_0={p['latitude_of_origin']} +lon_0={p['central_meridian']} +k={p['scale_factor']} +x_0={p['false_easting']} +y_0={p['false_northing']} +a={p['semi_major']} +b={p['semi_minor']} +units=m +no_defs"
            
            dsm_crs = CRS.from_proj4(dsm_proj)
            t1 = Transformer.from_crs(dsm_crs, "epsg:4326", always_xy=True)
            lon, lat = t1.transform(ve, vn)
            
            # 2. WGS84 -> ESM (Auto detect Kalianpur zone)
            kz, ke, _ = detect_kalianpur_zone(lat, lon)
            
            if not kz:
                st.error("Outside ESM (Kalianpur) coverage area.")
            else:
                t2 = Transformer.from_crs("epsg:4326", f"epsg:{ke}", always_xy=True)
                ee, en = t2.transform(lon, lat)
                
                st.markdown(f"""
                <div class="result-box">
                    <h4>✅ ESM Output ({kz})</h4>
                    <p><b>Easting:</b> {ee:,.3f} m</p>
                    <p><b>Northing:</b> {en:,.3f} m</p>
                    <p><b>EPSG:</b> {ke}</p>
                </div>
                """, unsafe_allow_html=True)
        except Exception as e:
            st.error(f"Error: {e}")

# --- TAB 10: BATCH PROCESSING ---
with tabs[9]:
    st.markdown('<div class="header-style">📊 Batch Processing (CSV)</div>', unsafe_allow_html=True)
    st.info("Columns required: `easting`, `northing`, `height`, `point_id` (optional)")
    
    # Template Download
    template_data = "easting,northing,height,point_id\n3877983.50,756073.40,600.0,P1\n3878500.20,756500.10,650.0,P2"
    st.download_button("📥 Download CSV Template", template_data, "template.csv", "text/csv")
    
    uploaded_file = st.file_uploader("Upload CSV", type=['csv'])
    
    if uploaded_file:
        df = pd.read_csv(uploaded_file)
        st.dataframe(df.head())
        
        if st.button("Start Batch Processing (Grid -> Lat/Lon)"):
            results = []
            progress_bar = st.progress(0)
            
            try:
                # Assuming Indian Grid Zone I (24378) for batch as per typical use case, 
                # or we could add a selector. Using 24378 based on main.py logic.
                t = Transformer.from_crs("epsg:24378", "epsg:4326", always_xy=True)
                
                for i, row in df.iterrows():
                    try:
                        e = float(row['easting'])
                        n = float(row['northing'])
                        lon, lat = t.transform(e, n)
                        results.append({
                            'point_id': row.get('point_id', f'P{i}'),
                            'lat': lat,
                            'lon': lon,
                            'height': row.get('height', 0),
                            'status': 'Success'
                        })
                    except Exception as e:
                        results.append({'point_id': row.get('point_id', i), 'status': f'Error: {e}'})
                    
                    progress_bar.progress((i + 1) / len(df))
                
                res_df = pd.DataFrame(results)
                st.success("Processing Complete!")
                st.dataframe(res_df)
                
                csv_buffer = io.StringIO()
                res_df.to_csv(csv_buffer, index=False)
                st.download_button("💾 Export Results", csv_buffer.getvalue(), "results.csv", "text/csv")
                
            except Exception as e:
                st.error(f"Batch Error: {e}")

# --- TAB 11: ZONE LIST ---
with tabs[10]:
    st.markdown('<div class="header-style">🗺️ Zone Reference</div>', unsafe_allow_html=True)
    
    z_type = st.radio("Select System", ["Kalianpur 1975", "DSM LCC", "WGS84"])
    
    if z_type == "Kalianpur 1975":
        for k, v in ENHANCED_KALIANPUR_ZONES.items():
            st.expander(f"{k} (EPSG:{v['epsg']})").write(f"Bounds: {v['bounds']}\n\nDesc: {v['description']}")
    elif z_type == "DSM LCC":
        for k, v in DSM_LCC_ZONES.items():
            st.write(f"**Zone {k}**: EPSG {v['epsg']} | Extent: {v['extent']}")
    else:
        for k, v in WGS84_ZONES.items():
            st.write(f"**{k}**: EPSG {v['epsg']}")

# --- TAB 12: ABOUT ---
with tabs[11]:
    st.markdown('<div class="header-style">About</div>', unsafe_allow_html=True)
    
    # Use logo_path logic here as well
    if os.path.exists(logo_path):
        st.image(logo_path, width=150)
    
    st.write("### Advanced Surveying Calculator")
    st.write("Version 4.0 Enhanced Web Edition")
    st.write("© 2025 ByteFixx Solution")
    st.write("Developer: Moorthi M")
    st.write("Contact: bytefixx33@gmail.com")
    st.write("Built with ❤️ for surveyors and geodetic professionals.")