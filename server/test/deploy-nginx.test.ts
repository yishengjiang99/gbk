// Deploys must never drop the live TLS config (incident 2026-10-24: copying a TLS-less nginx.conf over the
// Certbot-managed site broke HTTPS). The repo config carries the TLS lines, and deploy.sh installs it only via
// install-nginx.sh, which refuses TLS-less configs and rolls back on nginx -t / HTTPS-probe failure.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const conf = readFileSync("deploy/nginx.conf", "utf8");
const deploy = readFileSync("deploy/deploy.sh", "utf8");

test("deploy/nginx.conf keeps HTTPS: 443 ssl, cert paths, port-80 redirect; no key material", () => {
  for (const s of ["listen 443 ssl;", "listen [::]:443 ssl;", "ssl_certificate /etc/letsencrypt/live/compose.grepawk.com/fullchain.pem;", "ssl_certificate_key /etc/letsencrypt/live/compose.grepawk.com/privkey.pem;", "return 301 https://$host$request_uri;"])
    assert.ok(conf.includes(s), s);
  assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(conf));
  assert.ok(conf.includes("chatgpt(/install|/gallery"), "install + gallery paths proxied");
  assert.ok(/\|pricing\(\/thanks\)\?\|plans\|/.test(conf) && conf.includes("privacy/payments-and-ads"), "pricing, plans and payments privacy proxied to the app");
});

test("install-nginx.sh refuses a config without TLS and leaves the live file untouched", () => {
  const d = mkdtempSync(join(tmpdir(), "gbk-nginx-"));
  try {
    const live = join(d, "live"), bad = join(d, "bad");
    writeFileSync(live, conf); writeFileSync(bad, "server { listen 80; }\n");
    const r = spawnSync("bash", ["deploy/install-nginx.sh", bad], { env: { ...process.env, NGINX_SITE: live }, encoding: "utf8" });
    assert.equal(r.status, 2); assert.match(r.stdout, /refusing/);
    assert.equal(readFileSync(live, "utf8"), conf);
    const same = spawnSync("bash", ["deploy/install-nginx.sh", live], { env: { ...process.env, NGINX_SITE: live }, encoding: "utf8" });
    assert.equal(same.status, 0); assert.match(same.stdout, /already current/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
