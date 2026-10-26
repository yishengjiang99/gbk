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

test("pricing page: yearly is the preselected default, value-led copy, sticky CTA; prices unchanged", async () => {
  await withEnv({ COMPOSE_CHECKOUT_ENABLED: "1" }, async (base) => {
    const html = await (await fetch(`${base}/pricing`)).text();
    const at = (s: string) => { const i = html.indexOf(s); assert.notEqual(i, -1, `missing: ${s}`); return i; };
    // Plan card order: yearly, monthly, lifetime, and the Free card last (was: Free first, monthly first).
    const yearly = at("<h3>Pro yearly</h3>"), monthly = at("<h3>Pro monthly</h3>"), lifetime = at("<h3>Pro lifetime</h3>"), free = at("<h3>Free</h3>");
    assert.ok(yearly < monthly && monthly < lifetime && lifetime < free, "plan cards are yearly, monthly, lifetime, Free");
    // Yearly is the featured/preselected card, priced per month as billed.
    assert.match(html, /<div class="plan featured"><span class="badge">Best value<\/span><h3>Pro yearly<\/h3>/);
    assert.match(html, /\$4<small>\/month<\/small>/);
    assert.match(html, /billed yearly \(\$47\.99\/year\)/);
    assert.match(html, /save 33%/);
    assert.match(html, /<title>[^<]*Pro from \$4\/month billed yearly<\/title>/);
    // Lead copy leads with the value users feel and the trial; the FAQ keeps the ChatGPT explanation.
    assert.match(html, /<p class="lead">Get 10× the AI composer budget and longer renders[^<]*7-day free trial/);
    assert.match(html, /Can I buy Pro inside ChatGPT\?/);
    assert.match(html, /ChatGPT plugins may not sell subscriptions/);
    // Sticky CTA is present and defaults to the yearly plan's checkout form.
    const sticky = html.slice(at('<div class="sticky-cta">'));
    assert.match(sticky, /Pro yearly: \$4\/month billed yearly, with a 7-day free trial\./);
    assert.match(sticky, /<form method="post"[^>]*data-checkout[^>]*><input type="hidden" name="plan" value="pro_yearly">/);
    // Checkout behavior unchanged: one Buy form per plan card plus the sticky yearly form.
    assert.equal((html.match(/data-checkout data-ads/g) ?? []).length, 4);
    assert.equal((html.match(/name="plan" value="pro_yearly"/g) ?? []).length, 2);
    assert.equal((html.match(/name="plan" value="pro_monthly"/g) ?? []).length, 1);
    assert.equal((html.match(/name="plan" value="lifetime"/g) ?? []).length, 1);
    // Prices in the JSON-LD offers are the unchanged plan amounts.
    const app = jsonLds(html).find((o) => o["@type"] === "SoftwareApplication") as { offers: { name: string; price: string }[] };
    assert.deepEqual(app.offers.map((o) => `${o.name}:${o.price}`), ["Free:0", "Pro yearly:47.99", "Pro monthly:5.99", "Pro lifetime:99.00"]);
  });
});

test("pricing page with checkout off: sticky CTA points at the waitlist and no Buy forms render", async () => {
  await withEnv({}, async (base) => {
    const html = await (await fetch(`${base}/pricing`)).text();
    assert.ok(!html.includes("data-checkout data-ads"), "no checkout forms while COMPOSE_CHECKOUT_ENABLED is off");
    const i = html.indexOf('<div class="sticky-cta">'); assert.notEqual(i, -1, "sticky CTA present");
    assert.match(html.slice(i), /<a class="cta" href="#waitlist">Get notified<\/a>/);
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
