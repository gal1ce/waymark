#!/usr/bin/env bash
# Builds the packaged program for the system it runs on, into ./packages:
#   Linux: waymark-<version>-linux-x86_64   Windows (Git Bash): Waymark-<version>-windows.exe
#   macOS: Waymark-<version>-macos-<arm64|x86_64>.dmg
# Needs uv and npm. The release workflow (.github/workflows/release.yml) runs this on all three systems.
#
# Usage: packaging/build.sh [version]     (default: today's date)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd -W 2>/dev/null || pwd)"   # Git Bash on Windows: D:/a/… so uv and PyInstaller (Windows programs) read it
VERSION="${1:-$(date +%Y.%m.%d)}"
VERSION="${VERSION#v}"
OUT="$ROOT/packages"
mkdir -p "$OUT"

(cd frontend && { [ -d node_modules ] || npm ci --silent; } && npm run build --silent)

WORK="$ROOT/build/pyinstaller"
EXTRA=()
# macOS: the Dock integration (reopen opens a tab, Quit stops the server; app/launcher.py)
[ "$(uname -s)" = Darwin ] && EXTRA=(--with pyobjc-framework-Cocoa)
rm -rf "$WORK/dist" "$WORK/work"
mkdir -p "$WORK"
printf '%s\n' "$VERSION" > "$WORK/version.txt"   # inside the program: app/updates.py compares it with GitHub's latest
# its own Python environment, so the build never changes backend/.venv (the one run.sh and the tests use)
export UV_PROJECT_ENVIRONMENT="$WORK/venv"
(cd backend && uv sync --frozen --no-dev --quiet && \
  WAYMARK_VERSION_FILE="$WORK/version.txt" uv run --frozen --no-dev --with 'pyinstaller>=6.11' --with pillow ${EXTRA[@]+"${EXTRA[@]}"} \
    pyinstaller --noconfirm --clean --distpath "$WORK/dist" --workpath "$WORK/work" ../packaging/waymark.spec)

case "$(uname -s)" in
  Linux)
    BIN="$OUT/waymark-$VERSION-linux-$(uname -m)"
    cp "$WORK/dist/waymark" "$BIN" && chmod +x "$BIN"
    TEST=("$BIN") ;;
  Darwin)
    BIN="$OUT/Waymark-$VERSION-macos-$(uname -m).dmg"
    rm -f "$BIN"
    STAGE="$WORK/dmg" && rm -rf "$STAGE" && mkdir -p "$STAGE"
    cp -R "$WORK/dist/Waymark.app" "$STAGE/" && ln -s /Applications "$STAGE/Applications"
    hdiutil create -quiet -volname Waymark -srcfolder "$STAGE" -ov -format UDZO "$BIN"
    TEST=("$WORK/dist/Waymark.app/Contents/MacOS/Waymark") ;;
  MINGW*|MSYS*|CYGWIN*)
    BIN="$OUT/Waymark-$VERSION-windows.exe"
    cp "$WORK/dist/Waymark.exe" "$BIN"
    TEST=("$BIN") ;;
  *) echo "build.sh: unknown system $(uname -s)" >&2; exit 1 ;;
esac

# start it once on an empty data folder: the API and the page must answer
SMOKE="$(mktemp -d)"
CTU_DATA_DIR="$(cygpath -m "$SMOKE" 2>/dev/null || echo "$SMOKE")" "${TEST[@]}" --smoke-test
tail -3 "$SMOKE/waymark.log"
rm -rf "$SMOKE"
echo "build.sh: $(du -h "$BIN" | cut -f1) $BIN"
