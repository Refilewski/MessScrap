import sys
from pathlib import Path

# PyInstaller extracts bundled code to a temporary directory in --onefile mode.
# Keep user exports alongside the executable rather than in that temporary folder.
PROJECT_ROOT = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[1]
EXPORT_DIR = PROJECT_ROOT / "exports"
DEBUGGER_ADDRESS = "127.0.0.1:9222"
START_URL = "https://www.facebook.com/messages/"
