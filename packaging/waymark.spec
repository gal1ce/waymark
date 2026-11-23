# PyInstaller recipe for the packaged program. Build it with packaging/build.sh (or the release workflow), which
# builds the UI first. One file per system:
#   Linux   dist/waymark            a single executable
#   Windows dist/Waymark.exe        a single executable, no console window
#   macOS   dist/Waymark.app        an app bundle (build.sh wraps it in a .dmg)
# Only the app goes in: the code, the built UI, the icon and version.txt. No database, .env, keys or backend/data.
import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

ROOT = Path(SPECPATH).parent
DIST_UI = ROOT / "frontend" / "dist"
if not (DIST_UI / "index.html").is_file():
    raise SystemExit("waymark.spec: build the UI first (cd frontend && npm run build)")

MAC = sys.platform == "darwin"
WIN = sys.platform == "win32"
ICON = ROOT / "packaging" / "icon.png"   # PyInstaller turns it into .ico / .icns (needs Pillow)
# the version (build.sh writes it): the update check compares it with the latest release (app/updates.py)
VERSION_FILE = os.environ.get("WAYMARK_VERSION_FILE")
if not VERSION_FILE or not Path(VERSION_FILE).is_file():
    raise SystemExit("waymark.spec: WAYMARK_VERSION_FILE must name the version file (build.sh writes it)")

a = Analysis(
    [str(ROOT / "packaging" / "waymark.py")],
    pathex=[str(ROOT / "backend")],
    datas=[(str(DIST_UI), "frontend/dist"), (str(ICON), "."), (VERSION_FILE, ".")],
    # the app's modules are imported by name in places, and uvicorn picks its loop and protocol modules at run time
    hiddenimports=collect_submodules("app") + collect_submodules("uvicorn"),
    excludes=["tkinter", "pytest", "IPython", "matplotlib", "numpy.tests"],
    noarchive=False,
)
pyz = PYZ(a.pure)

if MAC:
    exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Waymark", console=False, icon=str(ICON))
    coll = COLLECT(exe, a.binaries, a.datas, name="Waymark")
    app = BUNDLE(coll, name="Waymark.app", icon=str(ICON), bundle_identifier="app.waymark.study",
                 info_plist={"CFBundleShortVersionString": Path(VERSION_FILE).read_text().strip(),
                             "LSUIElement": False, "NSHighResolutionCapable": True})
else:
    exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name="Waymark" if WIN else "waymark",
              console=not WIN, icon=str(ICON), upx=False)
