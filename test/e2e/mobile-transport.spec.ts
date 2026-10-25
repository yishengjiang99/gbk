import { test, expect } from "@playwright/test";
// Phone layout: transport on its own row (Play visible without horizontal scroll), studio never scrolls vertically.
// Also exercises the in-browser "Export video" (WebCodecs/MediaRecorder) end to end on a short project.
const BASE = process.env.GBK_URL ?? "/gbk/";
const SHOTS = process.env.GBK_SHOTS ?? "/tmp";
const SEED = `async () => {
  const ws = globalThis.__gbkWorkstation;
  await ws.createProject({ name: "Export Sample", owner: "user", replaceCurrent: true });
  const ppq = ws.project.ppq;
  const scale = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60, 64];
  ws.edit([{ op: "addTrack", name: "Piano", channel: 0, id: "t_piano", program: 0 }, { op: "addTrack", name: "Bass", channel: 1, id: "t_bass", program: 32 }], { label: "seed" });
  ws.edit([{ op: "addNotes", notes: scale.map((p, i) => ({ trackId: "t_piano", channel: 0, tick: i * ppq / 2, duration: ppq / 2, pitch: p, velocity: 96 })) },
           { op: "addNotes", notes: [36, 41, 43, 36].map((p, i) => ({ trackId: "t_bass", channel: 1, tick: i * ppq * 2, duration: ppq * 2, pitch: p, velocity: 90 })) }], { label: "seed notes" });
  return ws.project.notes.length;
}`;
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, acceptDownloads: true });

test("mobile transport row: big Play visible, no vertical scroll", async ({ page }) => {
  await page.goto(BASE);
  const play = page.getByTestId("transport-row").getByRole("button", { name: "Play" });
  await expect(play).toBeVisible();
  const box = (await play.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44);
  for (const name of ["Rewind", "Stop"]) { const b = (await page.getByTestId("transport-row").getByRole("button", { name }).boundingBox())!; expect(b.height).toBeGreaterThanOrEqual(44); expect(b.x + b.width).toBeLessThanOrEqual(390); }
  const m = await page.evaluate(() => ({ sh: document.documentElement.scrollHeight, h: innerHeight, bsh: document.body.scrollHeight, sw: document.documentElement.scrollWidth, w: innerWidth }));
  expect(m.sh).toBeLessThanOrEqual(m.h); expect(m.bsh).toBeLessThanOrEqual(m.h); expect(m.sw).toBeLessThanOrEqual(m.w);
  await page.screenshot({ path: `${SHOTS}/mobile-transport.png` });
});

test("desktop keeps transport inline in the header", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(BASE);
  await expect(page.getByTestId("transport-row")).toHaveCount(0);
  await expect(page.locator(".ws-header [data-testid=ws-play]")).toBeVisible();
});

test("export video produces a playable file", async ({ page }) => {
  test.setTimeout(180_000);
  const dialogs: string[] = []; page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  page.on("console", (m) => { if (m.type() === "error") console.log("console:", m.text()); });
  await page.goto(BASE);
  await page.waitForFunction(() => !!(globalThis as { __gbkWorkstation?: unknown }).__gbkWorkstation);
  // Short 2-track project (6 s) so the export is quick.
  expect(await page.evaluate(`(${SEED})()`)).toBe(20);
  const dl = page.waitForEvent("download", { timeout: 170_000 });
  await page.getByTestId("tab-files").click();
  await page.locator(".ws-tabbody [data-testid=export-video]").click();
  const d = await Promise.race([dl, page.waitForEvent("dialog").then(() => { throw new Error(`export failed: ${dialogs.join(" | ")}`); })]);
  const path = `${SHOTS}/export-e2e.${d.suggestedFilename().split(".").pop()}`;
  await d.saveAs(path);
  expect(d.suggestedFilename()).toMatch(/\.(mp4|webm)$/);
});
