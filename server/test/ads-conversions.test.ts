// #130: X + Reddit Conversions API from the billing hop. Off unless configured, hashed email only,
// opt-out respected, no secrets/PII in logs, pixels absent from HTML when unset, inline JSON escaped.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AdsConversions, adsConfig, hashEmail, oauth1Header, xEventId, X_API, REDDIT_API } from "../src/ads/conversions.ts";
import { pixelHead, pricingConfig, jsStr } from "../src/routes/pricing.ts";
import { buildApp } from "../src/app.ts";
import { testConfig, ScriptModel, reply } from "./helpers.ts";

const FULL = {
  COMPOSE_X_PIXEL_ID: "oka17", COMPOSE_X_EVENT_ID_PURCHASE: "tw-oka17-ol288", COMPOSE_X_EVENT_ID_START_TRIAL: "tw-oka17-tr001",
  X_ADS_CONSUMER_KEY: "ck-xxxxxxxx", X_ADS_CONSUMER_SECRET: "cs-xxxxxxxx", X_ADS_ACCESS_TOKEN: "at-xxxxxxxx", X_ADS_ACCESS_TOKEN_SECRET: "ats-xxxxxxx",
  COMPOSE_REDDIT_PIXEL_ID: "a2_testpixel", REDDIT_CAPI_TOKEN: "rdt-token-xxxxxxxx",
};
const SHA = createHash("sha256").update("buyer@example.com").digest("hex");
const conv = { event: "purchase" as const, conversionId: "gc-abc123-xyz", valueCents: 9999, twclid: "tw-click-1", rdtCid: "rdt-click-1", email: "  Buyer@Example.com ", at: Date.UTC(2026, 9, 31) };

test("off unless configured: unset or partial env builds no requests and makes no calls", async () => {
  let calls = 0; const f = (async () => { calls++; return new Response("{}"); }) as typeof fetch;
  for (const env of [{}, { COMPOSE_X_PIXEL_ID: "oka17", COMPOSE_X_EVENT_ID_PURCHASE: "ol288" }, { COMPOSE_REDDIT_PIXEL_ID: "a2_x" }, { ...FULL, COMPOSE_ADS_ENABLED: "0" }]) {
    const a = new AdsConversions(adsConfig(env), { fetch: f });
    assert.equal(a.active, false); assert.deepEqual(a.requests(conv), []);
    assert.deepEqual(await a.send(conv), []);
  }
  assert.equal(calls, 0);
  const xOnly = adsConfig({ ...FULL, REDDIT_CAPI_TOKEN: "" }); assert.ok(xOnly.x); assert.equal(xOnly.reddit, null);
  assert.equal(adsConfig({ ...FULL, COMPOSE_X_PIXEL_ID: "x');alert(1)//" }).x, null, "ids are validated");
});

test("payloads: X + Reddit v3 shapes, SHA-256 email only (never raw), click ids, dedupe conversion id", () => {
  const a = new AdsConversions(adsConfig(FULL));
  const [x, r] = a.requests(conv);
  assert.equal(x.platform, "x"); assert.equal(x.url, `${X_API}/oka17`); assert.match(x.headers.authorization, /^OAuth oauth_consumer_key="ck-xxxxxxxx", .*oauth_signature="[^"]+"$/);
  const xb = JSON.parse(x.body).conversions[0];
  assert.equal(xb.event_id, "ol288"); assert.equal(xb.conversion_id, "gc-abc123-xyz"); assert.equal(xb.value, "99.99"); assert.equal(xb.conversion_time, "2026-10-31T00:00:00.000Z");
  assert.deepEqual(xb.identifiers, [{ twclid: "tw-click-1" }, { hashed_email: SHA }]);
  assert.equal(r.platform, "reddit"); assert.equal(r.url, `${REDDIT_API}/a2_testpixel/conversion_events`); assert.equal(r.headers.authorization, "Bearer rdt-token-xxxxxxxx");
  const ev = JSON.parse(r.body).data.events[0];
  assert.deepEqual(ev, { event_at: conv.at, action_source: "WEBSITE", type: { tracking_type: "PURCHASE" }, click_id: "rdt-click-1", metadata: { conversion_id: "gc-abc123-xyz", value: 99.99, currency: "USD", item_count: 1 }, user: { email: SHA } });
  for (const q of [x, r]) assert.ok(!/buyer@example\.com/i.test(q.body), "raw email never leaves");
  const [xt, rt] = a.requests({ ...conv, event: "trial_start" });
  assert.equal(JSON.parse(xt.body).conversions[0].event_id, "tr001"); assert.equal(JSON.parse(xt.body).conversions[0].value, "0.00");
  assert.deepEqual(JSON.parse(rt.body).data.events[0].type, { tracking_type: "CUSTOM", custom_event_name: "StartTrial" });
  assert.equal(JSON.parse(rt.body).data.events[0].metadata.value, undefined);
});

test("privacy gates: opt-out, no identifiers, bad conversion id, other events -> nothing sent", () => {
  const a = new AdsConversions(adsConfig(FULL));
  assert.deepEqual(a.requests({ ...conv, optOut: true }), []);
  assert.deepEqual(a.requests({ ...conv, twclid: undefined, rdtCid: undefined, email: undefined }), []);
  assert.deepEqual(a.requests({ ...conv, conversionId: "<script>" }), []);
  assert.deepEqual(a.requests({ ...conv, event: "refund" as never }), []);
  assert.equal(a.requests({ ...conv, twclid: "bad id with spaces", rdtCid: undefined }).length, 2, "invalid click id dropped, hashed email still matches");
  assert.equal(hashEmail(undefined, SHA.toUpperCase()), SHA); assert.equal(hashEmail("not-an-email"), undefined);
  assert.equal(xEventId("tw-oka17-ol288"), "ol288"); assert.equal(xEventId("ol288"), "ol288");
});

test("OAuth 1.0a header is deterministic for a fixed nonce/timestamp and signs only url params", () => {
  const k = { consumerKey: "ck", consumerSecret: "cs", token: "t", tokenSecret: "ts" };
  const h1 = oauth1Header("POST", `${X_API}/oka17`, k, "nonce", 1700000000), h2 = oauth1Header("POST", `${X_API}/oka17`, k, "nonce", 1700000000);
  assert.equal(h1, h2); assert.notEqual(h1, oauth1Header("POST", `${X_API}/oka18`, k, "nonce", 1700000000));
  assert.match(h1, /oauth_signature_method="HMAC-SHA1"/); assert.match(h1, /oauth_timestamp="1700000000"/);
});

test("send failures log [ads] with platform/event/status only (no ids, tokens, emails)", async () => {
  const logs: string[] = [];
  const a = new AdsConversions(adsConfig(FULL), { fetch: (async () => new Response("no", { status: 400 })) as typeof fetch, log: (o) => logs.push(JSON.stringify(o)) });
  const r = await a.send(conv);
  assert.deepEqual(r.map((x) => [x.platform, x.ok, x.status]), [["x", false, 400], ["reddit", false, 400]]);
  assert.equal(logs.length, 2); assert.match(logs[0], /\[ads\] x CAPI purchase HTTP 400/);
  for (const l of logs) for (const s of ["rdt-token", "cs-x", "ats-", "buyer@", SHA, "gc-abc123", "tw-click"]) assert.ok(!l.includes(s), `log leaks ${s}`);
});

test("pixels: nothing in the page when unset; inline values are script-safe", () => {
  assert.equal(pixelHead(pricingConfig({})), "");
  assert.equal(pixelHead(pricingConfig({ COMPOSE_ADS_ENABLED: "0", COMPOSE_X_PIXEL_ID: "oka17" })), "");
  const h = pixelHead(pricingConfig({ COMPOSE_X_PIXEL_ID: "oka17", COMPOSE_REDDIT_PIXEL_ID: "a2_x" }));
  assert.match(h, /twq\('config',"oka17"\)/); assert.match(h, /rdt\('init',"a2_x"\)/); assert.match(h, /globalPrivacyControl/);
  assert.equal(jsStr("</script><b>&\u2028"), '"\\u003c/script\\u003e\\u003cb\\u003e\\u0026\\u2028"');
});

async function hop(env: Record<string, string>, body: object) {
  const keys = Object.keys(FULL).concat("COMPOSE_ADS_ENABLED"); const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k]; Object.assign(process.env, env);
  const sent: { url: string; body: string }[] = [];
  const f = (async (u: string | URL | Request, init?: RequestInit) => { const url = String(u); if (url.startsWith(X_API) || url.startsWith(REDDIT_API)) sent.push({ url, body: String(init?.body) }); return new Response("{}", { status: 200 }); }) as typeof fetch;
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test", COMPOSE_BILLING_WEBHOOK_TOKEN: "whsec-test-token" });
  const b = await buildApp(cfg, { model: new ScriptModel([() => reply("x")]), persist: false, logger: false, fetch: f });
  try {
    const res = await b.app.inject({ method: "POST", url: "/api/billing/stripe-events", headers: { "content-type": "application/json", "x-gbk-billing-token": "whsec-test-token" }, payload: body });
    assert.equal(res.statusCode, 200);
    await new Promise((r) => setTimeout(r, 20));
    return sent;
  } finally { await b.app.close(); for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}

test("billing hop: purchase fires both CAPIs when configured; none when unset or opted out", { timeout: 60_000 }, async () => {
  const ev = { event: "purchase", account: "acct1", plan: "lifetime", value_cents: 9999, event_id: "gc-abc123-xyz", twclid: "tw-click-1", rdt_cid: "rdt-click-1", email: "buyer@example.com" };
  const on = await hop(FULL, ev);
  assert.deepEqual(on.map((s) => s.url), [`${X_API}/oka17`, `${REDDIT_API}/a2_testpixel/conversion_events`]);
  assert.ok(on.every((s) => !s.body.includes("buyer@example.com") && s.body.includes(SHA)));
  assert.deepEqual(await hop({}, ev), [], "unset env: no calls");
  assert.deepEqual(await hop(FULL, { ...ev, ads_opt_out: "1" }), [], "GPC/DNT buyer: no calls");
  assert.deepEqual(await hop(FULL, { ...ev, event: "renewal" }), [], "only purchase / trial_start");
});
