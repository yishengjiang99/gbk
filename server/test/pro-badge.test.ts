// #133: the public Pro badge flag. Public payloads (profile, feed authors) expose a bare `pro`
// boolean from the same unified entitlement /api/me uses (Apple IAP OR Stripe) — never the
// source, expiry or environment. SSR /u/:handle renders the badge pill from the same predicate.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { buildApp } from "../src/app.ts";
import { COOKIE } from "../src/security/authentication.ts";
import { testConfig, ScriptModel, reply } from "./helpers.ts";
import { entitlementFetch } from "./stripe-helpers.ts";
import { ShareStore } from "../src/persistence/shares.ts";
import { SocialStore } from "../src/persistence/social.ts";
import { IapStore } from "../src/persistence/iap.ts";
import { AccountLimits } from "../src/agent/limits.ts";
import { seoRoutes } from "../src/routes/seo.ts";
import type { Config } from "../src/config.ts";

const proj = JSON.stringify({ name: "x", tracks: [] });

test("public profile + feed author expose bare pro (Stripe source), private fields stay on /api/me only", async () => {
  const state = { pro: new Set<string>(), down: false, calls: [] as string[] };
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test", COMPOSE_ENTITLEMENT_ORIGIN: "https://billing.test", COMPOSE_ENTITLEMENT_TOKEN: "test-entitlement-token" });
  const b = await buildApp(cfg, { model: new ScriptModel([() => reply("x")]), persist: false, logger: false, fetch: entitlementFetch(state) });
  try {
    state.pro.add("payer@example.com");
    const payer = b.accounts.upsertOAuth("google", "g-payer", "Payer Person", "payer@example.com").account;
    const free = b.accounts.upsertOAuth("google", "g-free", "Free Person", "free@example.com").account;
    const social = new SocialStore(b.shares.database);
    const payerProfile = social.ensureProfile(payer.id, "Payer Person");
    const freeProfile = social.ensureProfile(free.id, "Free Person");
    const s1 = b.shares.create({ owner: payer.id, title: "Payer Song", projectJson: proj, public: true }); social.markPublished(s1.id);
    const s2 = b.shares.create({ owner: free.id, title: "Free Song", projectJson: proj, public: true }); social.markPublished(s2.id);

    type PubUser = { pro?: boolean;[k: string]: unknown };
    // Warm the Stripe cache the way real traffic does (and confirm /api/me is unchanged).
    const sess = b.sessions.create(payer.id);
    const me = (await b.app.inject({ method: "GET", url: "/api/me", headers: { cookie: `${COOKIE}=${b.sessions.cookieValue(sess)}` } })).json() as { pro?: boolean; pro_source?: string | null };
    assert.equal(me.pro, true); assert.equal(me.pro_source, "stripe");

    const pub = (await b.app.inject({ method: "GET", url: `/api/users/${payerProfile.handle}` })).json() as { user: PubUser; songs: { author: PubUser }[] };
    assert.equal(pub.user.pro, true, "public profile carries pro=true for a Stripe Pro");
    for (const k of ["pro_source", "pro_expires_at", "pro_environment"]) assert.ok(!(k in pub.user), `public user must not expose ${k}`);
    assert.equal(pub.songs[0].author.pro, true, "profile song authors carry the flag too");

    const pubFree = (await b.app.inject({ method: "GET", url: `/api/users/${freeProfile.handle}` })).json() as { user: PubUser };
    assert.equal(pubFree.user.pro, false, "free user reads pro=false");

    const feed = (await b.app.inject({ method: "GET", url: "/api/feed?sort=new" })).json() as { items: { slug: string; author: PubUser }[] };
    const bySlug = new Map(feed.items.map((i) => [i.slug, i.author] as const));
    assert.equal(bySlug.get(s1.slug)?.pro, true, "feed card author is Pro");
    assert.equal(bySlug.get(s2.slug)?.pro, false, "feed card author is not Pro");
    assert.ok(!("pro_source" in (bySlug.get(s1.slug) ?? {})), "feed author must not expose pro_source");

    // The Apple source feeds the same public flag: grant the free user a lifetime IAP.
    new IapStore(b.shares.database).upsert({ original_tx: "orig-1", last_tx: "tx-1", user: free.id, app_token: null, product_id: "com.grepawk.moviefone.pro_lifetime", environment: "Production", expires_at: null, revoked_at: null });
    const pubFree2 = (await b.app.inject({ method: "GET", url: `/api/users/${freeProfile.handle}` })).json() as { user: PubUser };
    assert.equal(pubFree2.user.pro, true, "Apple IAP Pro shows on the public profile too");
  } finally { await b.app.close(); }
});

test("SSR /u/:handle renders the Pro pill only for a Pro user", async () => {
  const shares = new ShareStore(":memory:"); const social = new SocialStore(shares.database);
  const iap = new IapStore(shares.database);
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "https://compose.test" });
  // Wire limits exactly as app.ts does (Apple branch): proSource from the IAP store, pro from it.
  const limits = new AccountLimits(cfg, null);
  limits.proSource = (u) => (iap.pro(u).pro ? "apple" : null);
  limits.pro = (u) => limits.proSource(u) !== null;
  const dir = mkdtempSync(join(tmpdir(), "badge-")); const shellFile = join(dir, "index.html");
  writeFileSync(shellFile, `<!doctype html><html><head><title>Generic</title></head><body><div id="root"></div></body></html>`);
  const app = Fastify();
  seoRoutes(app, cfg as Config, shares.database, { shellFile, ogDir: join(dir, "og"), proOf: (u) => limits.pro(u) });
  await app.ready();
  try {
    social.ensureProfile("u1", "Alice"); social.ensureProfile("u2", "Bob");
    shares.create({ owner: "u1", title: "Song A", projectJson: proj, public: true });
    shares.create({ owner: "u2", title: "Song B", projectJson: proj, public: true });
    iap.upsert({ original_tx: "orig-a", last_tx: "tx-a", user: "u1", app_token: null, product_id: "com.grepawk.moviefone.pro_lifetime", environment: "Production", expires_at: null, revoked_at: null });
    const a = (await app.inject("/u/alice")).body;
    assert.ok(a.includes(`<span class="pro">Pro</span>`), "Pro user gets the badge pill");
    const b = (await app.inject("/u/bob")).body;
    assert.ok(!b.includes(`class="pro"`), "free user gets no badge");
  } finally { await app.close(); }
});
