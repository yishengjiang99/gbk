#!/usr/bin/env bash
# Build locally and ship a release to the grepawk host (existing convention: nginx + systemd, no Docker there).
#   DEPLOY_HOST=root@64.23.239.208 deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${DEPLOY_HOST:-root@compose.grepawk.com}; ID=$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)
export GBK_RELEASE_ID=$ID
npm run build:compose
npm run build:server
tar czf /tmp/gbk-composer-$ID.tgz dist server/dist/index.mjs server/dist/render-worker.mjs server/dist/social-test-user.mjs server/dist/artist.mjs server/dist/rank-train.mjs server/dist/widget deploy package.json
scp /tmp/gbk-composer-$ID.tgz deploy/remote-install.sh "$HOST:/tmp/" && rm -f /tmp/gbk-composer-$ID.tgz
ssh "$HOST" "bash /tmp/remote-install.sh /tmp/gbk-composer-$ID.tgz $ID && bash /var/www/gbk-composer/current/deploy/install-brotli.sh && bash /var/www/gbk-composer/current/deploy/install-nginx.sh /var/www/gbk-composer/current/deploy/nginx.conf"
# SoundFonts: the small fonts ship inside dist/static; the large server-delivery
# fonts (soundfonts/catalog.json, delivery=server — FluidR3 GM) live outside the
# releases in /var/www/gbk-composer/soundfonts/ (nginx serves them at
# /soundfonts/). Fetch them pinned + sha256-verified and sync only on change.
node scripts/fetch-soundfonts.mjs --server
SERVER_FONTS=$(node -p "JSON.parse(require('fs').readFileSync('soundfonts/catalog.json','utf8')).fonts.filter(f=>f.delivery==='server').map(f=>f.file).join(' ')")
for f in $SERVER_FONTS; do
  LOCAL_SHA=$(node -p "require('crypto').createHash('sha256').update(require('fs').readFileSync('soundfonts/$f')).digest('hex')")
  REMOTE_SHA=$(ssh "$HOST" "sha256sum /var/www/gbk-composer/soundfonts/$f 2>/dev/null | cut -d' ' -f1" || true)
  if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
    scp "soundfonts/$f" "$HOST:/tmp/$f"
    ssh "$HOST" "mkdir -p /var/www/gbk-composer/soundfonts && install -m0644 -o www-data -g www-data /tmp/$f /var/www/gbk-composer/soundfonts/$f && rm /tmp/$f"
    echo "soundfonts: $f synced to $HOST"
  else
    echo "soundfonts: $f already current on $HOST"
  fi
done
