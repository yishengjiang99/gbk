// og:video for iMessage: meta tags (and the off switch), the MP4 route's codecs, caching and dedup, and slug guards.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { ShareStore } from "../src/persistence/shares.ts";
import { SocialStore } from "../src/persistence/social.ts";
import { seoRoutes } from "../src/routes/seo.ts";
import { RateLimiter } from "../src/security/rate-limit.ts";
import type { Config } from "../src/config.ts";

const SHELL = `<!doctype html><html><head><title>G</title><meta name="description" content="g" /><meta property="og:type" content="website" /><meta property="og:title" content="g" /><meta property="og:description" content="g" /></head><body><div id="root"></div></body></html>`;
const has = (bin: string) => spawnSync(bin, ["-version"]).status === 0;
const FFMPEG = has("ffmpeg"), FFPROBE = has("ffprobe");
const proj = JSON.stringify({ name: "x", tracks: [] });

function mp3(freq: number): Uint8Array {
  const d = mkdtempSync(join(tmpdir(), "ogv-mp3-")), f = join(d, "a.mp3");
  execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=1`, "-c:a", "libmp3lame", f]);
  return readFileSync(f);
}

async function setup(o: { ogVideo?: boolean; limiter?: RateLimiter } = {}) {
  const shares = new ShareStore(":memory:"); new SocialStore(shares.database);
  const dir = mkdtempSync(join(tmpdir(), "ogv-")), shellFile = join(dir, "index.html"); writeFileSync(shellFile, SHELL);
  const app = Fastify();
  seoRoutes(app, { publicOrigin: "https://compose.test" } as Config, shares.database, { shellFile, ogDir: join(dir, "og"), ogVideo: o.ogVideo ?? true, videoLimiter: o.limiter });
  await app.ready(); return { app, shares, og: join(dir, "og") };
}

test("song page carries og:video tags (keeping og:image and og:audio); absent when switched off or no audio", async () => {
  for (const on of [true, false]) {
    const { app, shares } = await setup({ ogVideo: on });
    const s = shares.create({ owner: "u1", title: "Song", projectJson: proj, public: true });
    assert.ok(!(await app.inject(`/s/${s.slug}`)).body.includes("og:video"), "no mp3 → no video");
    shares.setMedia(s.slug, "mp3", new Uint8Array([0x49, 0x44, 0x33, 0, 0]));
    const h = (await app.inject(`/s/${s.slug}`)).body, v = `https://compose.test/og/s/${s.slug}.mp4`;
    assert.match(h, /og:image" content=/); assert.match(h, /og:audio" content=/);
    for (const tag of [`og:video" content="${v}"`, `og:video:secure_url" content="${v}"`, `og:video:type" content="video/mp4"`, `og:video:width" content="1200"`, `og:video:height" content="630"`])
      assert.equal(h.includes(tag), on, tag);
    if (!on) assert.equal((await app.inject(`/og/s/${s.slug}.mp4`)).statusCode, 404);
  }
});

test("mp4 route rejects bad slugs, traversal, private songs and songs without audio", async () => {
  const { app, shares } = await setup();
  const priv = shares.create({ owner: "u1", title: "P", projectJson: proj, public: false });
  const noAudio = shares.create({ owner: "u1", title: "N", projectJson: proj, public: true });
  for (const u of ["/og/s/..%2F..%2Fetc%2Fpasswd.mp4", "/og/s/a.b.mp4", "/og/s/%2e%2e.mp4", `/og/s/${priv.slug}.mp4`, `/og/s/${noAudio.slug}.mp4`, "/og/s/nope.mp4"])
    assert.equal((await app.inject(u)).statusCode, 404, u);
});

test("mp4 route renders H.264/AAC video/mp4 once, caches it, dedups concurrent renders and re-renders on new audio", { skip: !FFMPEG && "ffmpeg not installed" }, async (t) => {
  const { app, shares, og } = await setup();
  const s = shares.create({ owner: "u1", title: "Song", projectJson: proj, public: true });
  shares.setMedia(s.slug, "mp3", mp3(440));
  const mp4s = () => readdirSync(og).filter((f) => f.endsWith(".mp4"));
  const [a, b] = await Promise.all([app.inject(`/og/s/${s.slug}.mp4`), app.inject(`/og/s/${s.slug}.mp4`)]);
  assert.equal(a.statusCode, 200); assert.equal(a.headers["content-type"], "video/mp4"); assert.equal(a.headers["accept-ranges"], "bytes");
  assert.deepEqual(a.rawPayload, b.rawPayload); assert.equal(mp4s().length, 1, "one render for concurrent requests");
  assert.ok(!readdirSync(og).some((f) => f.endsWith(".tmp.mp4") || f.endsWith(".mp3")), "no temp files left");
  const file = join(og, mp4s()[0]), mtime = statSync(file).mtimeMs;
  assert.equal(a.rawPayload.subarray(4, 8).toString(), "ftyp");
  // +faststart: moov precedes mdat.
  assert.ok(a.rawPayload.indexOf("moov") < a.rawPayload.indexOf("mdat"));
  const part = await app.inject({ url: `/og/s/${s.slug}.mp4`, headers: { range: "bytes=0-99" } });
  assert.equal(part.statusCode, 206); assert.equal(part.rawPayload.length, 100); assert.equal(part.headers["content-range"], `bytes 0-99/${a.rawPayload.length}`);
  assert.equal(statSync(file).mtimeMs, mtime, "served from cache");
  shares.setMedia(s.slug, "mp3", mp3(660));
  assert.equal((await app.inject(`/og/s/${s.slug}.mp4`)).statusCode, 200); assert.equal(mp4s().length, 2, "new audio → new render");
  if (!FFPROBE) { t.skip("ffprobe not installed: codec assertions skipped"); return; }
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], { encoding: "utf8" })).streams as { codec_type: string; codec_name: string; pix_fmt?: string; profile?: string; width?: number; height?: number }[];
  const v = probe.find((x) => x.codec_type === "video")!, au = probe.find((x) => x.codec_type === "audio")!;
  assert.equal(v.codec_name, "h264"); assert.equal(v.pix_fmt, "yuv420p"); assert.match(v.profile!, /^(Main|Constrained Baseline|Baseline)$/);
  assert.equal(v.width, 1200); assert.equal(v.height, 630); assert.equal(au.codec_name, "aac");
});

test("mp4 route is rate limited per IP", async () => {
  const { app, shares } = await setup({ limiter: new RateLimiter(1) });
  const s = shares.create({ owner: "u1", title: "Song", projectJson: proj, public: true });
  shares.setMedia(s.slug, "mp3", new Uint8Array([0x49, 0x44, 0x33, 0, 0]));
  await app.inject(`/og/s/${s.slug}.mp4`); // first request consumes the window (render of a junk mp3 may 503)
  const r = await app.inject(`/og/s/${s.slug}.mp4`);
  assert.equal(r.statusCode, 429); assert.ok(r.headers["retry-after"]);
});
