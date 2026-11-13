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

test("both nginx configs route /api/jam/ws as a WebSocket without upstream failover", () => {
  for (const f of ["deploy/nginx.conf", "deploy/nginx.docker.conf"]) {
    const c = readFileSync(f, "utf8"); const m = c.match(/location = \/api\/jam\/ws \{([^}]*)\}/);
    assert.ok(m, `${f}: jam ws location`);
    assert.match(m![1], /proxy_set_header Upgrade \$http_upgrade;/); assert.match(m![1], /proxy_read_timeout/);
    assert.ok(!m![1].includes("proxy_next_upstream"), `${f}: no failover`);
    assert.ok(c.includes("location = /api/agent/ws {"), `${f}: agent ws kept`);
  }
});

// #217/#220: Scan's ONNX Runtime needs cross-origin isolation for SharedArrayBuffer threads. The app shell sends
// COOP same-origin + COEP credentialless; the worker scripts (/assets/, /ort-runtime/) need COEP too, or ORT's
// thread pool hangs instead of falling back. nginx drops server-level add_header in any location that sets its
// own, so each location is checked on its own.
function locationBody(c: string, header: string): string {
  const start = c.indexOf(`location ${header} {`);
  assert.ok(start >= 0, `location ${header}`);
  let depth = 0;
  for (let i = c.indexOf("{", start); i < c.length; i++) {
    if (c[i] === "{") depth++;
    else if (c[i] === "}" && --depth === 0) return c.slice(c.indexOf("{", start) + 1, i);
  }
  throw new Error(`unbalanced location ${header}`);
}
const COOP = 'add_header Cross-Origin-Opener-Policy "same-origin" always;';
const COEP = 'add_header Cross-Origin-Embedder-Policy "credentialless" always;';

test("nginx: app shell is cross-origin isolated; worker scripts carry COEP", () => {
  const shells: Record<string, string[]> = {
    "deploy/nginx.conf": ["/", "@spa", "~ ^/((s|u)/[^/]+|og/s/[A-Za-z0-9-]+\\.(png|mp4))$"],
    "deploy/nginx.docker.conf": ["/"],
  };
  for (const [f, locations] of Object.entries(shells)) {
    const c = readFileSync(f, "utf8");
    for (const loc of locations) {
      const body = locationBody(c, loc);
      assert.ok(body.includes(COOP), `${f} ${loc}: COOP same-origin`);
      assert.ok(body.includes(COEP), `${f} ${loc}: COEP credentialless`);
    }
    for (const loc of ["^~ /assets/", "^~ /ort-runtime/"]) assert.ok(locationBody(c, loc).includes(COEP), `${f} ${loc}: COEP credentialless`);
    // Never require-corp: it would block the no-cors images/audio (and Turnstile's script) that credentialless allows.
    assert.ok(!c.includes("require-corp"), `${f}: no require-corp`);
  }
});

test("vite dev/preview and serve-dist send the same isolation headers", () => {
  const vite = readFileSync("vite.config.ts", "utf8");
  assert.match(vite, /isolationHeaders = \{ "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" \}/);
  assert.match(vite, /server: \{ headers: isolationHeaders/);
  assert.match(vite, /preview: \{ headers: isolationHeaders/);
  const serve = readFileSync("scripts/serve-dist.mjs", "utf8");
  assert.ok(serve.includes('"Cross-Origin-Opener-Policy": "same-origin"') && serve.includes('"Cross-Origin-Embedder-Policy": "credentialless"'));
});
