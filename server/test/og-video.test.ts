// og:video for iMessage: meta tags (and the off switch), the MP4 route, caching and dedup, and slug guards.
// ffmpeg is stubbed (fixtures/og-video/fake-ffmpeg.mjs copies a checked-in MP4); the real render and codec
// checks live in server/test/integration/og-video-render.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { ShareStore } from "../src/persistence/shares.ts";
import { SocialStore } from "../src/persistence/social.ts";
import { seoRoutes } from "../src/routes/seo.ts";
import { RateLimiter } from "../src/security/rate-limit.ts";
import type { Config } from "../src/config.ts";
import { frameTimes, mp3Duration, OGV_FPS, OGV_MAX_SEC, OGV_PAL, rollFrame, rollFrameSvg } from "../src/og-video.ts";
import { VIZ } from "../../src/components/social/viz-constants.ts";
import type { PianoRollPreview } from "../../src/agent/piano-roll-preview.ts";

const SHELL = `<!doctype html><html><head><title>G</title><meta name="description" content="g" /><meta property="og:type" content="website" /><meta property="og:title" content="g" /><meta property="og:description" content="g" /></head><body><div id="root"></div></body></html>`;
const proj = JSON.stringify({ name: "x", tracks: [] });
const FIX = fileURLToPath(new URL("./fixtures/og-video/", import.meta.url));
const FAKE = join(FIX, "fake-ffmpeg.mjs"), MP3 = readFileSync(join(FIX, "tiny.mp3")), MP4 = readFileSync(join(FIX, "tiny.mp4"));

async function setup(o: { ogVideo?: boolean; limiter?: RateLimiter } = {}) {
  const shares = new ShareStore(":memory:"); new SocialStore(shares.database);
  const dir = mkdtempSync(join(tmpdir(), "ogv-")), shellFile = join(dir, "index.html"); writeFileSync(shellFile, SHELL);
  const log = join(dir, "ffmpeg.log"); writeFileSync(log, ""); process.env.FAKE_FFMPEG_LOG = log;
  const app = Fastify();
  seoRoutes(app, { publicOrigin: "https://compose.test" } as Config, shares.database, { shellFile, ogDir: join(dir, "og"), ogVideo: o.ogVideo ?? true, videoLimiter: o.limiter, ffmpeg: FAKE });
  await app.ready();
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
  return { app, shares, og: join(dir, "og"), calls };
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

test("mp4 route serves video/mp4 from one render, caches it, dedups concurrent requests and re-renders on new audio", async () => {
  const { app, shares, og, calls } = await setup();
  const s = shares.create({ owner: "u1", title: "Song", projectJson: proj, public: true });
  shares.setMedia(s.slug, "mp3", MP3);
  const mp4s = () => readdirSync(og).filter((f) => f.endsWith(".mp4"));
  const [a, b] = await Promise.all([app.inject(`/og/s/${s.slug}.mp4`), app.inject(`/og/s/${s.slug}.mp4`)]);
  assert.equal(a.statusCode, 200); assert.equal(a.headers["content-type"], "video/mp4"); assert.equal(a.headers["accept-ranges"], "bytes");
  assert.deepEqual(a.rawPayload, MP4); assert.deepEqual(b.rawPayload, MP4);
  assert.equal(calls().length, 1, "one render for concurrent requests"); assert.equal(mp4s().length, 1);
  assert.ok(!readdirSync(og).some((f) => f.endsWith(".tmp.mp4") || f.endsWith(".mp3")), "no temp files left");
  const args = calls()[0];
  for (const [flag, val] of [["-c:v", "libx264"], ["-pix_fmt", "yuv420p"], ["-profile:v", "main"], ["-c:a", "aac"], ["-movflags", "+faststart"]]) assert.equal(args[args.lastIndexOf(flag) + 1], val, flag);
  const part = await app.inject({ url: `/og/s/${s.slug}.mp4`, headers: { range: "bytes=0-99" } });
  assert.equal(part.statusCode, 206); assert.deepEqual(part.rawPayload, MP4.subarray(0, 100)); assert.equal(part.headers["content-range"], `bytes 0-99/${MP4.length}`);
  assert.equal((await app.inject({ url: `/og/s/${s.slug}.mp4`, headers: { range: `bytes=${MP4.length}-` } })).statusCode, 416);
  const mtime = statSync(join(og, mp4s()[0])).mtimeMs;
  assert.equal(calls().length, 1, "served from cache"); assert.equal(statSync(join(og, mp4s()[0])).mtimeMs, mtime);
  shares.setMedia(s.slug, "mp3", Buffer.concat([MP3, MP3]));
  assert.equal((await app.inject(`/og/s/${s.slug}.mp4`)).statusCode, 200); assert.equal(calls().length, 2, "new audio → new render"); assert.equal(mp4s().length, 2);
});

test("a failed render returns 503 and leaves nothing cached", async () => {
  const { app, shares, og } = await setup();
  const s = shares.create({ owner: "u1", title: "Song", projectJson: proj, public: true });
  shares.setMedia(s.slug, "mp3", MP3);
  process.env.FAKE_FFMPEG_FAIL = "1";
  try { assert.equal((await app.inject(`/og/s/${s.slug}.mp4`)).statusCode, 503); } finally { delete process.env.FAKE_FFMPEG_FAIL; }
  assert.ok(!readdirSync(og).some((f) => f.includes(".mp4") || f.endsWith(".mp3")));
});

test("mp4 route is rate limited per IP", async () => {
  const { app, shares } = await setup({ limiter: new RateLimiter(1) });
  const s = shares.create({ owner: "u1", title: "Song", projectJson: proj, public: true });
  shares.setMedia(s.slug, "mp3", MP3);
  await app.inject(`/og/s/${s.slug}.mp4`);
  const r = await app.inject(`/og/s/${s.slug}.mp4`);
  assert.equal(r.statusCode, 429); assert.ok(r.headers["retry-after"]);
});

// Pure frame/geometry logic (no ffmpeg).
const PV: PianoRollPreview = { tracks: ["#e5396b", "#2d6a93"], lo: 60, hi: 72, end: 1000, notes: [[0, 0, 100, 60], [1, 250, 100, 64], [0, 500, 100, 67], [1, 900, 100, 72]] };

test("roll frame: notes scroll left past a fixed playhead as time advances", () => {
  const a = rollFrame(PV, 0, 10, 1200, 510), b = rollFrame(PV, 2, 10, 1200, 510);
  assert.equal(a.playheadX, 1200 * VIZ.playheadFrac); assert.equal(b.playheadX, a.playheadX, "playhead fixed");
  const pps = 1200 / VIZ.windowSec, first = (f: typeof a) => f.notes.find((n) => n.fill.includes("rgb") || n.fill === "#e5396b")!;
  assert.equal(first(a).x, a.playheadX, "note at t=0 starts on the playhead");
  const x64 = (f: typeof a) => f.notes.find((n) => n.fill.startsWith("#2d6a93") || n.fill.startsWith("rgb(1"))!;
  assert.ok(Math.abs(x64(a).x - x64(b).x - 2 * pps) < 1e-6, "scrolls windowSec-relative pixels per second");
  assert.ok(a.notes.length < PV.notes.length, "only the visible window is drawn");
  assert.notEqual(rollFrameSvg(PV, 0, 10), rollFrameSvg(PV, 1, 10));
});

test("roll frame: active note is lightened with a playhead outline; past notes are faded", () => {
  const f = rollFrame(PV, 0.5, 10);
  const on = f.notes.filter((n) => n.stroke === OGV_PAL.head); assert.equal(on.length, 1); assert.match(on[0].fill, /^rgb\(/); assert.equal(on[0].opacity, 1);
  const g = rollFrame(PV, 1.5, 10); assert.ok(g.notes.some((n) => n.opacity === VIZ.pastAlpha));
  assert.ok(g.rows.every((r) => r.fill === OGV_PAL.row && r.y >= 0 && r.y < 630));
  assert.equal(OGV_PAL.bg, "#f8fcff", "bright feed-card theme");
});

test("frame times: 10 fps, at least one frame for tiny audio, capped duration", () => {
  assert.equal(OGV_FPS, 10); assert.equal(frameTimes(0.05).length, 1); assert.equal(frameTimes(1).length, 10);
  assert.equal(frameTimes(1).at(-1), 0.9); assert.equal(frameTimes(10_000).length, OGV_MAX_SEC * OGV_FPS);
});

test("mp3 duration parses frame headers without ffmpeg", () => {
  const d = mp3Duration(MP3); assert.ok(d > 0 && d < 2, String(d));
  assert.equal(mp3Duration(new Uint8Array([1, 2, 3])), 0);
});
