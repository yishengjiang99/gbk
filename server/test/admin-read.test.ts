// GET /api/admin/telemetry: read-only snapshot for the photo admin; token or admin session, GET only.
import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { COOKIE } from "../src/security/authentication.ts";
import { testConfig, ScriptModel, reply } from "./helpers.ts";

test("admin telemetry: token or admin session; no token = 401; token grants no writes", { timeout: 60_000 }, async () => {
  const cfg = testConfig({ COMPOSER_ADMIN_USERS: "alice", GBK_ADMIN_READ_TOKEN: "read-token-test-1234" });
  const b = await buildApp(cfg, { model: new ScriptModel([() => reply("x")]), persist: false, logger: false });
  b.app.addHook("preClose", (done) => { b.app.server.closeAllConnections?.(); done(); });
  await b.app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(b.app.server.address() as { port: number }).port}`;
  try {
    const get = (h: Record<string, string> = {}) => fetch(`${base}/api/admin/telemetry?days=30`, { headers: h });
    assert.equal((await get()).status, 401);
    assert.equal((await get({ "x-gbk-admin-read": "wrong-token-test-1234" })).status, 401);
    assert.equal((await get({ "x-gbk-admin-read": "short" })).status, 401);
    const bob = b.accounts.upsertOAuth("google", "g-bob", "Bob", "bob@example.com").account;
    assert.equal((await get({ cookie: `${COOKIE}=${b.sessions.cookieValue(b.sessions.create(bob.id))}` })).status, 403);
    const ok = await get({ "x-gbk-admin-read": "read-token-test-1234" });
    assert.equal(ok.status, 200);
    const j = await ok.json() as Record<string, unknown>;
    for (const k of ["metrics", "funnel", "billing", "billingLog", "clientErrors", "reports"]) assert.ok(k in j && !(j[k] as { error?: string }).error, k);
    // the token does not open the session-gated admin routes or writes
    assert.equal((await fetch(`${base}/api/admin/funnel`, { headers: { "x-gbk-admin-read": "read-token-test-1234" } })).status, 401);
    assert.equal((await fetch(`${base}/api/admin/reports/1`, { method: "POST", headers: { "x-gbk-admin-read": "read-token-test-1234", "content-type": "application/json" }, body: "{}" })).status, 401);
  } finally { await b.app.close(); }
});

test("admin telemetry: token auth off when GBK_ADMIN_READ_TOKEN is unset", { timeout: 60_000 }, async () => {
  const b = await buildApp(testConfig({ COMPOSER_ADMIN_USERS: "alice" }), { model: new ScriptModel([() => reply("x")]), persist: false, logger: false });
  try {
    assert.equal((await b.app.inject({ url: "/api/admin/telemetry", headers: { "x-gbk-admin-read": "" } })).statusCode, 401);
  } finally { await b.app.close(); }
});
