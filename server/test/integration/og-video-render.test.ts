// Real ffmpeg render + ffprobe codec checks for /og/s/<slug>.mp4. Requires ffmpeg and ffprobe on PATH and
// FAILS (does not skip) without them. CI installs ffmpeg for this step (.github/workflows/test.yml).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { ShareStore } from "../../src/persistence/shares.ts";
import { SocialStore } from "../../src/persistence/social.ts";
import { seoRoutes } from "../../src/routes/seo.ts";
import type { Config } from "../../src/config.ts";

const SHELL = `<!doctype html><html><head><title>G</title><meta name="description" content="g" /><meta property="og:type" content="website" /><meta property="og:title" content="g" /><meta property="og:description" content="g" /></head><body><div id="root"></div></body></html>`;
const proj = JSON.stringify({ name: "x", tracks: [{ id: "t1", color: "#e5396b" }, { id: "t2", color: "#2d6a93" }],
  notes: Array.from({ length: 64 }, (_, i) => ({ trackId: i % 2 ? "t2" : "t1", tick: i * 120, duration: 100, pitch: 60 + ((i * 5) % 19) })) });
const MP3 = readFileSync(fileURLToPath(new URL("../fixtures/og-video/tiny.mp3", import.meta.url)));

test("ffmpeg renders an iMessage-playable MP4: H.264 main yuv420p 1200x630 + AAC, faststart", async () => {
  for (const bin of ["ffmpeg", "ffprobe"]) assert.equal(spawnSync(bin, ["-version"]).status, 0, `${bin} must be installed on PATH for this integration test`);
  const shares = new ShareStore(":memory:"); new SocialStore(shares.database);
  const dir = mkdtempSync(join(tmpdir(), "ogv-int-")), shellFile = join(dir, "index.html"); writeFileSync(shellFile, SHELL);
  const app = Fastify(); seoRoutes(app, { publicOrigin: "https://compose.test" } as Config, shares.database, { shellFile, ogDir: join(dir, "og"), ogVideo: true });
  await app.ready();
  const s = shares.create({ owner: "u1", title: "Song", projectJson: proj, public: true });
  shares.setMedia(s.slug, "mp3", MP3); // ~0.1 s: must still yield a video track
  assert.equal((await app.inject(`/og/s/${s.slug}.mp4`)).statusCode, 200);
  // A 3 s song for codec + motion checks.
  const long = execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libmp3lame", "-b:a", "64k", "-f", "mp3", "-"]);
  shares.setMedia(s.slug, "mp3", long);
  const r = await app.inject(`/og/s/${s.slug}.mp4`);
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.headers["content-type"], "video/mp4");
  assert.equal(r.rawPayload.subarray(4, 8).toString(), "ftyp"); assert.ok(r.rawPayload.indexOf("moov") < r.rawPayload.indexOf("mdat"), "+faststart");
  const file = join(dir, "og", readdirSync(join(dir, "og")).filter((f) => f.endsWith(".mp4")).map((f) => ({ f, t: statSync(join(dir, "og", f)).mtimeMs })).sort((a, b) => b.t - a.t)[0].f);
  const streams = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], { encoding: "utf8" })).streams as { codec_type: string; codec_name: string; pix_fmt?: string; profile?: string; width?: number; height?: number }[];
  const v = streams.find((x) => x.codec_type === "video")!, a = streams.find((x) => x.codec_type === "audio")!;
  assert.equal(v.codec_name, "h264"); assert.equal(v.pix_fmt, "yuv420p"); assert.match(v.profile!, /^(Main|Constrained Baseline|Baseline)$/);
  assert.equal(v.width, 1200); assert.equal(v.height, 630); assert.equal(a.codec_name, "aac");
  // Motion: the roll scrolls, so the first and a later frame differ (in the roll area).
  const frame = (ss: string) => execFileSync("ffmpeg", ["-v", "error", "-ss", ss, "-i", file, "-frames:v", "1", "-vf", "crop=1200:510:0:120", "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 24 });
  const f0 = frame("0"), f1 = frame("2");
  assert.equal(f0.length, 1200 * 510); assert.equal(f1.length, f0.length);
  let diff = 0; for (let i = 0; i < f0.length; i++) if (Math.abs(f0[i] - f1[i]) > 16) diff++;
  assert.ok(diff > 2000, `roll should move between frames (changed px: ${diff})`);
  const fps = streams as unknown as { codec_type: string; r_frame_rate?: string }[]; assert.equal(fps.find((x) => x.codec_type === "video")!.r_frame_rate, "10/1");
  if (process.env.OGV_SAMPLE_DIR) { const { copyFileSync } = await import("node:fs"); copyFileSync(file, join(process.env.OGV_SAMPLE_DIR, "sample.mp4")); }
});
