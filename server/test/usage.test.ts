import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { UsageStore, PAYWALL_COOLDOWN_MS } from "../src/persistence/usage.ts";
import { buildApp } from "../src/app.ts";
import { COOKIE } from "../src/security/authentication.ts";
import { testConfig, ScriptModel, reply } from "./helpers.ts";
import { entitlementFetch } from "./stripe-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";

test("paywall eligibility: landing fallback, second_composition, export_after_2, ai_limit, render_limit, 24 h dismiss cooldown, Pro never", () => {
  let now = 1_000_000; const u = new UsageStore(new DatabaseSync(":memory:"), () => now);
  const pw = (o: { pro?: boolean; aiLimit?: boolean; renderLimit?: boolean } = {}) => u.paywall("a", { pro: false, ...o });
  assert.deepEqual(pw(), { eligible: true, reason: "landing", cooldown_until: null }, "fresh user: paywall right after landing");
  u.bump("a", "compositions"); assert.equal(pw().reason, "landing", "one composition: still the landing fallback");
  u.bump("a", "compositions"); assert.deepEqual(pw(), { eligible: true, reason: "second_composition", cooldown_until: null }, "stronger trigger wins over landing");
  assert.deepEqual(pw({ pro: true }), { eligible: false, reason: null, cooldown_until: null }, "Pro never eligible");
  now += 10; u.bump("a", "paywall_views"); assert.equal(pw().reason, "landing", "after a view the resting state is landing again");
  now += 10; u.bump("a", "exports"); assert.deepEqual(pw(), { eligible: true, reason: "export_after_2", cooldown_until: null });
  now += 10; u.bump("a", "paywall_views"); assert.equal(pw().reason, "landing", "export trigger spent; landing remains");
  assert.equal(pw({ aiLimit: true }).reason, "ai_limit"); assert.equal(pw({ renderLimit: true }).reason, "render_limit");
  u.dismiss("a"); const until = now + PAYWALL_COOLDOWN_MS;
  assert.deepEqual(pw(), { eligible: false, reason: "landing", cooldown_until: until }, "dismiss cooldown silences landing too");
  assert.deepEqual(pw({ aiLimit: true }), { eligible: false, reason: "ai_limit", cooldown_until: until }, "cooldown after a dismiss");
  now = until + 1; assert.deepEqual(pw({ aiLimit: true }), { eligible: true, reason: "ai_limit", cooldown_until: null }, "cooldown over");
  assert.deepEqual(u.usage("a"), { compositions: 2, ai_runs: 0, renders: 0, exports: 1, shares: 0, paywall_views: 2, last_paywall_at: 1_000_030 });
  u.bump("g", "compositions", 3); u.moveUser("g", "a"); assert.equal(u.usage("a").compositions, 5); assert.equal(u.usage("g").compositions, 0);
});

test("/api/me usage + paywall; engagement endpoint; MCP creates counted but never surfaced in MCP output; Stripe Pro not eligible", { timeout: 60_000 }, async () => {
  const state = { pro: new Set(["pro@example.com"]), down: false, calls: [] as string[] };
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test", MCP_TEST_AUTH: "1", COMPOSE_ENTITLEMENT_ORIGIN: "https://billing.test", COMPOSE_ENTITLEMENT_TOKEN: "test-entitlement-token" });
  const b = await buildApp(cfg, { model: new ScriptModel([() => reply("x")]), persist: false, logger: false, fetch: entitlementFetch(state) });
  b.app.addHook("preClose", (done) => { b.app.server.closeAllConnections?.(); done(); });
  await b.app.listen({ port: 0, host: "127.0.0.1" }); const base = `http://127.0.0.1:${(b.app.server.address() as { port: number }).port}`;
  try {
    const mk = (id: string, email: string) => { const a = b.accounts.upsertOAuth("google", id, id, email).account; const s = b.sessions.create(a.id); return { id: a.id, cookie: `${COOKIE}=${b.sessions.cookieValue(s)}`, csrf: s.csrf }; };
    const free = mk("g-free", "free@example.com"); const pro = mk("g-pro", "pro@example.com");
    const me = async (u: typeof free) => (await fetch(`${base}/api/me`, { headers: { cookie: u.cookie } })).json();
    let m = await me(free);
    assert.deepEqual(m.usage, { compositions: 0, ai_runs: 0, renders: 0, exports: 0, shares: 0, paywall_views: 0, last_paywall_at: null });
    assert.deepEqual(m.paywall, { eligible: true, reason: "landing", cooldown_until: null });
    const raw: string[] = [];
    for (const u of [free, pro]) {
      const c = new McpClient(base, { "x-gbk-test-user": u.id }); await c.initialize();
      for (const seed of [1, 2]) raw.push(JSON.stringify((await c.callRaw("gbk_create_composition", { title: "T", style: "pop", bars: 2, tempo: 120, seed })).rpc));
    }
    raw.forEach((t) => { assert.ok(!/paywall|eligib|ai_runs|paywall_views/i.test(t), "no engagement data in MCP output"); });
    m = await me(free); assert.equal(m.usage.compositions, 2); assert.deepEqual(m.paywall, { eligible: true, reason: "second_composition", cooldown_until: null });
    const pm = await me(pro); assert.equal(pm.pro_source, "stripe"); assert.equal(pm.usage.compositions, 2); assert.equal(pm.paywall.eligible, false, "Stripe Pro is never eligible");
    const post = (u: typeof free, event: string) => fetch(`${base}/api/me/engagement`, { method: "POST", headers: { "content-type": "application/json", origin: "http://composer.test", cookie: `${u.cookie}; gbk_csrf=${u.csrf}`, "x-gbk-csrf": u.csrf }, body: JSON.stringify({ event }) });
    assert.equal((await post(free, "nope")).status, 422);
    const v = await (await post(free, "paywall_view")).json(); assert.equal(v.usage.paywall_views, 1); assert.equal(v.paywall.eligible, true); assert.equal(v.paywall.reason, "landing", "a view alone does not silence the landing fallback; only a dismiss cooldown does");
    const e = await (await post(free, "export")).json(); assert.equal(e.paywall.reason, "export_after_2");
    const d = await (await post(free, "paywall_dismiss")).json(); assert.equal(d.paywall.eligible, false); assert.ok(d.paywall.cooldown_until > Date.now());
    assert.equal((await fetch(`${base}/api/me/engagement`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  } finally { await b.app.close(); }
});
