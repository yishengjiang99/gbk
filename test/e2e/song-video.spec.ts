// Song video + gallery checks in plain Chrome (no flags). Sync checks run on a published song folder
// (GBK_SONG_DIR, default the seeded Midnight Invention) and need ffmpeg/ffprobe.
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { renderVideo } from "../../scripts/song.ts";
import { join } from "node:path";

const SONG = process.env.GBK_SONG_DIR ?? "songs/2026-10-23-midnight-invention";
const song = existsSync(join(SONG, "song.json")) ? JSON.parse(readFileSync(join(SONG, "song.json"), "utf8")) : null;

test("frames are deterministic: same project + time -> identical PNG bytes", async ({ page }) => {
  await page.goto("/gbk/");
  const hashes = await page.evaluate(async () => {
    const v = await import(/* @vite-ignore */ String("/gbk/src/video/piano-roll-video.ts"));
    const { emptyProject } = await import(/* @vite-ignore */ String("/gbk/src/workstation/model.ts"));
    const p = emptyProject("Det", 480);
    p.tracks = [{ id: "a", name: "Lead", channel: 0, color: "#4fc3f7", mix: { volume: 100, pan: 64, expression: 127, mute: false, solo: false }, visible: true }];
    p.notes = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, trackId: "a", channel: 0, tick: i * 240, duration: 200, pitch: 60 + (i * 7) % 12, velocity: 90 }));
    p.meta = { sections: [{ name: "Intro", startBar: 1, bars: 2 }, { name: "Main", startBar: 3, bars: 2 }] };
    const m = v.buildVideoModel(p, 12, "test");
    const a = await v.renderPngFrames(m, 0, 90, v.DEFAULT_VIDEO);
    const b = await v.renderPngFrames(m, 0, 90, v.DEFAULT_VIDEO);
    return [a.join("") === b.join(""), a.length, new Set(a).size];
  });
  expect(hashes[0]).toBe(true); expect(hashes[1]).toBe(90); expect(hashes[2]).toBeGreaterThan(80); // frames advance
});

// Separated onsets (1.0 s, 2.5 s, 4.0 s): every lit-key onset frame must match its audio onset within one frame.
for (const fps of [30, 60]) test(`A/V sync at ${fps} fps on separated note onsets (render WAV -> video -> decode both)`, async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem("gbk.agentTools", "1"));
  await page.goto("/gbk/");
  await page.waitForFunction(async () => ((await (window as any).gbkTools?.list()) ?? []).length > 40);
  await page.waitForTimeout(2500); // let any startup load settle
  const call = async (n: string, a: any) => JSON.parse(await page.evaluate(([n, a]) => (window as any).gbkTools.call(n, a), [n, a] as const) as string);
  expect((await call("gbk_create_project", { name: "Sync", tempo: 120, replaceCurrent: true })).ok).toBe(true);
  const t = await call("gbk_create_track", { name: "Piano", program: 0 });
  const patch = await call("gbk_propose_note_patch", { add: [1, 2.5, 4].map((sec) => ({ trackId: t.data.trackIds[0], tick: sec * 960, duration: 120, pitch: 72, velocity: 120 })) });
  expect(patch.ok, JSON.stringify(patch.error)).toBe(true);
  expect((await call("gbk_commit_proposal", { proposalId: patch.data.proposalId })).ok).toBe(true);
  const r = await call("gbk_render_wav", { output: "artifact", channels: 1, sampleRate: 48000, tailSeconds: 1, normalize: "peak", includeMidi: false });
  expect(r.ok && r.data.status === "completed", JSON.stringify(r.error ?? r.data.status)).toBe(true);
  const parts: Buffer[] = []; for (let off = 0; ;) { const c = await call("gbk_read_wav_bytes", { artifactId: r.data.artifactId, offset: off, length: 262144 }); parts.push(Buffer.from(c.data.base64, "base64")); if (c.data.eof) break; off = c.data.nextOffset; }
  const dir = mkdtempSync(join(tmpdir(), "gbk-sync-")); const wav = join(dir, "s.wav"), mp4 = join(dir, "s.mp4");
  writeFileSync(wav, Buffer.concat(parts));
  const project = await page.evaluate(async () => (await import(/* @vite-ignore */ String("/gbk/src/workstation/instance.ts"))).workstation.state.project);
  await renderVideo(page, project, wav, mp4, null, { fps, subtitle: "sync", duration: r.data.durationSeconds });
  const H = 86; const raw = execFileSync("ffmpeg", ["-v", "error", "-i", mp4, "-vf", `crop=60:860:10:150,scale=1:${H}:flags=neighbor`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 28 });
  const lit = Array.from({ length: raw.length / (H * 3) }, (_, f) => { for (let y = 0; y < H; y++) { const o = (f * H + y) * 3; if (Math.max(raw[o], raw[o + 1], raw[o + 2]) - Math.min(raw[o], raw[o + 1], raw[o + 2]) > 60) return true; } return false; });
  const vOn = lit.flatMap((l, f) => (l && !lit[f - 1] ? [f / fps] : []));
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", mp4, "-map", "0:a", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2); const thr = 32768 * 10 ** (-30 / 20); const aOn: number[] = []; let quiet = 48000;
  for (let i = 0; i < s.length; i++) { if (Math.abs(s[i]) > thr) { if (quiet >= 0.3 * 48000) aOn.push(i / 48000); quiet = 0; } else quiet++; }
  console.log("sync", fps, JSON.stringify({ video: vOn, audio: aOn }));
  expect(vOn.length).toBe(3); expect(aOn.length).toBe(3);
  for (let k = 0; k < 3; k++) { expect(Math.abs(vOn[k] - [1, 2.5, 4][k])).toBeLessThanOrEqual(1 / fps); expect(Math.abs(aOn[k] - vOn[k])).toBeLessThanOrEqual(1 / fps); }
});

test.describe("published song", () => {
  test.skip(!song, `no song at ${SONG}`);
  const mp4 = join(SONG, "video.mp4");
  const probe = () => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", mp4], { encoding: "utf8" }));

  test("video: 1080p, frame count/duration match the WAV within one frame, audio starts at 0", () => {
    const p = probe(); const v = p.streams.find((s: any) => s.codec_type === "video"), a = p.streams.find((s: any) => s.codec_type === "audio");
    const fps = song.video.fps;
    expect([v.width, v.height, v.codec_name, v.pix_fmt, v.r_frame_rate]).toEqual([1920, 1080, "h264", "yuv420p", `${fps}/1`]);
    expect(Number(v.nb_read_frames)).toBe(Math.ceil(song.durationSeconds * fps - 1e-9));
    expect(Math.abs(Number(v.duration) - song.durationSeconds)).toBeLessThanOrEqual(1 / fps);
    expect(Math.abs(Number(a.duration) - song.durationSeconds)).toBeLessThanOrEqual(1 / fps);
    expect(Math.abs(Number(a.start_time))).toBeLessThanOrEqual(1 / fps);
    expect(Math.abs(Number(v.start_time))).toBeLessThanOrEqual(1 / fps);
    expect(createHash("sha256").update(readFileSync(mp4)).digest("hex")).toBe(song.files.mp4.sha256);
  });

  test("A/V sync: first lit keyboard key and first audible sample land within one frame", () => {
    const fps = song.video.fps;
    // Keyboard strip (x 0..80, y 150..1010), one pixel column per frame, RGB.
    const H = 86; const raw = execFileSync("ffmpeg", ["-v", "error", "-i", mp4, "-vf", `crop=60:860:10:150,scale=1:${H}:flags=neighbor`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 28 });
    const frames = raw.length / (H * 3);
    let litFrame = -1;
    for (let f = 0; f < frames && litFrame < 0; f++) for (let y = 0; y < H; y++) { const o = (f * H + y) * 3; const r = raw[o], g = raw[o + 1], b = raw[o + 2]; if (Math.max(r, g, b) - Math.min(r, g, b) > 60) { litFrame = f; break; } }
    const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", mp4, "-map", "0:a", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
    const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
    const thr = 32768 * Math.pow(10, -50 / 20); let first = s.findIndex((x) => Math.abs(x) > thr);
    const audioSec = first / 48000, videoSec = litFrame / fps;
    console.log("sync", JSON.stringify({ litFrame, videoSec, audioSec, diffMs: (audioSec - videoSec) * 1000 }));
    expect(litFrame).toBeGreaterThanOrEqual(0); expect(first).toBeGreaterThanOrEqual(0);
    expect(Math.abs(audioSec - videoSec)).toBeLessThanOrEqual(1 / fps);
  });

  test("gallery page lists the song, plays the video, and opens it in the workstation", async ({ page }) => {
    await page.goto("/gbk/songs/index.html");
    const card = page.locator(`[data-song="${song.slug}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByRole("heading")).toHaveText(song.title);
    const dur = await card.locator("video").evaluate(async (v: HTMLVideoElement) => { v.preload = "metadata"; v.load(); await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true })); return v.duration; });
    expect(Math.abs(dur - song.durationSeconds)).toBeLessThan(0.1);
    await page.goto(`/gbk/songs/${song.slug}/index.html`);
    for (const f of ["song.mid", "song.mp3", "video.mp4"]) expect((await page.request.get(`/gbk/songs/${song.slug}/${f}`)).ok()).toBe(true);
    await page.getByTestId("open-in-workstation").click();
    await expect(page.getByTestId("workstation")).toBeVisible();
    await expect(page.locator(".ws-name")).toContainText(song.title, { timeout: 20_000 });
    await page.waitForTimeout(3000); // player startup restore must not clobber it
    await expect(page.locator(".ws-name")).toContainText(song.title);
  });
});
