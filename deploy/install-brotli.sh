#!/usr/bin/env bash
# Runs ON the host (idempotent): build ngx_brotli's *static* module (serves precompressed .br; no on-the-fly
# compression, so no libbrotli link) against the installed nginx version and enable it.
#   bash install-brotli.sh
set -euo pipefail
V=$(nginx -v 2>&1 | sed -E 's|.*nginx/([0-9.]+).*|\1|'); MOD=/usr/lib/nginx/modules/ngx_http_brotli_static_module.so
CONF=/etc/nginx/modules-enabled/60-mod-http-brotli-static.conf; STAMP=/usr/lib/nginx/modules/.brotli-static-$V
if [ ! -f "$STAMP" ] || [ ! -f "$MOD" ]; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q build-essential libpcre3-dev zlib1g-dev libssl-dev git >/dev/null
  W=/usr/local/src/ngxbr; mkdir -p $W && cd $W
  [ -d nginx-$V ] || { curl -fsSLO https://nginx.org/download/nginx-$V.tar.gz && tar xzf nginx-$V.tar.gz; }
  [ -d ngx_brotli ] || git clone -q https://github.com/google/ngx_brotli
  cd nginx-$V && ./configure --with-compat --add-dynamic-module=../ngx_brotli/static >/dev/null && make -j"$(nproc)" modules >/dev/null
  install -m0644 objs/ngx_http_brotli_static_module.so "$MOD"; rm -f /usr/lib/nginx/modules/.brotli-static-*; touch "$STAMP"
fi
echo "load_module modules/ngx_http_brotli_static_module.so;" > "$CONF"
nginx -t >/dev/null 2>&1 || { rm -f "$CONF"; echo "install-brotli: nginx -t failed; module disabled" >&2; exit 1; }
echo "install-brotli: ngx_http_brotli_static_module enabled for nginx $V"
