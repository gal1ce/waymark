#!/usr/bin/env bash
# One-time setup for Khan Academy inside the app.
#
# Installs Kolibri (Learning Equality's offline learning platform; Khan Academy's partner for offline use),
# fetches the "Khan Academy (English - US curriculum)" channel catalogue (~120 MB) and sets Kolibri up to
# listen only on this computer. After that the app downloads each unit's videos and exercises by itself,
# the current unit and the next one, about 30-80 MB per unit.
#
# Safe to run again: every step checks whether it's already done.
set -euo pipefail
cd "$(dirname "$0")"

envval() {  # a value from .env without running the file
  [ -f .env ] && grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true
}
KHOME="${CTU_KOLIBRI_HOME:-$(envval CTU_KOLIBRI_HOME)}"
KHOME="${KHOME:-$HOME/.local/share/ctu-app/kolibri}"
KHOME="${KHOME/#\~/$HOME}"
KURL="${CTU_KOLIBRI_URL:-$(envval CTU_KOLIBRI_URL)}"
KURL="${KURL:-http://127.0.0.1:8726}"
KPORT="${KURL##*:}"; KPORT="${KPORT%%/*}"
CHANNEL=c9d7f950ab6b5a1199e3d6c10d7f0103

command -v uv >/dev/null || { echo "setup-khan.sh: needs uv (https://docs.astral.sh/uv/)" >&2; exit 1; }

KBIN="${CTU_KOLIBRI_BIN:-$(envval CTU_KOLIBRI_BIN)}"
if [ -z "$KBIN" ]; then
  if ! command -v kolibri >/dev/null; then
    echo "→ installing Kolibri (uv tool, Python 3.11)"
    uv tool install --python 3.11 kolibri
  fi
  KBIN="$(command -v kolibri || echo "$HOME/.local/bin/kolibri")"
fi
[ -x "$KBIN" ] || { echo "setup-khan.sh: kolibri not found at $KBIN" >&2; exit 1; }
echo "→ Kolibri: $KBIN ($("$KBIN" --version 2>/dev/null | tail -1))"

mkdir -p "$KHOME"
export KOLIBRI_HOME="$KHOME"
# localhost only: by default Kolibri listens on every network interface
cat > "$KHOME/options.ini" <<EOF
[Deployment]
HTTP_PORT = $KPORT
LISTEN_ADDRESS = 127.0.0.1
EOF

if [ ! -f "$KHOME/content/databases/$CHANNEL.sqlite3" ]; then
  echo "→ fetching the Khan Academy channel catalogue"
  "$KBIN" manage importchannel network "$CHANNEL"
fi

# Kolibri's own player (for question types the app can't show) needs a provisioned device. Guests can
# browse without an account; the admin password is random and never needed.
if [ ! -f "$KHOME/.ctu-provisioned" ]; then
  echo "→ setting up Kolibri's player (no accounts, guest access)"
  "$KBIN" manage provisiondevice --facility "CTU" --preset informal --superusername ctu-admin \
    --superuserpassword "$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)" --language_id en --noinput
  touch "$KHOME/.ctu-provisioned"
fi

echo
echo "Done. Kolibri's data: $KHOME"
echo "Next: ./run.sh. It starts Kolibri on $KURL (this computer only) and the app downloads the current and next unit."
