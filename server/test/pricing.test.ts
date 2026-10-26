// /pricing, /pricing/thanks, /plans, /privacy/payments-and-ads, waitlist, pixel off switch.
import test from "node:test";
import assert from "node:assert/strict";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";
import { pricingConfig, pixelHead, FAQ } from "../src/routes/pricing.ts";

const ENV = ["COMPOSE_CHECKOUT_ENABLED", "COMPOSE_ADS_ENABLED", "COMPOSE_X_PIXEL_ID", "COMPOSE_X_EVENT_ID_PURCHASE", "COMPOSE_X_EVENT_ID_START_TRIAL", "COMPOSE_REDDIT_PIXEL_ID", "COMPOSE_CHECKOUT_ORIGIN"];
async function withEnv(env: Record<string, string>, fn: (base: string) => Promise<void>) {
  const old = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, env);
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try { await fn(s.base); } finally { await s.app.close(); for (const k of ENV) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}
const jsonLds = (h: string) => [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

test("pixel ids are validated, so a bad env value cannot inject script", () => {
  const p = pricingConfig({ COMPOSE_X_PIXEL_ID: "x');alert(1);//", COMPOSE_REDDIT_PIXEL_ID: "" });
  assert.equal(p.xPixelId, ""); assert.equal(pixelHead(p), "");
  assert.equal(pricingConfig({ COMPOSE_CHECKOUT_ORIGIN: "javascript:alert(1)" }).checkoutOrigin, "https://grepawk.com");
});

test("waitlist stores valid emails, rejects bad ones, honeypot is silent; sitemap lists /pricing", async () => {
  await withEnv({}, async (base) => {
    const post = (body: Record<string, string>) => fetch(`${base}/api/pricing/waitlist`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), redirect: "manual" });
    const ok = await post({ email: "Fan@Example.com" }); assert.equal(ok.status, 303); assert.equal(ok.headers.get("location"), "/pricing?waitlist=ok#waitlist");
    assert.equal((await post({ email: "nope" })).headers.get("location"), "/pricing?waitlist=invalid#waitlist");
    assert.equal((await post({ email: "bot@example.com", website: "spam" })).headers.get("location"), "/pricing?waitlist=ok#waitlist");
    assert.match(await (await fetch(`${base}/pricing?waitlist=ok`)).text(), /on the list/);
    const sm = await (await fetch(`${base}/sitemap.xml`)).text(); assert.match(sm, /<loc>http:\/\/composer.test\/pricing<\/loc>/);
    const priv = await (await fetch(`${base}/privacy/payments-and-ads`)).text(); assert.match(priv, /Global Privacy Control/); assert.match(priv, /SHA-256/);
  });
});
