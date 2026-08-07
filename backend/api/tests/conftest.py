import sys
import pathlib
# Add project root to sys.path so that imports like 'backend.api.app.main' work
project_root = pathlib.Path(__file__).resolve().parents[2]
sys.path.append(str(project_root))
