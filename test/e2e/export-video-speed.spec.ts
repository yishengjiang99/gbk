import { studioReveal } from "./app-menu";
import { test, expect } from "@playwright/test";
// Export video must render faster than real time: ~38 s song -> OfflineAudioContext mix + WebCodecs frames, no wall-clock pacing.
const BASE = process.env.GBK_URL ?? "/gbk/";
const SHOTS = process.env.GBK_SHOTS ?? "/tmp";
const SEED = `async () => {
  const ws = globalThis.__gbkWorkstation;
  await ws.createProject({ name: "Export Speed", owner: "user", replaceCurrent: true });
  const ppq = ws.project.ppq;
  const scale = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60, 64];
  ws.edit([{ op: "addTrack", name: "Piano", channel: 0, id: "t_piano", program: 0 }, { op: "addTrack", name: "Bass", channel: 1, id: "t_bass", program: 32 }], { label: "seed" });
  const beats = 72; // 36 s at 120 bpm (+2 s render tail = 38 s)
  ws.edit([{ op: "addNotes", notes: Array.from({ length: beats * 2 }, (_, i) => ({ trackId: "t_piano", channel: 0, tick: i * ppq / 2, duration: ppq / 2, pitch: scale[i % 16], velocity: 96 })) },
           { op: "addNotes", notes: Array.from({ length: beats / 2 }, (_, i) => ({ trackId: "t_bass", channel: 1, tick: i * ppq * 2, duration: ppq * 2, pitch: [36, 41, 43, 36][i % 4], velocity: 90 })) }], { label: "seed notes" });
  return ws.project.tempo ?? 120;
}`;
test.use({ acceptDownloads: true });

test("export video of a ~38 s song finishes much faster than real time", async ({ page }) => {
  test.setTimeout(180_000);
  const dialogs: string[] = []; page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  page.on("console", (m) => { if (m.text().startsWith("[export-video]")) console.log(m.text()); });
  await page.goto(BASE);
  await page.waitForFunction(() => !!(globalThis as { __gbkWorkstation?: unknown }).__gbkWorkstation);
  await page.evaluate(`(${SEED})()`);
  await (await studioReveal(page, "tab-files")).click();
  const dl = page.waitForEvent("download", { timeout: 170_000 });
  const t0 = Date.now();
  await page.locator(".ws-tabbody [data-testid=export-video]").click();
  const d = await Promise.race([dl, page.waitForEvent("dialog").then(() => { throw new Error(`export failed: ${dialogs.join(" | ")}`); })]);
  const ms = Date.now() - t0;
  const path = `${SHOTS}/export-speed.${d.suggestedFilename().split(".").pop()}`;
  await d.saveAs(path);
  console.log("export-video-speed", JSON.stringify({ ms, file: path }));
  expect(d.suggestedFilename()).toMatch(/\.mp4$/);
  expect(ms).toBeLessThan(20_000); // real-time would be >= 38 s
});

test("Safari-like browser without AudioEncoder still exports fast (H.264 + PCM .mov, no MediaRecorder)", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => { const w = window as any; delete w.AudioEncoder; delete w.AudioData; w.MediaRecorder = undefined; });
  const dialogs: string[] = []; page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  page.on("console", (m) => { if (m.text().startsWith("[export-video]")) console.log(m.text()); });
  await page.goto(BASE);
  await page.waitForFunction(() => !!(globalThis as { __gbkWorkstation?: unknown }).__gbkWorkstation);
  await page.evaluate(`(${SEED})()`);
  await (await studioReveal(page, "tab-files")).click();
  const dl = page.waitForEvent("download", { timeout: 170_000 });
  const t0 = Date.now();
  await page.locator(".ws-tabbody [data-testid=export-video]").click();
  const d = await Promise.race([dl, page.waitForEvent("dialog").then(() => { throw new Error(`export failed: ${dialogs.join(" | ")}`); })]);
  const ms = Date.now() - t0;
  const path = `${SHOTS}/export-speed-pcm.${d.suggestedFilename().split(".").pop()}`;
  await d.saveAs(path);
  console.log("export-video-speed-pcm", JSON.stringify({ ms, file: path }));
  expect(d.suggestedFilename()).toMatch(/\.mov$/);
  expect(ms).toBeLessThan(20_000);
});
