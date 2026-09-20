"""Bounded GIS preparation for the Map page; uploads are processed on the host."""
import base64
import io
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

MAX_BYTES = 80 * 1024 * 1024


def check_size(data):
    if not data or len(data) > MAX_BYTES:
        raise ValueError('Choose a non-empty file up to 80 MB.')


def vector_path(data, suffix, directory):
    check_size(data)
    if suffix == '.zip':
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = [x for x in archive.infolist() if not x.is_dir()]
            if len(entries) > 40 or sum(x.file_size for x in entries) > MAX_BYTES:
                raise ValueError('Shapefile archive exceeds extraction limits.')
            shapes = [x for x in entries if x.filename.lower().endswith('.shp')]
            if len(shapes) != 1:
                raise ValueError('Upload a ZIP containing one Shapefile and its sidecar files.')
            for item in entries:
                name = Path(item.filename)
                if name.is_absolute() or '..' in name.parts or name.suffix.lower() not in {'.shp','.shx','.dbf','.prj','.cpg','.qix','.sbn','.sbx'}:
                    raise ValueError('Archive must contain only Shapefile components with safe paths.')
                target = Path(directory) / name.name
                if target.exists():
                    raise ValueError('Duplicate filenames in the archive.')
                target.write_bytes(archive.read(item))
            return Path(directory) / Path(shapes[0].filename).name
    if suffix not in {'.gpkg', '.geojson', '.json'}:
        raise ValueError('Use a zipped Shapefile, GeoPackage or GeoJSON.')
    path = Path(directory) / ('input' + suffix)
    path.write_bytes(data)
    return path


def vector_layers(data, suffix):
    import pyogrio
    with tempfile.TemporaryDirectory() as directory:
        path = vector_path(data, suffix, directory)
        return [(str(name), str(kind)) for name, kind in pyogrio.list_layers(path) if kind is not None]


def prepare_vector(data, suffix, layer=None, source_crs='', fields=None, primary_key='', case_mode='keep'):
    import pyogrio
    with tempfile.TemporaryDirectory() as directory:
        path = vector_path(data, suffix, directory)
        frame = pyogrio.read_dataframe(path, layer=layer, max_features=2001)
    if len(frame) > 2000:
        raise ValueError('Map limit is 2,000 features. Export a smaller region first.')
    if frame.crs is None:
        if not source_crs.strip():
            raise ValueError('This file has no CRS. Supply its actual source CRS; no WGS84 assumption is made.')
        frame = frame.set_crs(source_crs)
    if primary_key:
        if primary_key not in frame.columns or frame[primary_key].isna().any() or frame[primary_key].astype(str).duplicated().any() or (frame[primary_key].astype(str)=='').any():
            raise ValueError('Primary-key field must exist and contain unique, non-empty values.')
    geometry_name=frame.geometry.name
    if fields:
        if any(f not in frame.columns or f == geometry_name for f in fields):
            raise ValueError('Unknown attribute field selected.')
        frame=frame[[*fields,geometry_name]]
    mapping={k:(k.lower() if case_mode=='lower' else k.upper() if case_mode=='upper' else k) for k in frame.columns if k!=geometry_name}
    if len(set(mapping.values()))!=len(mapping) or geometry_name in mapping.values():
        raise ValueError('Case conversion would duplicate a field name.')
    frame=frame.rename(columns=mapping).to_crs(4326).explode(index_parts=False,ignore_index=True)
    if len(frame)>2000: raise ValueError('Exploded geometry exceeds the 2,000-feature map limit.')
    frame=frame[~frame.geometry.is_empty & frame.geometry.notna()]
    if not frame.geometry.is_valid.all(): raise ValueError('Invalid geometry found. Repair the source geometry before importing.')
    if not frame.geometry.geom_type.isin(['Point','LineString','Polygon']).all(): raise ValueError('Only point, line and polygon geometry is supported.')
    result=json.loads(frame.to_json(na='null',drop_id=True))
    def count(c): return 1 if c and isinstance(c[0],(int,float)) else sum(count(x) for x in c)
    if sum(count(f['geometry']['coordinates']) for f in result['features'])>50000: raise ValueError('Geometry exceeds 50,000 vertices. Simplify the source first.')
    for f in result['features']:
        props=f['properties'];props['attributes']=dict(props);props['folder']=layer or 'Imported GIS';props['name']=str(props.get('name',props.get(primary_key,'GIS feature')))
    return result


def prepare_raster(data):
    import numpy as np
    import rasterio
    from rasterio.io import MemoryFile
    from rasterio.vrt import WarpedVRT
    from rasterio.enums import Resampling
    from pyproj import Transformer
    from PIL import Image
    check_size(data)
    with MemoryFile(data) as mem, mem.open() as source:
        if source.crs is None: raise ValueError('GeoTIFF has no CRS; assign its actual source CRS before importing.')
        with WarpedVRT(source, crs='EPSG:3857') as ds:
            if not ds.width or not ds.height: raise ValueError('Empty raster.')
            ratio=min(1,1024/max(ds.width,ds.height));w=max(1,round(ds.width*ratio));h=max(1,round(ds.height*ratio))
            rgb=ds.read(indexes=[1,2,3] if ds.count>=3 else [1],out_shape=(3 if ds.count>=3 else 1,h,w),resampling=Resampling.bilinear,masked=True)
            channels=[]
            for band in rgb:
                valid=band.compressed();valid=valid[np.isfinite(valid)]
                if not len(valid): raise ValueError('Raster has no valid pixels.')
                lo,hi=np.percentile(valid,[2,98]);scaled=np.clip((band.filled(lo)-lo)/max(float(hi-lo),1e-9)*255,0,255).astype('uint8');channels.append(scaled)
            if len(channels)==1:channels*=3
            mask=ds.dataset_mask(out_shape=(h,w),resampling=Resampling.nearest)
            rgba=np.dstack([*channels,mask]);bounds=ds.bounds
    tr=Transformer.from_crs(3857,4326,always_xy=True)
    corners=[tr.transform(bounds.left,bounds.top),tr.transform(bounds.right,bounds.top),tr.transform(bounds.right,bounds.bottom),tr.transform(bounds.left,bounds.bottom)]
    if any(not math.isfinite(x) for p in corners for x in p) or any(abs(p[1])>85.05113 or abs(p[0])>180 for p in corners):raise ValueError('Raster extent is outside supported Web Mercator coverage.')
    buf=io.BytesIO();Image.fromarray(rgba).save(buf,format='PNG')
    return {'type':'FSSRaster','version':1,'coordinates':corners,'image':'data:image/png;base64,'+base64.b64encode(buf.getvalue()).decode(),'description':'GeoTIFF preview, warped to Web Mercator; 2–98% contrast stretch; not an elevation model.'}


def sample_cloud(data, source_crs='', limit=1500):
    import laspy
    import numpy as np
    from pyproj import Transformer
    check_size(data)
    rows=[]
    with laspy.open(io.BytesIO(data)) as source:
        crs=source.header.parse_crs()
        if crs is None:
            if not source_crs.strip(): raise ValueError('Point cloud has no CRS. Supply the actual source CRS.')
            crs=source_crs
        transformer=Transformer.from_crs(crs,4326,always_xy=True)
        step=max(1,math.ceil(source.header.point_count/limit));offset=0
        for chunk in source.chunk_iterator(100000):
            ids=np.arange((-offset)%step,len(chunk),step);offset+=len(chunk)
            if not len(ids):continue
            lon,lat=transformer.transform(np.asarray(chunk.x)[ids],np.asarray(chunk.y)[ids],errcheck=True)
            for x,y,z,c in zip(lon,lat,np.asarray(chunk.z)[ids],np.asarray(chunk.classification)[ids]):
                if not all(math.isfinite(float(v)) for v in (x,y,z)) or abs(x)>180 or abs(y)>90:raise ValueError('Invalid transformed cloud coordinates.')
                rows.append({'lon':float(x),'lat':float(y),'z':float(z),'classification':int(c)})
        count=source.header.point_count
    return {'count':count,'sample':rows[:limit],'source_crs':str(crs)}


def cloud_geojson(result):
    return {'type':'FeatureCollection','features':[{'type':'Feature','geometry':{'type':'Point','coordinates':[p['lon'],p['lat']]},'properties':{'name':f'Cloud {i+1}','folder':'Point cloud sample','source_z':p['z'],'classification':p['classification'],'heightReference':'Source cloud Z retained as attribute; vertical datum not transformed'}} for i,p in enumerate(result['sample'])]}


def copc_available():
    return os.environ.get('FSS_ENABLE_NATIVE_GIS')=='1' and shutil.which('pdal') is not None


def write_copc(data):
    check_size(data)
    if not copc_available():raise ValueError('COPC output requires PDAL installed on the host and FSS_ENABLE_NATIVE_GIS=1.')
    with tempfile.TemporaryDirectory() as directory:
        source=Path(directory)/'input.las';target=Path(directory)/'output.copc.laz';pipeline=Path(directory)/'pipeline.json';source.write_bytes(data)
        pipeline.write_text(json.dumps({'pipeline':[{'type':'readers.las','filename':str(source)},{'type':'writers.copc','filename':str(target),'forward':'all'}]}))
        result=subprocess.run([shutil.which('pdal'),'pipeline',str(pipeline)],capture_output=True,text=True,timeout=120,check=False)
        if result.returncode:raise ValueError('PDAL could not create COPC. Verify the source cloud and PDAL writers.copc support.')
        if not target.exists() or target.stat().st_size>MAX_BYTES:raise ValueError('COPC output is absent or exceeds 80 MB.')
        return target.read_bytes()


def postgis_layers():
    import psycopg
    dsn=os.environ.get('FSS_POSTGIS_DSN')
    if not dsn:raise ValueError('PostGIS is not configured by the host administrator.')
    with psycopg.connect(dsn,connect_timeout=5,options='-c default_transaction_read_only=on -c statement_timeout=10000') as conn:
        return conn.execute('SELECT f_table_schema, f_table_name, f_geometry_column, srid FROM geometry_columns').fetchall()


def read_postgis(schema,table,geometry):
    import psycopg
    from psycopg import sql
    allowed={(s,t,g) for s,t,g,_ in postgis_layers()}
    if (schema,table,geometry) not in allowed:raise ValueError('Choose a registered geometry table.')
    dsn=os.environ['FSS_POSTGIS_DSN']
    with psycopg.connect(dsn,connect_timeout=5,options='-c default_transaction_read_only=on -c statement_timeout=10000') as conn:
        query=sql.SQL('SELECT ST_AsGeoJSON(ST_Transform({g},4326)), to_jsonb(t)-{name} FROM {s}.{t} t LIMIT 2001').format(g=sql.Identifier(geometry),name=sql.Literal(geometry),s=sql.Identifier(schema),t=sql.Identifier(table))
        rows=conn.execute(query).fetchall()
    if len(rows)>2000:raise ValueError('Table exceeds 2,000 features; prepare a smaller database view.')
    return {'type':'FeatureCollection','features':[{'type':'Feature','geometry':json.loads(g),'properties':p} for g,p in rows if g]}


def planetary_scene(data, body):
    """Texture preview on a unit sphere, deliberately separate from Earth surveying."""
    import numpy as np
    import plotly.graph_objects as go
    from PIL import Image
    check_size(data)
    with Image.open(io.BytesIO(data)) as image:
        if image.width * image.height > 32_000_000:
            raise ValueError('Texture limit is 32 million pixels.')
        if abs(image.width / image.height - 2) > .05:
            raise ValueError('Use a 2:1 equirectangular texture, north at top, longitude -180 at left.')
        texture = image.convert('RGB').resize((256,128)).quantize(colors=64)
        colors = texture.getpalette()
        colors = (colors + [0]*192)[:192]
        values = np.asarray(texture)
    lon, lat = np.meshgrid(np.linspace(-np.pi,np.pi,257),np.linspace(np.pi/2,-np.pi/2,128))
    values = np.column_stack((values, values[:,0]))
    colorscale=[]
    for n in range(64):
        rgb=colors[3*n:3*n+3]
        color=f'rgb({rgb[0]},{rgb[1]},{rgb[2]})'
        colorscale.extend([[n/64,color],[(n+1)/64,color]])
    figure=go.Figure(go.Surface(x=np.cos(lat)*np.cos(lon),y=np.cos(lat)*np.sin(lon),z=np.sin(lat),surfacecolor=values,cmin=-.5,cmax=63.5,colorscale=colorscale,showscale=False,hoverinfo='skip'))
    figure.update_layout(title=f'{body} texture preview · unit sphere',scene=dict(xaxis=dict(visible=False),yaxis=dict(visible=False),zaxis=dict(visible=False),aspectmode='cube'),height=550,margin=dict(l=0,r=0,t=45,b=0))
    return figure


def render_gis_workbench():
    import streamlit as st
    with st.expander('GIS data workbench · Shapefile, GeoPackage, GeoTIFF, PostGIS & point clouds'):
        st.caption('Files in this workbench are uploaded to the app host for conversion. Download the prepared file, then import it using Layers & data → Import vector file in the map. Regular GeoJSON/GPX/KML map imports stay in your browser.')
        kind=st.selectbox('Data task',['Vector file','GeoTIFF overlay','Point cloud / COPC','Virtual point cloud manifest','Planetary texture scene','PostGIS'],key='gis_data_task')
        try:
            if kind=='Vector file':
                file=st.file_uploader('GIS vector file',type=['zip','gpkg','geojson','json'],key='gis_vector')
                if file:
                    data=file.getvalue();suffix=Path(file.name).suffix.lower();layers=vector_layers(data,suffix)
                    if not layers:st.info('No spatial layer found.');return
                    layer=st.selectbox('Dataset layer',[n for n,_ in layers],key='gis_dataset_layer')
                    crs=st.text_input('Source CRS if missing (for example EPSG:32644)',key='gis_vector_crs')
                    fields=st.text_input('Keep fields (comma separated; blank keeps all)',key='gis_vector_fields')
                    primary=st.text_input('Primary key (optional)',key='gis_vector_pk')
                    case=st.selectbox('Field case',['keep','lower','upper'],key='gis_vector_case')
                    if st.button('Prepare WGS84 GeoJSON',key='gis_prepare_vector'):
                        result=prepare_vector(data,suffix,layer,crs,[x.strip() for x in fields.split(',') if x.strip()],primary,case)
                        st.download_button('Download prepared GeoJSON',json.dumps(result),'prepared-layer.geojson','application/geo+json')
                        st.success(f"Prepared {len(result['features'])} features. Import this file into the map.")
            elif kind=='GeoTIFF overlay':
                file=st.file_uploader('GeoTIFF',type=['tif','tiff'],key='gis_tif')
                if file and st.button('Prepare raster overlay',key='gis_prepare_raster'):
                    result=prepare_raster(file.getvalue());st.image(base64.b64decode(result['image'].split(',')[1]),caption=result['description'])
                    st.download_button('Download map raster overlay',json.dumps(result),'prepared-raster.fss-raster.json','application/json')
            elif kind=='Point cloud / COPC':
                file=st.file_uploader('LAS / LAZ / COPC LAZ',type=['las','laz'],key='gis_cloud');crs=st.text_input('Source CRS if absent',key='gis_cloud_crs')
                if file and st.button('Inspect cloud and prepare sample',key='gis_cloud_prepare'):
                    result=sample_cloud(file.getvalue(),crs);st.write(f"{result['count']:,} source points · {len(result['sample'])} preview points. Z remains in the source vertical reference.")
                    import plotly.express as px
                    if result['sample']:st.plotly_chart(px.scatter_3d(result['sample'],x='lon',y='lat',z='z',color='classification'),key='gis_cloud_plot')
                    st.download_button('Download map point sample',json.dumps(cloud_geojson(result)),'cloud-sample.geojson','application/geo+json')
                if copc_available():
                    if file and st.button('Create COPC file with PDAL',key='gis_copc'):
                        st.download_button('Download COPC',write_copc(file.getvalue()),'output.copc.laz','application/octet-stream')
                else:st.info('Native COPC output needs PDAL on the host with FSS_ENABLE_NATIVE_GIS=1. LAS/LAZ inspection and map samples work without PDAL.')
            elif kind=='Planetary texture scene':
                st.caption('Visualization only: Earth, Mars or Moon on a unit sphere. No terrestrial survey layers, heights or distance measurements are applied to another body.')
                body=st.selectbox('Body',['Earth','Mars','Moon'],key='gis_body')
                file=st.file_uploader('Your 2:1 equirectangular texture (north at top; -180° at left)',type=['png','jpg','jpeg'],key='gis_texture')
                if file:
                    figure=planetary_scene(file.getvalue(),body)
                    st.plotly_chart(figure,key='gis_planet_plot')
                    st.download_button('Download standalone globe scene',figure.to_html(include_plotlyjs=True),'planetary-scene.html','text/html')
            elif kind=='Virtual point cloud manifest':
                st.caption('Inspect a VPC/STAC feature collection. Referenced assets are listed, not fetched automatically; upload each required LAS/LAZ in Point cloud / COPC.')
                file=st.file_uploader('VPC manifest',type=['vpc','json'],key='gis_vpc')
                if file:
                    data=file.getvalue();check_size(data);manifest=json.loads(data)
                    if manifest.get('type')!='FeatureCollection':raise ValueError('Expected a VPC/STAC FeatureCollection.')
                    rows=[]
                    if len(manifest.get('features',[]))>2000:raise ValueError('Manifest limit is 2,000 entries.')
                    for f in manifest.get('features',[]):
                        for name,a in f.get('assets',{}).items():rows.append({'item':str(f.get('id','')),'asset':name,'href':str(a.get('href',''))})
                    st.dataframe(rows)
            else:
                if not os.environ.get('FSS_POSTGIS_DSN'):st.info('PostGIS requires a host-configured read-only FSS_POSTGIS_DSN connection. No database password is stored in the browser.');return
                layers=postgis_layers()
                if not layers:st.info('No registered spatial tables available.');return
                choice=st.selectbox('Spatial table',layers,format_func=lambda r:f'{r[0]}.{r[1]} · EPSG:{r[3]}',key='gis_pg_table')
                if st.button('Read table as WGS84 GeoJSON',key='gis_pg_read'):
                    data=read_postgis(*choice[:3]);st.download_button('Download database layer',json.dumps(data),'postgis-layer.geojson','application/geo+json')
        except ImportError as exc:
            st.error(f'GIS component unavailable: {exc}. Install the complete requirements.txt on the app host.')
        except (ValueError,OSError,zipfile.BadZipFile,subprocess.TimeoutExpired) as exc:
            st.error(str(exc))
        except Exception:
            st.error('The GIS operation could not complete. Check the input format, CRS and host configuration.')
