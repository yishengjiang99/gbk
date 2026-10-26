// Billing funnel telemetry (#118): taxonomy + aggregates (no identities), per-account support log,
// client intake (funnel steps only), the finalcut stripe-events hop, the admin report, ASSN sources.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate, createPrivateKey, sign } from "node:crypto";
import { FunnelStore } from "../src/persistence/funnel.ts";
import { BillingLog, BillingRecorder } from "../src/persistence/billing.ts";
import { buildApp } from "../src/app.ts";
import { COOKIE } from "../src/security/authentication.ts";
import { testConfig, ScriptModel, reply } from "./helpers.ts";
import { login } from "./ws-helpers.ts";

test("recorder: aggregates split by surface/platform, log only with an account, dims sanitized, open-trial tracking", () => {
  const now = Date.UTC(2026, 9, 26, 12, 0, 0);
  const funnel = new FunnelStore(":memory:");
  const log = new BillingLog(new DatabaseSync(":memory:"), () => now);
  const rec = new BillingRecorder(funnel, log, () => now);
  rec.record("paywall_view", { account: "u1", surface: "studio", platform: "web", reason: "second_composition" });
  rec.record("paywall_view", { surface: "pricing", platform: "web" }); // anonymous: aggregate only
  rec.record("checkout_start", { account: "u1", surface: "studio", platform: "web", plan: "pro_yearly", provider: "stripe" });
  rec.record("purchase", { account: "u1", surface: "studio", platform: "web", plan: "pro_yearly", provider: "stripe", valueCents: 4799 });
  rec.record("purchase", { account: "u2", surface: "evil", platform: "mars", plan: "gold", provider: "cash" }); // all dims dropped
  rec.record("nope" as never, { account: "u1" });
  const sum = funnel.billingSummary(7, now);
  assert.equal(sum.totals.paywall_view, 2); assert.equal(sum.totals.checkout_start, 1); assert.equal(sum.totals.purchase, 2);
  assert.deepEqual(sum.steps.overall, { scope: "all", paywall_view: 2, checkout_start: 1, purchase: 2, view_to_checkout: 0.5, checkout_to_purchase: 2, view_to_purchase: 1 });
  const surf = Object.fromEntries(sum.steps.bySurface.map((r) => [(r as { surface: string }).surface, r])) as Record<string, { paywall_view: number; purchase: number }>;
  assert.equal(surf.studio.paywall_view, 1); assert.equal(surf.studio.purchase, 1); assert.equal(surf.pricing.paywall_view, 1); assert.equal(surf.pricing.purchase, 0);
  const plat = sum.steps.byPlatform as { platform: string; paywall_view: number }[];
  assert.deepEqual(plat.map((p) => [p.platform, p.paywall_view]), [["web", 2]]);
  const u1 = log.forAccount("u1");
  assert.deepEqual(u1.map((r) => r.event), ["purchase", "checkout_start", "paywall_view"]);
  assert.equal(u1[0].value_cents, 4799); assert.equal(u1[0].plan, "pro_yearly"); assert.equal(u1[0].provider, "stripe");
  assert.match(u1[2].detail, /reason=second_composition/);
  const u2 = log.forAccount("u2");
  assert.equal(u2.length, 1); assert.equal(u2[0].surface, ""); assert.equal(u2[0].plan, ""); assert.equal(u2[0].provider, "");
  assert.equal(log.forAccount("nobody").length, 0);
  assert.equal(rec.hasOpenTrial("u3"), false);
  rec.record("trial_start", { account: "u3", provider: "apple", plan: "pro_monthly" });
  assert.equal(rec.hasOpenTrial("u3"), true);
  rec.record("trial_convert", { account: "u3", provider: "apple", plan: "pro_monthly" });
  assert.equal(rec.hasOpenTrial("u3"), false);
  funnel.close();
});

async function serve(over: Record<string, string> = {}) {
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test", COMPOSER_ADMIN_USERS: "alice", ...over });
  const b = await buildApp(cfg, { model: new ScriptModel([() => reply("x")]), persist: false, logger: false });
  b.app.addHook("preClose", (done) => { b.app.server.closeAllConnections?.(); done(); });
  await b.app.listen({ port: 0, host: "127.0.0.1" });
  return { b, base: `http://127.0.0.1:${(b.app.server.address() as { port: number }).port}` };
}

test("intake + stripe hop + admin report/log, with gating", { timeout: 60_000 }, async () => {
  const { b, base } = await serve({ COMPOSE_BILLING_WEBHOOK_TOKEN: "whsec-test-token" });
  const J = { "content-type": "application/json" };
  const post = (path: string, body: unknown, h: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { ...J, ...h }, body: JSON.stringify(body) });
  try {
    const alice = await login(base, "code-a");
    const bobAcc = b.accounts.upsertOAuth("google", "g-bob", "Bob", "bob@example.com").account; // fires the signup hook
    const bs = b.sessions.create(bobAcc.id);
    const bob = { id: bobAcc.id, cookie: `${COOKIE}=${b.sessions.cookieValue(bs)}` };
    // client intake: anonymous paywall_view is aggregate-only; money events are refused from clients
    assert.deepEqual(await (await post("/api/billing/events", { event: "paywall_view", surface: "pricing", platform: "web" })).json(), { ok: true, accepted: 1 });
    assert.deepEqual(await (await post("/api/billing/events", { event: "purchase", plan: "pro_yearly" })).json(), { ok: true, accepted: 0 });
    // signed-in plan_select lands in bob's support log; a batch with one bad event keeps the good one
    const batch = await post("/api/billing/events", { events: [{ event: "plan_select", plan: "pro_yearly", surface: "studio", platform: "web" }, { event: "refund" }] }, { cookie: bob.cookie });
    assert.deepEqual(await batch.json(), { ok: true, accepted: 1 });
    // stripe hop: token gate, then a purchase for bob
    assert.equal((await post("/api/billing/stripe-events", { event: "purchase", account: bob.id })).status, 401);
    assert.equal((await post("/api/billing/stripe-events", { event: "purchase", account: bob.id }, { "x-gbk-billing-token": "wrong" })).status, 401);
    const hop = await post("/api/billing/stripe-events", { event: "purchase", account: bob.id, plan: "pro_yearly", value_cents: 4799, detail: "evt_123" }, { "x-gbk-billing-token": "whsec-test-token" });
    assert.deepEqual(await hop.json(), { ok: true, accepted: 1 });
    // admin gating
    assert.equal((await fetch(`${base}/api/admin/billing`)).status, 401);
    assert.equal((await fetch(`${base}/api/admin/billing`, { headers: { cookie: bob.cookie } })).status, 403);
    const rep = await (await fetch(`${base}/api/admin/billing?days=7`, { headers: { cookie: alice.cookie } })).json();
    assert.equal(rep.totals.paywall_view, 1); assert.equal(rep.totals.plan_select, 1); assert.equal(rep.totals.purchase, 1); assert.equal(rep.totals.signup, 1);
    assert.equal(rep.steps.overall.paywall_view, 1); assert.equal(rep.steps.overall.purchase, 1);
    const surf = Object.fromEntries(rep.steps.bySurface.map((r: { surface: string }) => [r.surface, r])) as Record<string, { paywall_view: number; purchase: number }>;
    assert.equal(surf.pricing.paywall_view, 1); assert.equal(surf.pricing.purchase, 1, "stripe hop defaults to surface pricing");
    // support log: bob has signup, plan_select, purchase (stripe) — newest first
    assert.equal((await fetch(`${base}/api/admin/billing-log`, { headers: { cookie: alice.cookie } })).status, 400);
    const log = await (await fetch(`${base}/api/admin/billing-log?account=${bob.id}`, { headers: { cookie: alice.cookie } })).json();
    assert.deepEqual(log.events.map((e: { event: string }) => e.event), ["purchase", "plan_select", "signup"]);
    assert.equal(log.events[0].provider, "stripe"); assert.equal(log.events[0].value_cents, 4799); assert.match(log.events[0].detail, /evt_123/);
    assert.match(log.events[2].detail, /provider=google/);
  } finally { await b.app.close(); }
});

test("stripe hop answers 404 until the token is configured", { timeout: 60_000 }, async () => {
  const { b, base } = await serve();
  try {
    const r = await fetch(`${base}/api/billing/stripe-events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "purchase", account: "x" }) });
    assert.equal(r.status, 404);
  } finally { await b.app.close(); }
});

// Test PKI shaped like Apple's (same construction as iap.test.ts): root -> intermediate -> leaf with the
// App Store OID, so the real JWS verifier accepts the payloads below.
function pki(dir: string) {
  const o = (...a: string[]) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "ca.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
  writeFileSync(join(dir, "leaf.ext"), "basicConstraints=critical,CA:FALSE\n1.2.840.113635.100.6.11.1=ASN1:NULL\n");
  for (const k of ["root", "int", "leaf"]) o("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${k}.key`);
  o("req", "-x509", "-new", "-key", "root.key", "-subj", "/CN=Test Root", "-days", "30", "-out", "root.pem", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  o("req", "-new", "-key", "int.key", "-subj", "/CN=Test WWDR", "-out", "int.csr"); o("x509", "-req", "-in", "int.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-days", "30", "-extfile", "ca.ext", "-out", "int.pem");
  o("req", "-new", "-key", "leaf.key", "-subj", "/CN=Test StoreKit", "-out", "leaf.csr"); o("x509", "-req", "-in", "leaf.csr", "-CA", "int.pem", "-CAkey", "int.key", "-CAcreateserial", "-days", "30", "-extfile", "leaf.ext", "-out", "leaf.pem");
  const der = (f: string) => new X509Certificate(readFileSync(join(dir, f))).raw.toString("base64");
  return { root: new X509Certificate(readFileSync(join(dir, "root.pem"))), x5c: [der("leaf.pem"), der("int.pem"), der("root.pem")], key: createPrivateKey(readFileSync(join(dir, "leaf.key"))) };
}
const jws = (p: ReturnType<typeof pki>, payload: object) => { const h = Buffer.from(JSON.stringify({ alg: "ES256", x5c: p.x5c })).toString("base64url"); const b = Buffer.from(JSON.stringify(payload)).toString("base64url"); return `${h}.${b}.${sign("sha256", Buffer.from(`${h}.${b}`), { key: p.key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`; };

test("ASSN + verify sources: purchase, restore on repost, trial_start -> trial_convert -> renewal, cancel, refund", { timeout: 60_000 }, async () => {
  const p = pki(mkdtempSync(join(tmpdir(), "iap-billing-")));
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test", IAP_ALLOW_SANDBOX: "0", COMPOSER_ADMIN_USERS: "alice" });
  const b = await buildApp(cfg, { model: new ScriptModel([() => reply("x")]), persist: false, logger: false, iapRoots: [p.root] });
  b.app.addHook("preClose", (done) => { b.app.server.closeAllConnections?.(); done(); });
  await b.app.listen({ port: 0, host: "127.0.0.1" }); const base = `http://127.0.0.1:${(b.app.server.address() as { port: number }).port}`;
  const J = { "content-type": "application/json" };
  const post = (path: string, body: unknown, h: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { ...J, ...h }, body: JSON.stringify(body) });
  const guest = async (dev: string, name: string) => { const g = await (await post("/api/auth/anonymous", { deviceId: dev, username: name })).json(); return { id: g.user.id as string, A: { authorization: `Bearer ${g.token}` } }; };
  const B = "com.grepawk.moviefone"; const exp = Date.now() + 30 * 86_400_000;
  try {
    const alice = await login(base, "code-a");
    const totals = async () => (await (await fetch(`${base}/api/admin/billing?days=7`, { headers: { cookie: alice.cookie } })).json()).totals as Record<string, number>;
    const blog = async (account: string) => (await (await fetch(`${base}/api/admin/billing-log?account=${account}`, { headers: { cookie: alice.cookie } })).json()).events as { event: string; plan: string; provider: string; value_cents: number | null; surface: string }[];
    // u1: paid purchase through the verify route (price 5990 milliunits = 599 cents), repost = restore
    const tok1 = "6f1c2a3b-1111-4222-8333-944455556666";
    const tx1 = (o: object = {}) => ({ transactionId: "1001", originalTransactionId: "1000", bundleId: B, productId: `${B}.pro_monthly`, expiresDate: exp, environment: "Production", appAccountToken: tok1, price: 5990, ...o });
    const u1 = await guest("billing-device-000001", "BillingBird");
    await post("/api/iap/apple", { signed_transaction: jws(p, tx1()), app_account_token: tok1 }, u1.A);
    await post("/api/iap/apple", { signed_transaction: jws(p, tx1()), app_account_token: tok1 }, u1.A); // idempotent repost
    let t = await totals();
    assert.equal(t.purchase, 1); assert.equal(t.restore, 1);
    const l1 = await blog(u1.id);
    assert.deepEqual(l1.map((e) => e.event), ["restore", "purchase", "signup"]); // guest account creation is the signup
    assert.equal(l1[1].plan, "pro_monthly"); assert.equal(l1[1].provider, "apple"); assert.equal(l1[1].value_cents, 599); assert.equal(l1[1].surface, "ios");
    // u2: free trial via verify, then ASSN renew (converts), renew again, cancel signal, refund
    const tok2 = "7f1c2a3b-1111-4222-8333-944455556666";
    const tx2 = (o: object = {}) => ({ transactionId: "2001", originalTransactionId: "2000", bundleId: B, productId: `${B}.pro_yearly`, expiresDate: exp, environment: "Production", appAccountToken: tok2, price: 47990, ...o });
    const u2 = await guest("billing-device-000002", "TrialToad");
    await post("/api/iap/apple", { signed_transaction: jws(p, tx2({ offerDiscountType: "FREE_TRIAL" })), app_account_token: tok2 }, u2.A);
    const note = (uuid: string, type: string, tx: object, subtype?: string) => post("/api/iap/apple/notifications", { signedPayload: jws(p, { notificationType: type, subtype, notificationUUID: uuid, data: { bundleId: B, environment: "Production", signedTransactionInfo: jws(p, tx2(tx)) } }) });
    await note("b1", "DID_RENEW", { transactionId: "2002", expiresDate: exp + 1 });
    await note("b2", "DID_RENEW", { transactionId: "2003", expiresDate: exp + 2 });
    await note("b3", "DID_CHANGE_RENEWAL_STATUS", {}, "AUTO_RENEW_DISABLED");
    await note("b4", "REFUND", { revocationDate: Date.now() });
    t = await totals();
    assert.equal(t.trial_start, 1); assert.equal(t.trial_convert, 1); assert.equal(t.renewal, 1); assert.equal(t.cancel, 1); assert.equal(t.refund, 1);
    const l2 = await blog(u2.id);
    assert.deepEqual(l2.map((e) => e.event), ["refund", "cancel", "renewal", "trial_convert", "trial_start", "signup"]);
    assert.ok(l2.slice(0, 5).every((e) => e.provider === "apple" && e.plan === "pro_yearly"));
    assert.equal(l2[4].surface, "ios"); assert.equal(l2[0].surface, "server");
  } finally { await b.app.close(); }
});

test("ios bridge: billing rows posted to /api/events land in the recorder (#119 intake)", { timeout: 60_000 }, async () => {
  const { b, base } = await serve();
  const J = { "content-type": "application/json" };
  const post = (path: string, body: unknown, h: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { ...J, ...h }, body: JSON.stringify(body) });
  try {
    const alice = await login(base, "code-a");
    const carolAcc = b.accounts.upsertOAuth("google", "g-carol", "Carol", "carol@example.com").account;
    const cs = b.sessions.create(carolAcc.id);
    const carol = { cookie: `${COOKIE}=${b.sessions.cookieValue(cs)}` };
    const batch = { session: "sess-bridge-1", client: "ios", events: [
      { event: "paywall_view", reason: "second_composition", ts: 1 },
      { event: "plan_select", plan: "com.ragnus.gbk.pro_yearly", ts: 2 },
      { event: "iap_purchase_start", plan: "com.ragnus.gbk.pro_yearly", ts: 3 },
      { event: "iap_purchase_result", plan: "com.ragnus.gbk.pro_yearly", result: "success", ts: 4 },
      { event: "restore", result: "none", ts: 5 },
      { event: "bogus_event", ts: 6 },
    ] };
    const res = await (await post("/api/events", batch, carol)).json() as { ok: boolean; accepted: number };
    assert.equal(res.accepted, 4); // view, plan_select, purchase_start->checkout_start, restore; purchase_result + bogus not stored
    const rep = await (await fetch(`${base}/api/admin/billing?days=7`, { headers: { cookie: alice.cookie } })).json() as { totals: Record<string, number>; steps: { bySurface: { surface: string; paywall_view: number; checkout_start: number }[] } };
    assert.equal(rep.totals.paywall_view, 1); assert.equal(rep.totals.plan_select, 1);
    assert.equal(rep.totals.checkout_start, 1); assert.equal(rep.totals.restore, 1);
    assert.equal(rep.totals.purchase ?? 0, 0); // a client-claimed purchase is never recorded; ASSN is the source
    const ios = rep.steps.bySurface.find((r) => r.surface === "ios");
    assert.equal(ios?.paywall_view, 1); assert.equal(ios?.checkout_start, 1);
    const log = await (await fetch(`${base}/api/admin/billing-log?account=${carolAcc.id}`, { headers: { cookie: alice.cookie } })).json() as { events: { event: string; plan: string; surface: string; detail: string }[] };
    const sel = log.events.find((e) => e.event === "plan_select");
    assert.equal(sel?.plan, "pro_yearly"); // StoreKit product id mapped to the plan slug
    assert.equal(sel?.surface, "ios");
    const view = log.events.find((e) => e.event === "paywall_view");
    assert.match(view?.detail ?? "", /reason=second_composition/);
  } finally { await b.app.close(); }
});
