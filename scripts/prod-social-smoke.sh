#!/usr/bin/env bash
# Runs ON the server. Tokens live only in 0600 files under a private temp dir; output is status codes only.
set -uo pipefail
cd /var/www/gbk-composer/current
D=$(mktemp -d); chmod 755 $D; chown www-data $D
run() { systemd-run --quiet --pipe --wait --collect -p User=www-data -p Group=www-data -p EnvironmentFile=/etc/gbk-composer.env -p WorkingDirectory=/var/www/gbk-composer/current -E COMPOSER_DATA_DIR=/var/lib/gbk-composer -E NODE_ENV=production /usr/bin/node --disable-warning=ExperimentalWarning server/dist/social-test-user.mjs "$@" 2>&1 | grep -v "^$" ; }
U=$(run create --out $D/t | python3 -c "import sys,json;print(json.load(sys.stdin)['user'])"); echo "test user: $U"
run admin-session --out $D/a >/dev/null
printf 'Authorization: Bearer %s\n' "$(cat $D/t)" > $D/th; printf 'Authorization: Bearer %s\n' "$(cat $D/a)" > $D/ah; chmod 600 $D/*
B=https://compose.grepawk.com; J='content-type: application/json'
c() { curl -s -o $D/out -w "%{http_code}" "$@"; }
j() { python3 -c "import sys,json;d=json.load(open('$D/out'));print($1)"; }
echo "me: $(c -H @$D/th $B/api/me) handle=$(j "d['handle']")"
python3 -c "import json;print(json.dumps({'title':'zz smoke song','project':json.load(open('/tmp/social-song.json')),'public':True}))" > $D/song.json
echo "publish: $(c -X POST -H @$D/th -H "$J" --data @$D/song.json $B/api/shares)"; SL=$(j "d['slug']")
echo "meta: $(c -X PATCH -H @$D/th -H "$J" -d '{"labels":["wip"],"tags":["smoke-test"]}' $B/api/songs/$SL/meta)"
echo "self-rate (expect 403): $(c -X PUT -H @$D/th -H "$J" -d '{"stars":5}' $B/api/shares/$SL/rating)"
c "$B/api/feed?sort=new&limit=20" >/dev/null; OTHER=$(j "[i['slug'] for i in d['items'] if i['author']['handle']!='smoketest'][0]")
echo "rate other: $(c -X PUT -H @$D/th -H "$J" -d '{"stars":4}' $B/api/shares/$OTHER/rating) my_rating=$(j "d['my_rating']")"
echo "unrate: $(c -X DELETE -H @$D/th $B/api/shares/$OTHER/rating)"
echo "comment: $(c -X POST -H @$D/th -H "$J" -d '{"body":"<b>smoke</b> test comment"}' $B/api/shares/$SL/comments)"; CID=$(j "d['id']")
echo "comment listed escaped-as-text: $(c $B/api/shares/$SL/comments) body=$(j "d['items'][0]['body']=='<b>smoke</b> test comment'")"
echo "report: $(c -X POST -H @$D/th -H "$J" -d "{\"kind\":\"comment\",\"target\":\"$CID\",\"reason\":\"smoke test\"}" $B/api/reports)"; RID=$(j "d['id']")
echo "admin queue as test user (expect 403): $(c -H @$D/th $B/api/admin/reports)"
echo "admin queue: $(c -H @$D/ah $B/api/admin/reports) has_report=$(j "any(i['id']=='$RID' for i in d['items'])")"
echo "admin dismiss: $(c -X POST -H @$D/ah -H "$J" -d '{"action":"dismiss"}' $B/api/admin/reports/$RID)"
echo "web-code: $(c -X POST -H @$D/th $B/api/auth/web-code)"; WC=$(j "d['code']")
echo "redeem: $(curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}" -c $D/jar "$B/api/auth/web-code/redeem?code=$WC&return=/studio")"
echo "cookie session me: $(c -b $D/jar $B/api/me)"
echo "redeem again (expect expired): $(curl -s -o /dev/null -w "%{redirect_url}" "$B/api/auth/web-code/redeem?code=$WC")"
echo "push register: $(c -X POST -H @$D/th -H "$J" -d '{"installId":"123e4567-e89b-12d3-a456-426614174999","token":"'$(printf 'ab%.0s' {1..32})'","environment":"sandbox"}' $B/api/push/register)"
echo "push unregister: $(c -X POST -H @$D/th -H "$J" -d '{"installId":"123e4567-e89b-12d3-a456-426614174999"}' $B/api/push/unregister) removed=$(j "d['removed']")"
echo "DELETE /api/me: $(c -X DELETE -H @$D/th $B/api/me)"
echo "song after delete (expect 404): $(c $B/api/songs/$SL)"
echo "token after delete (expect 401): $(c -H @$D/th $B/api/me)"
run delete "$U" | python3 -c "import sys,json;r=json.load(sys.stdin)['remaining'];print('remaining rows:',r,'ALL ZERO' if not any(r.values()) else 'NOT CLEAN')"
run revoke --in $D/a >/dev/null; echo "admin session revoked"
rm -rf $D /tmp/smoke.sh /tmp/social-song.json
