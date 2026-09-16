# FSS Survey Calculator

A Streamlit web application for surveying and geodetic calculations, including:

- latitude/longitude distance and bearing
- grid distance, bearing, and traverse calculations
- decimal-degree and DMS conversion
- WGS84, Kalianpur 1975 (ESM), and DSM coordinate conversion
- automatic zone detection
- CSV batch conversion
- browser-based position display

## Run locally

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
streamlit run app.py
```

For browser location, serve the application through HTTPS (or use localhost) and grant location permission. Browser/device location is informational and is not a substitute for survey-grade GNSS equipment.

## Input notes

- Latitude and longitude are WGS84 decimal degrees unless a DMS field is shown.
- Grid coordinates and heights are metres.
- Select the correct Kalianpur source zone for inverse and batch conversions; using the wrong zone produces incorrect coordinates.
- Kalianpur transformations are offered only for zones with valid EPSG definitions in PROJ. DSM calculations use the custom parameters defined by this application and are not labelled with unrelated EPSG codes.
