import { studioReveal } from "./app-menu";
import { test, expect, type Page } from "@playwright/test";
import { emptyProject } from "../../src/workstation/model.ts";
import { serializeSmf } from "../../src/workstation/smf.ts";

const BASE = process.env.GBK_URL ?? "/gbk/";
const FOLLOW_SEC = Number(process.env.GBK_FOLLOW_SEC ?? 8);

function denseMidi(): Buffer {
  const p = emptyProject("dense", 480);
  for (let t = 0; t < 16; t++) p.tracks.push({ id: `t${t}`, name: `T${t}`, channel: t === 9 ? 10 : t, color: "#fff", visible: true, mix: { volume: 100, pan: 64, expression: 127, mute: false, solo: false } });
  let k = 0;
  for (let t = 0; t < 16; t++) for (let i = 0; i < 4000; i++) p.notes.push({ id: `n${k++}`, trackId: `t${t}`, channel: t === 9 ? 10 : t, tick: i * 120, duration: 110, pitch: 40 + ((i * 7 + t * 3) % 48), velocity: 60 });
  for (let i = 0; i < 4000; i++) p.ccs.push({ id: `c${i}`, trackId: "t0", channel: 0, controller: 11, tick: i * 120, value: 40 + (i % 80) });
  p.endTick = 4000 * 120;
  return Buffer.from(serializeSmf(p)); // 64k notes, ~8 min at 120 bpm
}
const roll = (p: Page) => p.locator(".ws-roll");
async function cursorInView(p: Page) {
  const pos = Number(await p.getByTestId("ws-pos").getAttribute("data-pos-tick"));
  const s = Number(await roll(p).getAttribute("data-scroll-tick")), v = Number(await roll(p).getAttribute("data-visible-ticks"));
  return { pos, s, v, ok: pos >= s && pos <= s + v };
}

test("follow-scroll keeps the cursor in view on a dense song with low frame time; manual scroll pauses follow", async ({ page }) => {
  test.setTimeout(180_000); page.setDefaultTimeout(30_000);
  await page.goto(BASE);
  await (await studioReveal(page, "open-player")).click();
  await page.locator('input[type=file][accept=".mid,.midi"]').first().setInputFiles({ name: "dense.mid", mimeType: "audio/midi", buffer: denseMidi() });
  await page.getByTestId("close-player").dispatchEvent("click");
  await expect(page.locator(".ws-name")).toContainText("dense");
  const v0 = Number(await roll(page).getAttribute("data-visible-ticks"));
  expect(v0).toBeLessThan(480 * 4 * 8); // default zoom shows a few bars, not the whole song
  await page.getByTestId("ws-play").click();
  await expect.poll(async () => Number(await page.getByTestId("ws-pos").getAttribute("data-pos-tick")), { timeout: 90_000 }).toBeGreaterThan(v0);
  // Frame times over the follow window
  const frames: number[] = await page.evaluate((sec) => new Promise((res) => { const d: number[] = []; let last = performance.now(); const end = last + sec * 1000; const f = (t: number) => { d.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else res(d); }; requestAnimationFrame(f); }), FOLLOW_SEC);
  frames.sort((a, b) => a - b);
  const p95 = frames[Math.floor(frames.length * 0.95)];
  console.log(`frames=${frames.length} median=${frames[frames.length >> 1].toFixed(1)}ms p95=${p95.toFixed(1)}ms`);
  expect(p95).toBeLessThan(50);
  const c = await cursorInView(page); console.log("cursor", JSON.stringify(c));
  expect(c.ok).toBe(true); expect(c.s).toBeGreaterThan(0);
  if (process.env.GBK_SHOT) await page.screenshot({ path: process.env.GBK_SHOT });
  // Manual horizontal scroll pauses follow
  await roll(page).locator("canvas").hover();
  await page.mouse.wheel(0, 0); await page.keyboard.down("Shift"); await page.mouse.wheel(0, -4000); await page.keyboard.up("Shift");
  await expect(page.getByTestId("follow-toggle")).not.toBeChecked();
  // Re-enable follow -> cursor back in view
  await (await studioReveal(page, "follow-toggle")).check();
  await expect.poll(async () => (await cursorInView(page)).ok, { timeout: 5000 }).toBe(true);
});
