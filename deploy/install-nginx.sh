#!/usr/bin/env bash
# Safely install deploy/nginx.conf as the live compose.grepawk.com site (runs ON the host).
#   bash install-nginx.sh /path/to/nginx.conf
# Refuses a config without the TLS lines, backs up the live file, runs `nginx -t`, reloads, probes HTTPS,
# and restores the backup (and reloads) if any step fails. Never leaves the site without SSL.
set -uo pipefail
NEW=${1:?usage: install-nginx.sh NEW_CONF}; LIVE=${NGINX_SITE:-/etc/nginx/sites-available/compose.grepawk.com}
PROBE=${NGINX_PROBE_URL:-https://compose.grepawk.com/chatgpt}; BAK="$LIVE.bak.$(date +%Y%m%d%H%M%S)"
for pat in 'listen 443 ssl' 'ssl_certificate ' 'ssl_certificate_key ' 'return 301 https://'; do
  grep -q "$pat" "$NEW" || { echo "install-nginx: refusing $NEW: missing '$pat' (would drop HTTPS)"; exit 2; }
done
if cmp -s "$NEW" "$LIVE"; then echo "install-nginx: live config already current"; exit 0; fi
cp -p "$LIVE" "$BAK"
rollback() { echo "install-nginx: $1; restoring $BAK"; cp -p "$BAK" "$LIVE"; nginx -t >/dev/null 2>&1 && systemctl reload nginx; exit 1; }
install -m0644 "$NEW" "$LIVE"
nginx -t >/dev/null 2>&1 || rollback "nginx -t failed"
systemctl reload nginx || rollback "reload failed"
sleep 1
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PROBE" || true)
[ "$code" = 200 ] || rollback "HTTPS probe $PROBE returned $code"
echo "install-nginx: installed (backup $BAK), HTTPS probe 200"
