import ast
import builtins
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from startup import load_geodesy


class Stopped(Exception):
    pass


class StartupTests(unittest.TestCase):
    def test_stale_geodesy_exports_are_refreshed(self):
        import geodesy
        del geodesy.AUTO_SOURCE_ZONE
        module = load_geodesy(('AUTO_SOURCE_ZONE', 'inverse_zone_candidates'))
        self.assertEqual(module.AUTO_SOURCE_ZONE, 'Auto (source candidates)')

    def test_valid_module_is_not_reloaded_on_every_rerun(self):
        import geodesy
        with patch('startup.importlib.reload') as reload:
            self.assertIs(load_geodesy(('DSM_ZONES',)), geodesy)
            reload.assert_not_called()

    def test_incomplete_deployment_is_not_called_missing_pyproj(self):
        with self.assertRaisesRegex(ImportError, 'Application files are out of sync'):
            load_geodesy(('missing_export_for_test',))

    def run_dependency_failure(self, error):
        source = (Path(__file__).resolve().parents[1] / 'app.py').read_text()
        block = next(n for n in ast.parse(source).body if isinstance(n, ast.Try)
                     and isinstance(n.body[0], ast.ImportFrom) and n.body[0].module == 'pyproj')
        code = compile(ast.Module(body=[block], type_ignores=[]), 'app.py', 'exec')
        st = SimpleNamespace(error=Mock(), code=Mock(), info=Mock(), stop=Mock(side_effect=Stopped))
        original = builtins.__import__
        def import_failure(name, *a, **kw):
            if name == 'pyproj':
                raise error
            return original(name, *a, **kw)
        with patch('builtins.__import__', side_effect=import_failure), self.assertRaises(Stopped):
            exec(code, {'st': st})
        return st

    def test_missing_package_has_environment_install_instructions(self):
        st = self.run_dependency_failure(ModuleNotFoundError("No module named 'pyproj'", name='pyproj'))
        self.assertIn('does not have pyproj installed', st.error.call_args.args[0])
        self.assertIn('python -m pip install -r requirements.txt', st.info.call_args.args[0])

    def test_native_import_failure_keeps_real_cause(self):
        st = self.run_dependency_failure(ImportError('DLL load failed'))
        self.assertIn('installed but could not load', st.error.call_args.args[0])
        self.assertEqual(st.code.call_args.args[0], 'DLL load failed')

    def test_nested_missing_package_is_distinguished(self):
        st = self.run_dependency_failure(ModuleNotFoundError("No module named 'certifi'", name='certifi'))
        self.assertIn('dependency needed by pyproj', st.error.call_args.args[0])


if __name__ == '__main__':
    unittest.main()
