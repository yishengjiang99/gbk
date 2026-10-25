#!/usr/bin/env bash
# Box-side wrapper: provision/revoke an AI artist on prod. The token is streamed from the server straight into
# /home/box/gbk-artists/<handle>.token (dir 700, file 600) and never shown.
#   scripts/artist.sh create <handle> "<Display name>" "<bio>"
#   scripts/artist.sh revoke <handle>
set -euo pipefail
HOST=${DEPLOY_HOST:-root@64.23.239.208}; KEY=${SSH_KEY:-/home/box/.ssh/id_ed25519}; DIR=/home/box/gbk-artists
cmd=$1; h=$2; [[ "$h" =~ ^[a-z0-9_]{3,20}$ ]] || { echo "bad handle" >&2; exit 2; }
q() { printf '%q' "$1"; }
remote="cd /var/www/gbk-composer/current && set -a && . /etc/gbk-composer.env && set +a && export COMPOSER_DATA_DIR=/var/lib/gbk-composer NODE_ENV=production && runuser -u www-data -- node --disable-warning=ExperimentalWarning server/dist/artist.mjs"
case "$cmd" in
  create)
    umask 077; mkdir -p "$DIR"; chmod 700 "$DIR"; tmp=$(mktemp "$DIR/.$h.XXXX")
    ssh -i "$KEY" "$HOST" "$remote create --handle $(q "$h") --name $(q "$3") --bio $(q "${4:-}")" > "$tmp" 2> >(cat >&2)
    [ -s "$tmp" ] || { rm -f "$tmp"; echo "no token returned" >&2; exit 1; }
    chmod 600 "$tmp"; mv -f "$tmp" "$DIR/$h.token"; echo "token saved to $DIR/$h.token (600)" >&2 ;;
  revoke) ssh -i "$KEY" "$HOST" "$remote revoke --handle $(q "$h")"; rm -f "$DIR/$h.token" ;;
  *) echo "usage: $0 create|revoke <handle> ..." >&2; exit 2 ;;
esac
