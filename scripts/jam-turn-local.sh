#!/usr/bin/env bash
# Local coturn for tests: shared-secret mode on 127.0.0.1:3478. Loopback peers are allowed here only.
# TURNSERVER=/path/to/turnserver overrides the binary. Usage: JAM_TURN_SECRET=... scripts/jam-turn-local.sh
set -euo pipefail
exec "${TURNSERVER:-turnserver}" -n --use-auth-secret --static-auth-secret="${JAM_TURN_SECRET:?}" --realm=jam.local \
  --listening-ip=127.0.0.1 --relay-ip=127.0.0.1 --listening-port="${JAM_TURN_PORT:-3478}" --min-port=49500 --max-port=49600 \
  --allow-loopback-peers --no-cli --no-tls --no-dtls --fingerprint --log-file=stdout --simple-log
