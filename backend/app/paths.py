"""Where the app's own files are, and where a user's data goes. Two ways to run:

- from a source checkout or an unpacked package (run.sh): the app's files are the checkout, `.env` sits next to run.sh;
- as the packaged program (Waymark.exe, Waymark.app, the Linux binary, built by packaging/): the app's files are inside
  the program (PyInstaller unpacks them to sys._MEIPASS), which may be read-only, so `.env` goes into the data folder.

Only the standard library here: config.py and envfile.py both start from this."""
from __future__ import annotations

import os
import sys
from pathlib import Path

FROZEN = bool(getattr(sys, "frozen", False))
APP_ROOT = Path(sys._MEIPASS) if FROZEN else Path(__file__).resolve().parents[2]
HOME = Path.home()
# Installs from before the data folder keep their database where it is (backend/data/ctu.db).
LEGACY_DB = APP_ROOT / "backend" / "data" / "ctu.db"


def data_dir_for(env: dict, home: Path, legacy: Path, windows: bool) -> Path:
    """The data folder: CTU_DATA_DIR, else an existing old install's folder, else the system's place for app data."""
    if env.get("CTU_DATA_DIR"):
        return Path(os.path.expanduser(env["CTU_DATA_DIR"]))
    if legacy.is_file():
        return legacy.parent
    if windows:
        return Path(env.get("APPDATA") or home / "AppData" / "Roaming") / "Waymark"
    return Path(env.get("XDG_DATA_HOME") or home / ".local" / "share") / "waymark"


def env_file() -> Path:
    """The .env file with the AI keys: CTU_ENV_FILE, else next to run.sh, else (packaged program) in the data folder."""
    if os.environ.get("CTU_ENV_FILE"):
        return Path(os.path.expanduser(os.environ["CTU_ENV_FILE"]))
    if FROZEN:
        return data_dir_for(dict(os.environ), HOME, LEGACY_DB, os.name == "nt") / ".env"
    return APP_ROOT / ".env"
