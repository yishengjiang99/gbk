// Live sitemap (public only, escaped, chunked index) and per-song/profile meta injection.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { ShareStore } from "../src/persistence/shares.ts";
import { SocialStore } from "../src/persistence/social.ts";
import { seoRoutes, xmlEsc } from "../src/routes/seo.ts";
import type { Config } from "../src/config.ts";

const SHELL = `<!doctype html><html><head><title>Generic</title><meta name="description" content="generic" /><meta property="og:type" content="website" /><meta property="og:title" content="g" /><meta property="og:description" content="g" /><meta name="twitter:title" content="g" /><meta name="twitter:description" content="g" /></head><body><div id="root"></div></body></html>`;

async function setup(chunk?: number) {
  const shares = new ShareStore(":memory:"); const social = new SocialStore(shares.database);
  const dir = mkdtempSync(join(tmpdir(), "seo-")); const shellFile = join(dir, "index.html"); writeFileSync(shellFile, SHELL);
  const app = Fastify(); seoRoutes(app, { publicOrigin: "https://compose.test" } as Config, shares.database, { chunk, shellFile });
  await app.ready(); return { app, shares, social };
}
const proj = JSON.stringify({ name: "x", tracks: [] });

test("sitemap lists public songs and profiles, excludes private and deleted, escapes XML", async () => {
  const { app, shares, social } = await setup();
  social.ensureProfile("u1", "Alice"); social.upsertArtist("ai1", { handle: "nova", display_name: "Nova", bio: "AI" }); social.ensureProfile("u2", "Nobody");
  const pub = shares.create({ owner: "u1", title: "Rock & <Roll>", projectJson: proj, public: true });
  const priv = shares.create({ owner: "u2", title: "Secret", projectJson: proj, public: false });
  const gone = shares.create({ owner: "u1", title: "Gone", projectJson: proj, public: true }); shares.delete(gone.slug);
  const hidden = shares.create({ owner: "u1", title: "Hidden", projectJson: proj, public: true }); shares.setPublic(hidden.slug, false);
  const r = await app.inject("/sitemap.xml");
  assert.equal(r.statusCode, 200); assert.match(r.headers["content-type"] as string, /^application\/xml/);
  assert.match(r.headers["cache-control"] as string, /max-age=3600/); assert.ok(r.headers.etag);
  assert.ok(r.body.includes(`<loc>https://compose.test/s/${pub.slug}</loc><lastmod>`));
  for (const s of [priv, gone, hidden]) assert.ok(!r.body.includes(`/s/${s.slug}<`), s.title);
  for (const p of ["/", "/feed", "/chatgpt", "/chatgpt/gallery", "/privacy", "/terms", "/support", "/u/nova", `/u/${social.profile("u1")!.handle}`]) assert.ok(r.body.includes(`<loc>https://compose.test${p}</loc>`), p);
  assert.ok(!r.body.includes(`/u/${social.profile("u2")!.handle}<`));
  assert.equal(xmlEsc(`a&b<"c'>`), "a&amp;b&lt;&quot;c&apos;&gt;");
  assert.equal((await app.inject({ url: "/sitemap.xml", headers: { "if-none-match": r.headers.etag as string } })).statusCode, 304);
});

test("sitemap becomes an index with child song sitemaps past the chunk size", async () => {
  const { app, shares } = await setup(15);
  for (let i = 0; i < 20; i++) shares.create({ owner: "u1", title: `Song ${i}`, projectJson: proj, public: true });
  const idx = (await app.inject("/sitemap.xml")).body;
  assert.match(idx, /<sitemapindex/); assert.ok(idx.includes("/sitemap-songs-2.xml")); assert.ok(!idx.includes("/sitemap-songs-3.xml"));
  const c1 = await app.inject("/sitemap-songs-1.xml"), c2 = await app.inject("/sitemap-songs-2.xml");
  assert.equal(c1.statusCode, 200); assert.equal((c1.body.match(/<url>/g) ?? []).length + (c2.body.match(/<url>/g) ?? []).length, 20);
  assert.equal((await app.inject("/sitemap-songs-3.xml")).statusCode, 404);
  assert.match((await app.inject("/sitemap-pages.xml")).body, /compose\.test\/feed/);
});

test("/s/<slug> and /u/<handle> get server-injected title, description, canonical and og tags", async () => {
  const { app, shares, social } = await setup();
  social.ensureProfile("u1", "Alice");
  const pub = shares.create({ owner: "u1", title: `Night "Drive"`, projectJson: proj, public: true });
  const priv = shares.create({ owner: "u1", title: "Secret", projectJson: proj, public: false });
  const h = (await app.inject(`/s/${pub.slug}`)).body;
  assert.match(h, /<title>Night &quot;Drive&quot; by Alice · GBK Composer<\/title>/);
  assert.ok(h.includes(`<link rel="canonical" href="https://compose.test/s/${pub.slug}" />`));
  assert.match(h, /og:title" content="Night &quot;Drive&quot;/); assert.match(h, /name="description" content="Night/); assert.match(h, /index,follow/); assert.match(h, /id="root"/);
  const p = (await app.inject(`/s/${priv.slug}`)).body; assert.ok(!p.includes("Secret")); assert.match(p, /noindex/);
  const u = (await app.inject(`/u/${social.profile("u1")!.handle}`)).body; assert.match(u, /<title>Alice \(@/); assert.match(u, /1 public song by Alice/);
});
