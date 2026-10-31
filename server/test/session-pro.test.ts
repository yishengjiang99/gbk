// Web Pro badge: /api/session carries the paid entitlement (Apple IAP or Stripe matched by verified account
// email) as `pro` / `pro_source`, so the Studio header/settings can show "Pro · manage". Admin is not "paid".
import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { COOKIE } from "../src/security/authentication.ts";
import { testConfig, ScriptModel, reply } from "./helpers.ts";
import { entitlementFetch } from "./stripe-helpers.ts";

test("/api/session exposes pro for a Stripe buyer matched by email; false for free and signed-out", async () => {
  const state = { pro: new Set<string>(), down: false, calls: [] as string[] };
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test", COMPOSE_ENTITLEMENT_ORIGIN: "https://billing.test", COMPOSE_ENTITLEMENT_TOKEN: "test-entitlement-token" });
  const b = await buildApp(cfg, { model: new ScriptModel([() => reply("x")]), persist: false, logger: false, fetch: entitlementFetch(state) });
  try {
    state.pro.add("payer@example.com");
    const sess = (id: string) => { const s = b.sessions.create(id); return { cookie: `${COOKIE}=${b.sessions.cookieValue(s)}` }; };
    const get = async (headers?: Record<string, string>) => (await b.app.inject({ method: "GET", url: "/api/session", headers })).json() as { authenticated: boolean; pro?: boolean; pro_source?: string | null };
    const payer = b.accounts.upsertOAuth("google", "g-payer", "Payer", "Payer@Example.com").account;
    const free = b.accounts.upsertOAuth("google", "g-free", "Free", "free@example.com").account;
    const p = await get(sess(payer.id));
    assert.equal(p.pro, true); assert.equal(p.pro_source, "stripe");
    const f = await get(sess(free.id));
    assert.equal(f.pro, false); assert.equal(f.pro_source, null);
    const anon = await get();
    assert.equal(anon.authenticated, false); assert.equal(anon.pro, false);
  } finally { await b.app.close(); }
});
