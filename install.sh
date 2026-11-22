#!/usr/bin/env bash
# One-time setup on Linux or macOS: installs the app's Python packages (uv brings Python 3.13 itself) and, on Linux,
# adds Waymark to the applications menu. Then start it from the menu or with ./run.sh --open.
#
# Nothing is installed system-wide; the data folder (~/.local/share/waymark) is made on the first start.
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd)"

if ! command -v uv >/dev/null 2>&1; then
  echo "install.sh: uv is missing. Install it first, then run this again:" >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi
echo "install.sh: installing the app's Python packages (first time: a minute or two)…"
if [ -d frontend/src ]; then (cd backend && uv sync --frozen); else (cd backend && uv sync --frozen --no-dev); fi

if [ "$(uname -s)" = "Linux" ]; then
  apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$apps"
  cat > "$apps/waymark.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Waymark
Comment=Your study plan, coach and tests
Exec=bash -c 'cd "$HERE" && ./run.sh --open'
Path=$HERE
Icon=$HERE/frontend/dist/favicon.svg
Terminal=true
Categories=Education;
EOF
  echo "install.sh: added Waymark to the applications menu ($apps/waymark.desktop)."
fi
echo "install.sh: done. Start it with ./run.sh --open (it opens http://localhost:8723)."
