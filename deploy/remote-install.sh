#!/usr/bin/env bash
# Runs ON the server: install a release tarball, switch `current`, restart, health-check, auto-rollback.
#   remote-install.sh /tmp/gbk-composer-<id>.tgz <id>
set -euo pipefail
TGZ=$1; ID=$2; ROOT=/var/www/gbk-composer; REL=$ROOT/releases/$ID
mkdir -p "$REL" /var/lib/gbk-composer; chown www-data:www-data /var/lib/gbk-composer
tar xzf "$TGZ" -C "$REL"
(cd "$REL" && npm install --omit=dev --no-audit --no-fund --ignore-scripts fastify@5 ws@8 @modelcontextprotocol/sdk@1 zod@4 >/dev/null)
PREV=$(readlink -f $ROOT/current 2>/dev/null || true)
ln -sfn "$REL" $ROOT/current.new && mv -Tf $ROOT/current.new $ROOT/current
if [ ! -f /etc/gbk-composer.env ]; then install -m 0640 -o root -g www-data "$REL/deploy/compose.env.example" /etc/gbk-composer.env; echo "WARNING: created /etc/gbk-composer.env from the example; edit it"; fi
install -m 0644 "$REL/deploy/gbk-composer.service" /etc/systemd/system/gbk-composer.service
systemctl daemon-reload; systemctl enable gbk-composer >/dev/null 2>&1; systemctl restart gbk-composer
for i in $(seq 1 20); do sleep 1; if curl -fsS http://127.0.0.1:8792/api/health >/dev/null; then echo "healthy: $ID"; ls -1dt $ROOT/releases/* | tail -n +6 | xargs -r rm -rf; exit 0; fi; done
echo "health check failed; rolling back to $PREV" >&2
if [ -n "$PREV" ]; then ln -sfn "$PREV" $ROOT/current; systemctl restart gbk-composer; fi
journalctl -u gbk-composer -n 40 --no-pager >&2; exit 1
