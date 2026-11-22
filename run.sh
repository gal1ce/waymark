#!/usr/bin/env bash
# Starts Waymark on http://localhost:8723 (PORT=… for another port). ./run.sh --open also opens it in the browser.
#
# Needs uv (it brings the right Python by itself). In a source checkout it also builds the UI with npm when the
# UI changed; a packaged copy (./package.sh) ships the UI already built, so npm isn't needed there.
set -euo pipefail
cd "$(dirname "$0")"

OPEN=0
for a in "$@"; do
  case "$a" in
    --open) OPEN=1 ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "run.sh: unknown option $a (try --help)" >&2; exit 2 ;;
  esac
done
PORT="${PORT:-8723}"

if ! command -v uv >/dev/null 2>&1; then
  echo "run.sh: uv is missing. Install it once (https://docs.astral.sh/uv/getting-started/installation/):" >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi
command -v gcc >/dev/null 2>&1 || echo "run.sh: gcc not found; only C exercises need it (the app compiles them when you save)." >&2

if [ -d frontend/src ]; then
  # a source checkout: build the UI when it changed since the last build
  if ! command -v npm >/dev/null 2>&1; then
    [ -f frontend/dist/index.html ] || { echo "run.sh: npm is missing and the UI isn't built yet (install Node.js)." >&2; exit 1; }
    echo "run.sh: npm not found; using the UI built earlier." >&2
  else
    cd frontend
    # reinstall when package.json or the lockfile changed since the last install
    if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
      npm install --silent
    fi
    if [ ! -d dist ] || [ -n "$(find src index.html package.json vite.config.ts -newer dist -print -quit)" ]; then
      npm run build --silent
      touch dist
    fi
    cd ..
  fi
elif [ ! -f frontend/dist/index.html ]; then
  echo "run.sh: the UI is missing (frontend/dist). Unpack the package again." >&2
  exit 1
fi

if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "run.sh: something is already listening on port $PORT. Is Waymark already running? Otherwise: PORT=8725 ./run.sh" >&2
  exit 1
fi

envval() { [ -f .env ] && grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true; }

# Khan content (./setup-khan.sh, the CTU plan only): start Kolibri's player on this computer if it isn't running yet
KHOME="${CTU_KOLIBRI_HOME:-$(envval CTU_KOLIBRI_HOME)}"; KHOME="${KHOME:-$HOME/.local/share/ctu-app/kolibri}"; KHOME="${KHOME/#\~/$HOME}"
KURL="${CTU_KOLIBRI_URL:-$(envval CTU_KOLIBRI_URL)}"; KURL="${KURL:-http://127.0.0.1:8726}"
KBIN="${CTU_KOLIBRI_BIN:-$(envval CTU_KOLIBRI_BIN)}"; KBIN="${KBIN:-$(command -v kolibri || true)}"
if [ -n "$KBIN" ] && [ -f "$KHOME/options.ini" ]; then
  if ! curl -sf -o /dev/null --max-time 1 "$KURL/api/public/info/"; then
    if KOLIBRI_HOME="$KHOME" "$KBIN" start >/dev/null 2>&1; then echo "run.sh: Kolibri (Khan player) on $KURL"
    else echo "run.sh: Kolibri didn't start; see $KHOME/logs/kolibri.txt. Videos and exercises still work in the app." >&2; fi
  fi
fi

URL="http://localhost:$PORT"
if [ "$OPEN" = 1 ]; then
  (
    for _ in $(seq 120); do curl -s -o /dev/null --max-time 1 "$URL/api/meta" && break; sleep 0.5; done
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
    elif command -v open >/dev/null 2>&1; then open "$URL"
    else echo "run.sh: open $URL in your browser"; fi
  ) &
fi
echo "run.sh: Waymark on $URL (Ctrl+C stops it)"

cd backend
# a packaged copy has no tests, so it skips the test tools; a source checkout keeps them
DEV=(); [ -d ../frontend/src ] || DEV=(--no-dev)   # ${DEV[@]+…} below: bash 3.2 (macOS) calls an empty array unset
exec uv run --frozen ${DEV[@]+"${DEV[@]}"} uvicorn app.main:app --host 127.0.0.1 --port "$PORT"
