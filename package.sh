#!/usr/bin/env bash
# Makes the file you give a friend: waymark-<date>.tar.gz and .zip in ./packages. The UI is built inside it, so
# they only need uv (https://docs.astral.sh/uv/). No data goes in: no database, notes, pictures, backups, .env or
# API key; the package is the app alone, and each install makes its own data folder on first start.
#
# Usage: ./package.sh
set -euo pipefail
cd "$(dirname "$0")"

command -v npm >/dev/null 2>&1 || { echo "package.sh: npm is needed to build the UI." >&2; exit 1; }
(cd frontend && { [ -d node_modules ] || npm install --silent; } && npm run build --silent)

NAME="waymark-$(date +%Y.%m.%d)"
OUT="$(pwd)/packages"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
D="$STAGE/$NAME"
mkdir -p "$D/backend" "$D/frontend" "$OUT"

# the app: code, dependency lock, built UI, start scripts. Only what is listed here goes in.
cp -r backend/app "$D/backend/app"
cp backend/pyproject.toml backend/uv.lock "$D/backend/"
# the copy leaves out the authors list (names and e-mail addresses stay on this computer)
python3 - "$D/backend/pyproject.toml" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
open(p, "w").write(re.sub(r"(?ms)^authors = \[.*?^\]\n", "", s))
PY
[ -d backend/src ] && cp -r backend/src "$D/backend/src"
cp -r frontend/dist "$D/frontend/dist"
cp run.sh run.ps1 install.sh .env.example "$D/"
cp INSTALL.md "$D/README.md"
find "$D" -name '__pycache__' -type d -prune -exec rm -rf {} +
find "$D" \( -name '*.pyc' -o -name '.DS_Store' \) -delete

# nothing personal may be inside: no databases, keys or backups
bad="$(find "$D" \( -name '*.db' -o -name '*.db-*' -o -name '.env' -o -name 'api-key' -o -name 'backups' -o -name '*.zip' \) -print)"
if [ -n "$bad" ]; then echo "package.sh: refusing, the package would contain: $bad" >&2; exit 1; fi
if grep -rqE '[A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|icloud|proton)\.' "$D"; then
  echo "package.sh: refusing, an e-mail address is inside: $(grep -rlE '[A-Za-z0-9._%+-]+@(gmail|outlook|hotmail|yahoo|icloud|proton)\.' "$D")" >&2; exit 1
fi

rm -f "$OUT/$NAME.tar.gz" "$OUT/$NAME.zip"
tar -C "$STAGE" -czf "$OUT/$NAME.tar.gz" "$NAME"
if command -v zip >/dev/null 2>&1; then (cd "$STAGE" && zip -qr "$OUT/$NAME.zip" "$NAME"); fi
echo "package.sh: $(du -h "$OUT/$NAME.tar.gz" | cut -f1) $OUT/$NAME.tar.gz"
[ -f "$OUT/$NAME.zip" ] && echo "package.sh: $(du -h "$OUT/$NAME.zip" | cut -f1) $OUT/$NAME.zip (for Windows)"
