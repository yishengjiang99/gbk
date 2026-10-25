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

test("pricing page: SEO tags, valid JSON-LD with offers + FAQ, waitlist by default, no pixels without ids", async () => {
  await withEnv({}, async (base) => {
    const r = await fetch(`${base}/pricing`); assert.equal(r.status, 200);
    const h = await r.text();
    assert.match(h, /<title>GBK Composer pricing[^<]*<\/title>/); assert.match(h, /<meta name="description" content="[^"]{50,}"/);
    assert.match(h, /<link rel="canonical" href="http:\/\/composer.test\/pricing">/);
    for (const t of ["og:title", "og:description", "og:image", "og:url"]) assert.match(h, new RegExp(`property="${t}" content="[^"]+"`));
    for (const t of ["twitter:card", "twitter:title", "twitter:image"]) assert.match(h, new RegExp(`name="${t}" content="[^"]+"`));
    const [app, faq] = jsonLds(h);
    assert.equal(app["@type"], "SoftwareApplication"); assert.deepEqual(app.offers.map((o: { price: string }) => o.price), ["0", "5.99", "47.99", "99.00"]);
    assert.equal(faq["@type"], "FAQPage"); assert.equal(faq.mainEntity.length, FAQ.length);
    assert.match(h, /id="waitlist"/); assert.doesNotMatch(h, /api\/compose\/checkout/);
    assert.doesNotMatch(h, /uwt\.js|redditstatic/);
    assert.ok(h.includes('href="/privacy/payments-and-ads"'));
  });
});

test("checkout enabled: Buy forms post to grepawk.com with the plan; pixels load and the off switch removes them", async () => {
  const ids = { COMPOSE_CHECKOUT_ENABLED: "1", COMPOSE_X_PIXEL_ID: "o1abc", COMPOSE_X_EVENT_ID_PURCHASE: "tw-o1abc-buy", COMPOSE_X_EVENT_ID_START_TRIAL: "tw-o1abc-trial", COMPOSE_REDDIT_PIXEL_ID: "a2_test" };
  await withEnv(ids, async (base) => {
    const h = await (await fetch(`${base}/pricing`)).text();
    for (const plan of ["pro_monthly", "pro_yearly", "lifetime"]) assert.ok(h.includes(`<input type="hidden" name="plan" value="${plan}">`), plan);
    assert.equal((h.match(/action="https:\/\/grepawk.com\/api\/compose\/checkout"/g) ?? []).length, 3);
    assert.doesNotMatch(h, /id="waitlist"/);
    assert.match(h, /twq\('config',"o1abc"\)/); assert.match(h, /rdt\('init',"a2_test"\)/); assert.match(h, /globalPrivacyControl/);
    const t = await (await fetch(`${base}/pricing/thanks?plan=pro_yearly`)).text();
    assert.match(t, /noindex/); assert.match(t, /tw-o1abc-trial/); assert.match(t, /conversion_id:c.id/);
  });
  await withEnv({ ...ids, COMPOSE_ADS_ENABLED: "0" }, async (base) => {
    const h = await (await fetch(`${base}/pricing`)).text();
    assert.doesNotMatch(h, /uwt\.js|redditstatic|twq\(/); assert.match(h, /data-ads="0"/);
    assert.doesNotMatch(await (await fetch(`${base}/pricing/thanks`)).text(), /twq|rdt\(/);
  });
});

test("pixel ids are validated, so a bad env value cannot inject script", () => {
  const p = pricingConfig({ COMPOSE_X_PIXEL_ID: "x');alert(1);//", COMPOSE_REDDIT_PIXEL_ID: "" });
  assert.equal(p.xPixelId, ""); assert.equal(pixelHead(p), "");
  assert.equal(pricingConfig({ COMPOSE_CHECKOUT_ORIGIN: "javascript:alert(1)" }).checkoutOrigin, "https://grepawk.com");
});

test("/plans is informational only (what the ChatGPT plugin may link to): no checkout, no buy buttons", async () => {
  await withEnv({ COMPOSE_CHECKOUT_ENABLED: "1" }, async (base) => {
    const h = await (await fetch(`${base}/plans`)).text();
    assert.doesNotMatch(h, /checkout|<form|<button/i); assert.match(h, /informational only/);
  });
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
