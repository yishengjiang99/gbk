import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { COOKIE } from "../src/security/authentication.ts";
import { testConfig, ScriptModel, reply } from "./helpers.ts";
import { entitlementFetch } from "./stripe-helpers.ts";

async function stripeApp(over: Record<string, string> = {}) {
  let now = Date.now();
  const state = { pro: new Set<string>(), down: false, calls: [] as string[] };
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test", COMPOSE_ENTITLEMENT_ORIGIN: "https://billing.test", COMPOSE_ENTITLEMENT_TOKEN: "test-entitlement-token", ...over });
  const b = await buildApp(cfg, { model: new ScriptModel([() => reply("x")]), persist: false, logger: false, fetch: entitlementFetch(state), now: () => now });
  const user = (provider: "google" | "apple" | "github" | "phone", id: string, email: string | null) => {
    const a = b.accounts.upsertOAuth(provider, id, id, email).account; const s = b.sessions.create(a.id);
    return { id: a.id, H: { cookie: `${COOKIE}=${b.sessions.cookieValue(s)}` } };
  };
  const me = async (h: Record<string, string>) => { const r = await b.app.inject({ method: "GET", url: "/api/me", headers: h }); assert.equal(r.statusCode, 200, r.body); return r.json(); };
  return { b, cfg, state, user, me, advance: (ms: number) => { now += ms; } };
}

test("Stripe Pro: active Stripe subscription -> Pro in /api/me and 10x limits; free user stays Free; Apple path unchanged", async () => {
  const { b, cfg, state, user, me } = await stripeApp();
  try {
    state.pro.add("payer@example.com");
    const payer = user("google", "g-payer", "Payer@Example.com"); const free = user("google", "g-free", "free@example.com");
    const m = await me(payer.H);
    assert.equal(m.pro, true); assert.equal(m.pro_source, "stripe");
    assert.equal(b.limits.for(payer.id).pro, true);
    assert.equal(b.limits.for(payer.id).dailyTokens, cfg.agent.dailyTokenBudget * 10);
    const f = await me(free.H);
    assert.equal(f.pro, false); assert.equal(f.pro_source, null);
    assert.equal(b.limits.for(free.id).pro, false); assert.ok(b.limits.for(free.id).dailyTokens <= cfg.agent.dailyTokenBudget, "free (new-account) budget");
    // /api/session limits reflect it too
    const sess = (await b.app.inject({ method: "GET", url: "/api/session", headers: payer.H })).json();
    assert.equal(sess.limits.pro, true); assert.equal(sess.limits.dailyTokens, cfg.agent.dailyTokenBudget * 10);
    // the email in the lookup is normalized; the token never appears in the URL
    assert.ok(state.calls.every((u) => !u.includes("test-entitlement-token")));
    assert.ok(state.calls.some((u) => u.includes("email=payer%40example.com")));
  } finally { await b.app.close(); }
});

test("Stripe Pro: only verified-email accounts; phone/guest never looked up", async () => {
  const { b, state, user, me } = await stripeApp();
  try {
    state.pro.add("x@example.com");
    const phone = user("phone", "p-1", "x@example.com");
    assert.equal((await me(phone.H)).pro, false);
    assert.equal(state.calls.length, 0);
  } finally { await b.app.close(); }
});

test("Stripe Pro: 10-min cache, outage fails closed to Free (no 500), confirmed true kept up to 24 h", async () => {
  const { b, state, user, me, advance } = await stripeApp();
  try {
    state.pro.add("a@example.com");
    const a = user("google", "g-a", "a@example.com"); const z = user("google", "g-z", "z@example.com");
    assert.equal((await me(a.H)).pro, true); const n = state.calls.length;
    advance(5 * 60_000); assert.equal((await me(a.H)).pro, true); assert.equal(state.calls.length, n, "cached for 10 min");
    state.down = true;
    advance(6 * 60_000); assert.equal((await me(a.H)).pro, true, "outage keeps a confirmed true");
    assert.equal((await me(z.H)).pro, false, "outage with no cache -> Free, no 500");
    advance(24 * 3_600_000); assert.equal((await me(a.H)).pro, false, "true kept at most 24 h");
    state.down = false; state.pro.delete("a@example.com");
    assert.equal((await me(a.H)).pro, false, "cancelled subscription -> Free");
  } finally { await b.app.close(); }
});

test("Stripe Pro: no token configured -> Apple only, never calls out", async () => {
  const { b, state, user, me } = await stripeApp({ COMPOSE_ENTITLEMENT_TOKEN: "" });
  try { state.pro.add("a@example.com"); const a = user("google", "g-a", "a@example.com"); assert.equal((await me(a.H)).pro, false); assert.equal(state.calls.length, 0); }
  finally { await b.app.close(); }
});
