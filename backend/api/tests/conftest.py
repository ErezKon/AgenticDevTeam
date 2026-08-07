import sys
import pathlib
import os
# Ensure test utility routes are enabled
os.environ.setdefault("TEST_MODE", "true")
# Add project root to sys.path so that imports like 'backend.api.app.main' work
project_root = pathlib.Path(__file__).resolve().parents[2]
sys.path.append(str(project_root))
