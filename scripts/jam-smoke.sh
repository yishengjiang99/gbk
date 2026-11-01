#!/usr/bin/env bash
# Start a throwaway local server and run the Live Jam room flow against it.
# Usage: scripts/jam-smoke.sh            (or JAM_SMOKE_BASE=https://... to hit an existing server with matching access codes)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${JAM_SMOKE_PORT:-8787}"
if [ -z "${JAM_SMOKE_BASE:-}" ]; then
  DATA="$(mktemp -d)"; LOG="$DATA/server.log"
  PORT="$PORT" COMPOSER_PUBLIC_ORIGIN="http://127.0.0.1:$PORT" COMPOSER_DATA_DIR="$DATA" SESSION_SECRET="$(head -c 32 /dev/urandom | base64)" \
    COMPOSER_ACCESS_CODES="p1:code-p1,p2:code-p2,p3:code-p3,p4:code-p4,p5:code-p5" \
    JAM_TURN_URLS="turn:127.0.0.1:3478?transport=udp,turn:127.0.0.1:3478?transport=tcp" JAM_TURN_SHARED_SECRET="smoke-turn-secret-0123456789" \
    SERVER_RENDER=0 RATE_IP_PER_MINUTE=1000 RATE_LOGIN_PER_MINUTE=100 \
    node --disable-warning=ExperimentalWarning --import tsx/esm server/src/index.ts >"$LOG" 2>&1 &
  PID=$!
  trap 'kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -rf "$DATA"' EXIT
  for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
  curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null || { echo "server did not start:"; tail -30 "$LOG"; exit 1; }
  BASE="http://127.0.0.1:$PORT"
else BASE="$JAM_SMOKE_BASE"; fi
echo "jam smoke against $BASE"
node scripts/jam-smoke.mjs "$BASE" "${JAM_SMOKE_ORIGIN:-$BASE}"
