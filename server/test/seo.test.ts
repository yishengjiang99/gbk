// Live sitemap (public only, escaped, chunked index) and per-song/profile meta injection.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { ShareStore } from "../src/persistence/shares.ts";
import { SocialStore } from "../src/persistence/social.ts";
import { seoRoutes, xmlEsc, isoDuration, durationSeconds } from "../src/routes/seo.ts";
import type { Config } from "../src/config.ts";

const SHELL = `<!doctype html><html><head><meta name="apple-itunes-app" content="app-id=123, app-argument=https://compose.test/" /><title>Generic</title><meta name="description" content="generic" /><meta property="og:type" content="website" /><meta property="og:title" content="g" /><meta property="og:description" content="g" /><meta name="twitter:title" content="g" /><meta name="twitter:description" content="g" /><meta property="og:image" content="https://x/cover.jpg" /><meta name="twitter:image" content="https://x/cover.jpg" /><script type="application/ld+json">{"@type":"SoftwareApplication"}</script></head><body><div id="root"></div></body></html>`;

async function setup(chunk?: number) {
  const shares = new ShareStore(":memory:"); const social = new SocialStore(shares.database);
  const dir = mkdtempSync(join(tmpdir(), "seo-")); const shellFile = join(dir, "index.html"); writeFileSync(shellFile, SHELL);
  const app = Fastify(); seoRoutes(app, { publicOrigin: "https://compose.test" } as Config, shares.database, { chunk, shellFile, ogDir: join(dir, "og") });
  await app.ready(); return { app, shares, social, dir };
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

test("song page: per-song og image, og:audio, musician, crawlable body and valid MusicRecording JSON-LD", async () => {
  const { app, shares, social, dir } = await setup();
  social.ensureProfile("u1", "Alice <B>");
  const project = JSON.stringify({ name: "x", ppq: 480, tempos: [{ tick: 0, microPerQuarter: 500000 }], tracks: [{ id: "t1", color: "#ff8800" }], notes: [{ trackId: "t1", tick: 0, duration: 480 * 8, pitch: 60 }, { trackId: "t1", tick: 960, duration: 480, pitch: 67 }] });
  const a = shares.create({ owner: "u1", title: "Song A", projectJson: project, public: true });
  const b = shares.create({ owner: "u1", title: "Song B", projectJson: proj, public: true });
  social.setMeta(a.id, { labels: ["jazz"], tags: ["late-night"], prompt_shared: true, prompt_text: "slow <jazz> waltz" });
  shares.setMedia(a.slug, "mp3", new Uint8Array([0x49, 0x44, 0x33, 0, 0]));
  const h = (await app.inject(`/s/${a.slug}`)).body;
  assert.ok(h.includes(`<meta property="og:image" content="https://compose.test/og/s/${a.slug}.png" />`)); assert.ok(!h.includes("cover.jpg"));
  assert.match(h, /og:image:width" content="1200"/); assert.match(h, /og:image:height" content="630"/); assert.match(h, /twitter:image" content="https:\/\/compose.test\/og\/s\//);
  assert.ok(h.includes(`<meta property="og:audio" content="https://compose.test/api/shares/${a.slug}/media/mp3" />`));
  assert.match(h, /music:musician" content="https:\/\/compose.test\/u\//);
  const root = /<div id="root">([\s\S]*?)<\/div>\s*<\/body>/.exec(h)?.[1] ?? h.split('<div id="root">')[1];
  assert.match(root, /<h1>Song A<\/h1>/); assert.match(root, /by <a href="\/u\/[^"]+">Alice &lt;B&gt;<\/a>/); assert.match(root, /jazz/); assert.match(root, /#late-night/);
  assert.match(root, /slow &lt;jazz&gt; waltz/); assert.match(root, /datetime="PT4S"/); assert.ok(root.includes(`href="/s/${b.slug}"`));
  const ld = [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  assert.equal(ld.length, 1); const r = ld[0];
  assert.equal(r["@type"], "MusicRecording"); assert.equal(r.name, "Song A"); assert.equal(r.url, `https://compose.test/s/${a.slug}`);
  assert.equal(r.byArtist.name, "Alice <B>"); assert.match(r.byArtist.url, /\/u\//); assert.equal(r.duration, "PT4S"); assert.match(r.datePublished, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.audio["@type"], "AudioObject"); assert.match(r.audio.contentUrl, /media\/mp3$/);
  assert.ok(!/<\/script>[^<]*waltz/.test(h.split("ld+json")[1].split("</script>")[0]));
  const img = await app.inject(`/og/s/${a.slug}.png`);
  assert.equal(img.statusCode, 200); assert.equal(img.headers["content-type"], "image/png");
  const buf = img.rawPayload; assert.equal(buf.readUInt32BE(16), 1200); assert.equal(buf.readUInt32BE(20), 630);
  assert.ok(readdirSync(join(dir, "og")).some((f) => f.startsWith(a.slug)));
  assert.equal((await app.inject("/og/s/nope.png")).statusCode, 404);
  const u = (await app.inject(`/u/${social.profile("u1")!.handle}`)).body;
  assert.match(u, /<h1>Alice &lt;B&gt;<\/h1>/); assert.ok(u.includes(`href="/s/${a.slug}"`)); assert.match(u, /"@type":"ProfilePage"/);
});

test("ISO 8601 durations", () => {
  assert.equal(isoDuration(4), "PT4S"); assert.equal(isoDuration(125.4), "PT2M5S"); assert.equal(isoDuration(3600), "PT1H"); assert.equal(isoDuration(0), "PT1S");
  assert.equal(durationSeconds(JSON.stringify({ durationSeconds: 61 }), "{}"), 61);
});

test("Smart App Banner app-argument is the current page URL on /s and /u, escaped", async () => {
  const { app, shares, social } = await setup();
  social.ensureProfile("u1", "Alice"); const h = social.profile("u1")!.handle;
  const pub = shares.create({ owner: "u1", title: "Song", projectJson: proj, public: true });
  const arg = (b: string) => /<meta name="apple-itunes-app" content="app-id=123, app-argument=([^"]*)"/.exec(b)?.[1];
  assert.equal(arg((await app.inject(`/s/${pub.slug}`)).body), `https://compose.test/s/${pub.slug}`);
  assert.equal(arg((await app.inject(`/s/${pub.slug}?edit=1&x=a,b`)).body), `https://compose.test/s/${pub.slug}?edit=1&amp;x=a%2Cb`);
  assert.equal(arg((await app.inject(`/u/${h}`)).body), `https://compose.test/u/${h}`);
  const evil = (await app.inject(`/s/${pub.slug}?q=%22%3E%3Cscript%3E`)).body;
  assert.ok(!/app-argument=[^"]*<script/.test(evil)); assert.equal((evil.match(/apple-itunes-app/g) ?? []).length, 1);
});

test("/s/<unknown-slug> is a 404 'Song not found' page (escaped); private songs keep the generic 200 shell", async () => {
  const { app, shares } = await setup();
  const priv = shares.create({ owner: "u1", title: "Secret", projectJson: proj, public: false });
  const r = await app.inject("/s/no-such-song-zz99");
  assert.equal(r.statusCode, 404); assert.match(r.body, /<title>Song not found · GBK Composer<\/title>/); assert.match(r.body, /<h1>Song not found<\/h1>/); assert.match(r.body, /noindex/);
  const evil = await app.inject("/s/%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  assert.equal(evil.statusCode, 404); assert.ok(!evil.body.includes("<script>alert(1)")); assert.match(evil.body, /&lt;script&gt;/);
  const p = await app.inject(`/s/${priv.slug}`); assert.equal(p.statusCode, 200); assert.ok(!p.body.includes("Secret"));
});
