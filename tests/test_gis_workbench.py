import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import numpy as np
from gis_workbench import prepare_vector, prepare_raster, sample_cloud, cloud_geojson, write_copc, vector_layers


class GISWorkbenchTests(unittest.TestCase):
    def test_geopackage_reprojection_and_field_customization(self):
        import geopandas as gpd
        from shapely.geometry import Point
        frame=gpd.GeoDataFrame({'ID':[1,2],'Value':[0,10]},geometry=[Point(500000,3320113.4),Point(500010,3320123.4)],crs=32644)
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'input.gpkg';frame.to_file(path,layer='survey',driver='GPKG');data=path.read_bytes()
        self.assertEqual(vector_layers(data,'.gpkg')[0][0],'survey')
        result=prepare_vector(data,'.gpkg','survey',fields=['ID','Value'],primary_key='ID',case_mode='lower')
        self.assertAlmostEqual(result['features'][0]['geometry']['coordinates'][0],81,places=6)
        self.assertEqual(result['features'][0]['properties']['attributes']['value'],0)

    def test_shapefile_zip_and_unsafe_archive(self):
        import geopandas as gpd
        from shapely.geometry import Point
        with tempfile.TemporaryDirectory() as d:
            gpd.GeoDataFrame({'name':['A']},geometry=[Point(78,30)],crs=4326).to_file(Path(d)/'a.shp')
            buf=io.BytesIO()
            with zipfile.ZipFile(buf,'w') as z:
                for p in Path(d).iterdir():z.write(p,p.name)
        self.assertEqual(len(prepare_vector(buf.getvalue(),'.zip')['features']),1)
        bad=io.BytesIO()
        with zipfile.ZipFile(bad,'w') as z:z.writestr('../a.shp','bad')
        with self.assertRaisesRegex(ValueError,'safe paths'):vector_layers(bad.getvalue(),'.zip')

    def test_raster_overlay_reprojects_and_retains_transparency(self):
        from rasterio.io import MemoryFile
        from rasterio.transform import from_origin
        from PIL import Image
        import base64
        array=np.arange(100,dtype='uint8').reshape(10,10);array[0,0]=255
        with MemoryFile() as mem:
            with mem.open(driver='GTiff',height=10,width=10,count=1,dtype='uint8',crs='EPSG:4326',transform=from_origin(78,31,.01,.01),nodata=255) as ds:ds.write(array,1)
            data=mem.read()
        result=prepare_raster(data);self.assertEqual(result['type'],'FSSRaster');self.assertEqual(len(result['coordinates']),4)
        image=Image.open(io.BytesIO(base64.b64decode(result['image'].split(',')[1])))
        self.assertEqual(image.mode,'RGBA');self.assertIn(0,np.asarray(image)[:,:,3]);self.assertAlmostEqual(result['coordinates'][0][0],78,places=3)

    def test_cloud_sample_preserves_source_height_as_attribute(self):
        import laspy
        from pyproj import CRS
        header=laspy.LasHeader(point_format=3,version='1.2');header.add_crs(CRS.from_epsg(32644));header.scales=np.array([.01,.01,.001]);cloud=laspy.LasData(header);cloud.x=[500000,500010];cloud.y=[3320113.4,3320123.4];cloud.z=[0,-5]
        buf=io.BytesIO();cloud.write(buf);result=sample_cloud(buf.getvalue());self.assertEqual(result['count'],2);self.assertAlmostEqual(result['sample'][0]['lon'],81,places=6)
        geo=cloud_geojson(result);self.assertEqual(geo['features'][1]['properties']['source_z'],-5);self.assertEqual(len(geo['features'][1]['geometry']['coordinates']),2)

    def test_copc_does_not_pretend_to_run_without_native_engine(self):
        with patch.dict('os.environ',{'FSS_ENABLE_NATIVE_GIS':'0'}):
            with self.assertRaisesRegex(ValueError,'PDAL'):write_copc(b'not a cloud')

    def test_planet_texture_is_separate_unit_sphere(self):
        from gis_workbench import planetary_scene
        from PIL import Image
        buf=io.BytesIO();Image.new('RGB',(64,32),'red').save(buf,format='PNG')
        fig=planetary_scene(buf.getvalue(),'Moon')
        self.assertEqual(fig.data[0].surfacecolor.shape,(128,257))
        self.assertIn('unit sphere',fig.layout.title.text)
        self.assertAlmostEqual(float(fig.data[0].z[0][0]),1)

if __name__=='__main__':unittest.main()
