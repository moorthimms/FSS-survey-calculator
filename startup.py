"""Load updated local modules without misdiagnosing dependency failures."""
import importlib
import sys


def load_geodesy(required_names):
    # Streamlit can rerun app.py while retaining an older imported module.
    # Reload only if a cached module lacks an export needed by this app version.
    was_cached = 'geodesy' in sys.modules
    module = importlib.import_module('geodesy')
    missing = [name for name in required_names if not hasattr(module, name)]
    if missing and was_cached:
        importlib.invalidate_caches()
        module = importlib.reload(module)
        missing = [name for name in required_names if not hasattr(module, name)]
    if missing:
        raise ImportError('Application files are out of sync: geodesy.py lacks ' + ', '.join(missing)
                          + '. Deploy the complete repository and restart the app.')
    return module
