#!/usr/bin/env bash
# Build locally and ship a release to the grepawk host (existing convention: nginx + systemd, no Docker there).
#   DEPLOY_HOST=root@64.23.239.208 deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${DEPLOY_HOST:-root@compose.grepawk.com}; ID=$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)
GBK_BASE_PATH=/ npm run build
npm run build:server
tar czf /tmp/gbk-composer-$ID.tgz dist server/dist/index.mjs deploy package.json
scp /tmp/gbk-composer-$ID.tgz deploy/remote-install.sh "$HOST:/tmp/"
ssh "$HOST" "bash /tmp/remote-install.sh /tmp/gbk-composer-$ID.tgz $ID && install -m0644 /var/www/gbk-composer/current/deploy/nginx.conf /etc/nginx/sites-available/compose.grepawk.com.new && echo 'review + install nginx: see docs/compose-deploy.md'"
