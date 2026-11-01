// Real ffmpeg render + ffprobe codec checks for /og/s/<slug>.mp4. Requires ffmpeg and ffprobe on PATH and
// FAILS (does not skip) without them. CI installs ffmpeg for this step (.github/workflows/test.yml).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { ShareStore } from "../../src/persistence/shares.ts";
import { SocialStore } from "../../src/persistence/social.ts";
import { seoRoutes } from "../../src/routes/seo.ts";
import type { Config } from "../../src/config.ts";

const SHELL = `<!doctype html><html><head><title>G</title><meta name="description" content="g" /><meta property="og:type" content="website" /><meta property="og:title" content="g" /><meta property="og:description" content="g" /></head><body><div id="root"></div></body></html>`;
const proj = JSON.stringify({ name: "x", tracks: [] });
const MP3 = readFileSync(fileURLToPath(new URL("../fixtures/og-video/tiny.mp3", import.meta.url)));

test("ffmpeg renders an iMessage-playable MP4: H.264 main yuv420p 1200x630 + AAC, faststart", async () => {
  for (const bin of ["ffmpeg", "ffprobe"]) assert.equal(spawnSync(bin, ["-version"]).status, 0, `${bin} must be installed on PATH for this integration test`);
  const shares = new ShareStore(":memory:"); new SocialStore(shares.database);
  const dir = mkdtempSync(join(tmpdir(), "ogv-int-")), shellFile = join(dir, "index.html"); writeFileSync(shellFile, SHELL);
  const app = Fastify(); seoRoutes(app, { publicOrigin: "https://compose.test" } as Config, shares.database, { shellFile, ogDir: join(dir, "og"), ogVideo: true });
  await app.ready();
  const s = shares.create({ owner: "u1", title: "Song", projectJson: proj, public: true });
  shares.setMedia(s.slug, "mp3", MP3);
  const r = await app.inject(`/og/s/${s.slug}.mp4`);
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.headers["content-type"], "video/mp4");
  assert.equal(r.rawPayload.subarray(4, 8).toString(), "ftyp"); assert.ok(r.rawPayload.indexOf("moov") < r.rawPayload.indexOf("mdat"), "+faststart");
  const file = join(dir, "og", readdirSync(join(dir, "og")).find((f) => f.endsWith(".mp4"))!);
  const streams = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], { encoding: "utf8" })).streams as { codec_type: string; codec_name: string; pix_fmt?: string; profile?: string; width?: number; height?: number }[];
  const v = streams.find((x) => x.codec_type === "video")!, a = streams.find((x) => x.codec_type === "audio")!;
  assert.equal(v.codec_name, "h264"); assert.equal(v.pix_fmt, "yuv420p"); assert.match(v.profile!, /^(Main|Constrained Baseline|Baseline)$/);
  assert.equal(v.width, 1200); assert.equal(v.height, 630); assert.equal(a.codec_name, "aac");
});
