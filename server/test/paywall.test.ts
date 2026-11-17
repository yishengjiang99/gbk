// Paywall plan (2026-11-16): no landing paywall; export is Pro only (402 contract); hard gates at the free AI budget
// and render limit; one-time 3rd-song popup remembered per account; every paywall show logged with its reason.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildApp } from "../src/app.ts";
import { COOKIE } from "../src/security/authentication.ts";
import { FunnelStore } from "../src/persistence/funnel.ts";
import { BillingRecorder } from "../src/persistence/billing.ts";
import { paywallBody, PAYWALL_CODES } from "../src/routes/paywall.ts";
import { testConfig, ScriptModel, reply } from "./helpers.ts";
import { entitlementFetch } from "./stripe-helpers.ts";

async function start() {
  const state = { pro: new Set(["pro@example.com"]), down: false, calls: [] as string[] };
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test", MCP_TEST_AUTH: "1", COMPOSE_ENTITLEMENT_ORIGIN: "https://billing.test", COMPOSE_ENTITLEMENT_TOKEN: "test-entitlement-token" });
  const b = await buildApp(cfg, { model: new ScriptModel([() => reply("x")]), persist: false, logger: false, fetch: entitlementFetch(state) });
  b.app.addHook("preClose", (done) => { b.app.server.closeAllConnections?.(); done(); });
  await b.app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(b.app.server.address() as { port: number }).port}`;
  const mk = (id: string, email: string) => { const a = b.accounts.upsertOAuth("google", id, id, email).account; const s = b.sessions.create(a.id); return { id: a.id, cookie: `${COOKIE}=${b.sessions.cookieValue(s)}`, csrf: s.csrf }; };
  return { b, base, mk };
}
type U = { id: string; cookie: string; csrf: string };
const check = (base: string, body: unknown, u?: U) => fetch(`${base}/api/paywall/check`, { method: "POST", headers: { "content-type": "application/json", ...(u ? { cookie: u.cookie } : {}) }, body: JSON.stringify(body) });

test("402 contract: body shape, codes and reasons are stable", () => {
  assert.deepEqual(PAYWALL_CODES, { export: "PRO_REQUIRED", ai_budget: "AI_BUDGET_EXHAUSTED", render_limit: "RENDER_LIMIT_REACHED" });
  const body = paywallBody("https://compose.grepawk.com", "export", false);
  assert.deepEqual(Object.keys(body).sort(), ["code", "message", "paywall", "reason", "signed_in"]);
  assert.equal(body.code, "PRO_REQUIRED"); assert.equal(body.reason, "export"); assert.equal(body.signed_in, false);
  assert.deepEqual(body.paywall, { reason: "export", hard: true, default_plan: "pro_yearly", trial_days: 7, pricing_url: "https://compose.grepawk.com/pricing?plan=pro_yearly&reason=export" });
  assert.match(body.message, /Pro/);
});

test("POST /api/paywall/check: export is Pro only (402 for signed-out and free, 200 for Stripe Pro); ai/render gates", { timeout: 60_000 }, async () => {
  const { b, base, mk } = await start();
  try {
    const free = mk("g-free", "free@example.com"); const pro = mk("g-pro", "pro@example.com");
    let r = await check(base, { action: "export", kind: "midi" });
    assert.equal(r.status, 402); assert.equal(r.headers.get("cache-control"), "no-store");
    let j = await r.json(); assert.equal(j.code, "PRO_REQUIRED"); assert.equal(j.reason, "export"); assert.equal(j.signed_in, false);
    assert.equal(j.paywall.pricing_url, "http://composer.test/pricing?plan=pro_yearly&reason=export");
    r = await check(base, { action: "export", kind: "wav" }, free); assert.equal(r.status, 402); j = await r.json();
    assert.equal(j.code, "PRO_REQUIRED"); assert.equal(j.signed_in, true); assert.equal(j.paywall.hard, true); assert.equal(j.paywall.default_plan, "pro_yearly"); assert.equal(j.paywall.trial_days, 7);
    r = await check(base, { action: "export", kind: "wav" }, pro); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, pro: true });
    r = await check(base, { action: "export" }, pro); assert.equal(r.status, 200, "kind is optional");
    assert.equal((await check(base, { action: "export", kind: "mp4" }, free)).status, 422);
    assert.equal((await check(base, { action: "nope" }, free)).status, 422);
    assert.equal((await check(base, { action: "ai" })).status, 401, "AI needs an account");
    assert.equal((await check(base, { action: "render" })).status, 401);
    r = await check(base, { action: "ai" }, free); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, pro: false });
    r = await check(base, { action: "render" }, free); assert.equal(r.status, 200);
    // Exhaust the free AI budget: the same 402 shape with code AI_BUDGET_EXHAUSTED / reason ai_budget.
    b.ledger.record(free.id, { promptTokens: 50_000_000, completionTokens: 0 });
    r = await check(base, { action: "ai" }, free); assert.equal(r.status, 402); j = await r.json();
    assert.equal(j.code, "AI_BUDGET_EXHAUSTED"); assert.equal(j.reason, "ai_budget"); assert.equal(j.paywall.reason, "ai_budget");
    b.ledger.record(pro.id, { promptTokens: 50_000_000, completionTokens: 0 });
    assert.equal((await check(base, { action: "ai" }, pro)).status, 200, "Pro: 10x budget, and never a paywall body");
    const me = await (await fetch(`${base}/api/me`, { headers: { cookie: free.cookie } })).json();
    assert.equal(me.paywall.reason, "ai_budget"); assert.equal(me.paywall.eligible, true);
  } finally { await b.app.close(); }
});

test("GET /api/mcp/artifacts/:id?download=1 answers the 402 for a non-Pro owner; inline playback stays free; Pro downloads as an attachment", { timeout: 60_000 }, async () => {
  const { b, base, mk } = await start();
  try {
    const free = mk("g-free2", "free2@example.com"); const pro = mk("g-pro2", "pro@example.com");
    // Pro is resolved through the Stripe entitlement cache, warmed the way /api/me does.
    await fetch(`${base}/api/me`, { headers: { cookie: pro.cookie } });
    const add = (owner: string) => {
      const bytes = Buffer.from("MThd\u0000\u0000\u0000\u0006\u0000\u0000\u0000\u0001\u0001\u00e0");
      const row = b.mcp.store.addArtifact({ job_id: null, composition_id: "cmp_test", owner, revision: 1, kind: "midi", filename: "song.mid", mime_type: "audio/midi", size_bytes: bytes.length, sha256: "x", rel_path: `${owner}/song-${Math.random().toString(36).slice(2)}.mid`, meta_json: "{}" });
      const path = b.mcp.store.artifactAbsPath(row); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
      return row.id;
    };
    const fa = add(free.id); const pa = add(pro.id);
    const get = (id: string, user: string, q = "") => fetch(`${base}/api/mcp/artifacts/${id}${q}`, { headers: { "x-gbk-test-user": user } });
    let r = await get(fa, free.id); assert.equal(r.status, 200, "inline fetch (playback) is free"); assert.match(r.headers.get("content-disposition") ?? "", /^inline/);
    r = await get(fa, free.id, "?download=1"); assert.equal(r.status, 402);
    const j = await r.json(); assert.equal(j.code, "PRO_REQUIRED"); assert.equal(j.reason, "export"); assert.equal(j.paywall.reason, "export");
    r = await get(pa, pro.id, "?download=1"); assert.equal(r.status, 200); assert.match(r.headers.get("content-disposition") ?? "", /^attachment; filename="song.mid"/);
    await r.arrayBuffer();
  } finally { await b.app.close(); }
});

test("no landing paywall; third_song shown once per account (view or dismiss), its dismiss starts no cooldown; reasons logged", { timeout: 60_000 }, async () => {
  const { b, base, mk } = await start();
  try {
    const free = mk("g-free3", "free3@example.com");
    const me = async () => (await fetch(`${base}/api/me`, { headers: { cookie: free.cookie } })).json();
    let m = await me();
    assert.deepEqual(m.paywall, { eligible: false, reason: null, cooldown_until: null, third_song_seen: false }, "fresh free user: no landing paywall");
    const post = (event: string, reason?: string) => fetch(`${base}/api/me/engagement`, { method: "POST", headers: { "content-type": "application/json", origin: "http://composer.test", cookie: `${free.cookie}; gbk_csrf=${free.csrf}`, "x-gbk-csrf": free.csrf }, body: JSON.stringify({ event, surface: "studio", platform: "web", ...(reason ? { reason } : {}) }) });
    let e = await (await post("paywall_view", "export")).json(); assert.equal(e.paywall.third_song_seen, false, "an export view is not the 3rd-song popup");
    e = await (await post("paywall_dismiss", "third_song")).json();
    assert.equal(e.paywall.third_song_seen, true); assert.equal(e.paywall.cooldown_until, null, "3rd-song dismiss: no cooldown");
    m = await me(); assert.equal(m.paywall.third_song_seen, true, "remembered server-side per account");
    const d = await (await post("paywall_dismiss", "export")).json(); assert.ok(d.paywall.cooldown_until > Date.now(), "a hard dismiss still starts the cooldown");
    // Signed-out paywall shows are logged too (anonymous billing door), reason included.
    const anon = await fetch(`${base}/api/billing/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "paywall_view", surface: "studio", platform: "web", reason: "export" }) });
    assert.deepEqual(await anon.json(), { ok: true, accepted: 1 });
    // Test traffic (X-GBK-Test, #237/#238) stays out of the aggregates.
    await fetch(`${base}/api/billing/events`, { method: "POST", headers: { "content-type": "application/json", "x-gbk-test": "1" }, body: JSON.stringify({ event: "paywall_view", reason: "third_song" }) });
  } finally { await b.app.close(); }
});

test("BillingRecorder aggregates paywall events by reason (export, ai_budget, render_limit, third_song); unknown reasons dropped", () => {
  const f = new FunnelStore(":memory:"); const rec = new BillingRecorder(f, null);
  for (const reason of ["export", "export", "ai_budget", "render_limit", "third_song", "bogus"]) rec.record("paywall_view", { surface: "studio", platform: "web", reason });
  rec.record("paywall_dismiss", { reason: "third_song" }); rec.record("plan_select", { reason: "export", plan: "pro_yearly" });
  rec.record("checkout_start", { reason: "export" }); // not a paywall event: no reason row
  const by = f.billingSummary(1).byReason;
  assert.deepEqual(by, {
    export: { paywall_view: 2, paywall_dismiss: 0, plan_select: 1 }, ai_budget: { paywall_view: 1, paywall_dismiss: 0, plan_select: 0 },
    render_limit: { paywall_view: 1, paywall_dismiss: 0, plan_select: 0 }, third_song: { paywall_view: 1, paywall_dismiss: 1, plan_select: 0 },
  });
  assert.equal(f.billingSummary(1).totals.paywall_view, 6, "the plain aggregate still counts every view");
});
