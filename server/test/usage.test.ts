import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { UsageStore, PAYWALL_COOLDOWN_MS } from "../src/persistence/usage.ts";
import { buildApp } from "../src/app.ts";
import { COOKIE } from "../src/security/authentication.ts";
import { testConfig, ScriptModel, reply } from "./helpers.ts";
import { entitlementFetch } from "./stripe-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";

test("paywall eligibility: no landing/composition/export soft triggers; ai_budget, render_limit, 1 h dismiss cooldown, third_song memory, Pro never", () => {
  let now = 1_000_000; const u = new UsageStore(new DatabaseSync(":memory:"), () => now);
  const pw = (o: { pro?: boolean; aiLimit?: boolean; renderLimit?: boolean } = {}) => u.paywall("a", { pro: false, ...o });
  assert.deepEqual(pw(), { eligible: false, reason: null, cooldown_until: null, third_song_seen: false }, "fresh user: no landing paywall");
  u.bump("a", "compositions"); u.bump("a", "compositions"); u.bump("a", "compositions");
  assert.equal(pw().reason, null, "composition counts trigger nothing server-side (3rd-song is decided when a song starts)");
  now += 10; u.bump("a", "exports"); assert.equal(pw().reason, null, "exports are gated per action (POST /api/paywall/check), not here");
  assert.deepEqual(pw({ pro: true }), { eligible: false, reason: null, cooldown_until: null, third_song_seen: false }, "Pro never eligible");
  assert.deepEqual(pw({ aiLimit: true }), { eligible: true, reason: "ai_budget", cooldown_until: null, third_song_seen: false });
  assert.equal(pw({ renderLimit: true }).reason, "render_limit");
  u.dismiss("a"); const until = now + PAYWALL_COOLDOWN_MS;
  assert.deepEqual(pw({ aiLimit: true }), { eligible: false, reason: "ai_budget", cooldown_until: until, third_song_seen: false }, "cooldown after a dismiss");
  now = until + 1; assert.deepEqual(pw({ aiLimit: true }), { eligible: true, reason: "ai_budget", cooldown_until: null, third_song_seen: false }, "cooldown over");
  const t = now; u.markThirdSong("a"); now += 50; u.markThirdSong("a");
  assert.equal(pw().third_song_seen, true, "3rd-song popup remembered");
  assert.equal((u as unknown as { row(x: string): { third_song_at: number } }).row("a").third_song_at, t, "first mark wins (idempotent)");
  assert.deepEqual(u.usage("a"), { compositions: 3, ai_runs: 0, renders: 0, exports: 1, shares: 0, paywall_views: 0, last_paywall_at: null });
  u.bump("g", "compositions", 3); u.markThirdSong("g"); u.moveUser("g", "b");
  assert.equal(u.usage("b").compositions, 3); assert.equal(u.paywall("b", { pro: false }).third_song_seen, true, "guest -> account carries the 3rd-song memory");
  assert.equal(u.usage("g").compositions, 0);
});

test("usage store migrates an old user_usage table (adds third_song_at)", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE user_usage (user TEXT PRIMARY KEY, compositions INTEGER NOT NULL DEFAULT 0, ai_runs INTEGER NOT NULL DEFAULT 0, renders INTEGER NOT NULL DEFAULT 0, exports INTEGER NOT NULL DEFAULT 0, shares INTEGER NOT NULL DEFAULT 0, paywall_views INTEGER NOT NULL DEFAULT 0, last_paywall_at INTEGER, last_export_at INTEGER, dismissed_at INTEGER)");
  db.exec("INSERT INTO user_usage (user, compositions) VALUES ('old', 4)");
  const u = new UsageStore(db); new UsageStore(db); // idempotent
  assert.equal(u.usage("old").compositions, 4);
  assert.equal(u.paywall("old", { pro: false }).third_song_seen, false);
  u.markThirdSong("old"); assert.equal(u.paywall("old", { pro: false }).third_song_seen, true);
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
    assert.deepEqual(m.paywall, { eligible: false, reason: null, cooldown_until: null, third_song_seen: false }, "no landing paywall");
    const raw: string[] = [];
    for (const u of [free, pro]) {
      const c = new McpClient(base, { "x-gbk-test-user": u.id }); await c.initialize();
      for (const seed of [1, 2]) raw.push(JSON.stringify((await c.callRaw("gbk_create_composition", { title: "T", style: "pop", bars: 2, tempo: 120, seed })).rpc));
    }
    raw.forEach((t) => { assert.ok(!/paywall|eligib|ai_runs|paywall_views/i.test(t), "no engagement data in MCP output"); });
    m = await me(free); assert.equal(m.usage.compositions, 2); assert.deepEqual(m.paywall, { eligible: false, reason: null, cooldown_until: null, third_song_seen: false }, "no second_composition trigger anymore");
    const pm = await me(pro); assert.equal(pm.pro_source, "stripe"); assert.equal(pm.usage.compositions, 2); assert.equal(pm.paywall.eligible, false, "Stripe Pro is never eligible");
    const post = (u: typeof free, event: string) => fetch(`${base}/api/me/engagement`, { method: "POST", headers: { "content-type": "application/json", origin: "http://composer.test", cookie: `${u.cookie}; gbk_csrf=${u.csrf}`, "x-gbk-csrf": u.csrf }, body: JSON.stringify({ event }) });
    assert.equal((await post(free, "nope")).status, 422);
    const v = await (await post(free, "paywall_view")).json(); assert.equal(v.usage.paywall_views, 1); assert.equal(v.paywall.reason, null);
    const e = await (await post(free, "export")).json(); assert.equal(e.usage.exports, 1); assert.equal(e.paywall.reason, null, "no export_after_2 trigger anymore");
    const d = await (await post(free, "paywall_dismiss")).json(); assert.equal(d.paywall.eligible, false); assert.ok(d.paywall.cooldown_until > Date.now());
    assert.equal((await fetch(`${base}/api/me/engagement`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  } finally { await b.app.close(); }
});
