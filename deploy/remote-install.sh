#!/usr/bin/env bash
# Runs ON the server: install a release tarball, switch `current`, zero-downtime restart, health-check, auto-rollback.
#   remote-install.sh /tmp/gbk-composer-<id>.tgz <id>
# Zero downtime: start the new release as a standby on :8793 (nginx `backup` upstream), wait until healthy, then
# restart the primary :8792 (graceful drain; nginx retries connect errors on the standby), wait until healthy, stop
# the standby. If the standby never gets healthy, the primary was never touched and `current` is rolled back.
set -euo pipefail
TGZ=$1; ID=$2; ROOT=/var/www/gbk-composer; REL=$ROOT/releases/$ID
mkdir -p "$REL" /var/lib/gbk-composer; chown www-data:www-data /var/lib/gbk-composer
tar xzf "$TGZ" -C "$REL"
(cd "$REL" && npm install --omit=dev --no-audit --no-fund --ignore-scripts fastify@5 ws@8 @modelcontextprotocol/sdk@1 zod@4 >/dev/null)
PREV=$(readlink -f $ROOT/current 2>/dev/null || true)
if [ ! -f /etc/gbk-composer.env ]; then install -m 0640 -o root -g www-data "$REL/deploy/compose.env.example" /etc/gbk-composer.env; echo "WARNING: created /etc/gbk-composer.env from the example; edit it"; fi
healthy() { for i in $(seq 1 30); do sleep 1; curl -fsS "http://127.0.0.1:$1/api/health" >/dev/null 2>&1 && return 0; done; return 1; }
ln -sfn "$REL" $ROOT/current.new && mv -Tf $ROOT/current.new $ROOT/current
install -m 0644 "$REL/deploy/gbk-composer.service" /etc/systemd/system/gbk-composer.service
install -m 0644 "$REL/deploy/gbk-composer-standby.service" /etc/systemd/system/gbk-composer-standby.service
systemctl daemon-reload; systemctl enable gbk-composer >/dev/null 2>&1
systemctl restart gbk-composer-standby
if ! healthy 8793; then
  echo "standby health check failed; primary untouched, rolling back current to $PREV" >&2
  journalctl -u gbk-composer-standby -n 40 --no-pager >&2 || true
  systemctl stop gbk-composer-standby || true
  [ -n "$PREV" ] && ln -sfn "$PREV" $ROOT/current
  exit 1
fi
systemctl restart gbk-composer
if healthy 8792; then
  sleep 2; systemctl stop gbk-composer-standby
  echo "healthy: $ID"; ls -1dt $ROOT/releases/* | tail -n +6 | xargs -r rm -rf; exit 0
fi
echo "primary health check failed; rolling back to $PREV (standby keeps serving meanwhile)" >&2
journalctl -u gbk-composer -n 40 --no-pager >&2
if [ -n "$PREV" ]; then ln -sfn "$PREV" $ROOT/current; systemctl restart gbk-composer; healthy 8792 || true; fi
systemctl stop gbk-composer-standby || true; exit 1
