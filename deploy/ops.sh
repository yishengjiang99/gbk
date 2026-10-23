#!/usr/bin/env bash
# Ops helpers, run ON the server: health | logs | rollback | verify-tls | releases
set -euo pipefail
ROOT=/var/www/gbk-composer; HOST=${HOST:-compose.grepawk.com}
case "${1:-}" in
  health) curl -fsS http://127.0.0.1:8792/api/health; echo; curl -fsS -o /dev/null -w "nginx /: %{http_code}\n" -H "Host: $HOST" http://127.0.0.1/ ;;
  logs) journalctl -u gbk-composer -n "${2:-200}" --no-pager ;;
  releases) ls -1dt $ROOT/releases/*; readlink -f $ROOT/current ;;
  rollback) PREV=$(ls -1dt $ROOT/releases/* | grep -v "$(readlink -f $ROOT/current)" | head -1); ln -sfn "$PREV" $ROOT/current; systemctl restart gbk-composer; echo "rolled back to $PREV" ;;
  verify-tls) echo | openssl s_client -connect "$HOST:443" -servername "$HOST" 2>/dev/null | openssl x509 -noout -subject -dates; curl -fsS "https://$HOST/api/health"; echo ;;
  *) echo "usage: $0 health|logs [n]|releases|rollback|verify-tls"; exit 2 ;;
esac
