#!/usr/bin/env bash
# Demo mode: works on copies, never touches the real repo, COACH.md or database.
# Usage: ./demo.sh [time]   e.g. ./demo.sh 2026-11-23T10:05
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8724}"
D="${XDG_CACHE_HOME:-$HOME/.cache}/ctu-demo"
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "demo.sh: something is already listening on port $PORT (probably a running demo)." >&2
  echo "Stop it first; this script deletes and recreates $D." >&2
  exit 1
fi
rm -rf "$D" && mkdir -p "$D"
cp -r "${CTU_STUDY_REPO_SRC:-$HOME/quaimlres_road}" "$D/repo"
cp "${CTU_COACH_MD_SRC:-$HOME/Custom/Projects/ctu-plan/COACH.md}" "$D/COACH.md"
# AI keys: a copy of .env, so keys added or removed in the demo never change the real file
if [ -f .env ]; then cp .env "$D/app.env"; chmod 600 "$D/app.env"; fi
echo "Demo folder: $D  →  http://localhost:$PORT"
CTU_STUDY_REPO="$D/repo" CTU_COACH_MD="$D/COACH.md" CTU_DB="$D/ctu.db" CTU_ENV_FILE="$D/app.env" \
CTU_NOW="${1:-2026-11-23T10:05}" PORT="$PORT" exec ./run.sh
