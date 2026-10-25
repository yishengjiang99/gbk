import { test, expect } from "@playwright/test";
// Play stays disabled (with download %) until the SoundFont is downloaded+parsed; the content-hashed font is cached so a
// second visit never re-downloads it.
const BASE = process.env.GBK_URL ?? "/gbk/";

test("Play waits for the SoundFont, and a reload serves it from cache", async ({ page }) => {
  test.setTimeout(180_000);
  const sfReqs: string[] = [];
  page.on("request", (r) => { if (/\/static\/sf\/.+\.sf2/.test(r.url())) sfReqs.push(r.url()); });
  await page.goto(BASE);
  await page.waitForFunction(() => !!(globalThis as any).__gbkWorkstation);
  const t0 = Date.now();
  await expect(page.getByTestId("ws-play").first()).toBeEnabled({ timeout: 150_000 });
  const firstMs = Date.now() - t0;
  expect(await page.evaluate(() => (window as any).__gbkWorkstation.state.transport.audioReady)).toBe(true);
  expect(sfReqs.length).toBeGreaterThan(0);
  expect(await page.evaluate(async () => (await (await caches.open("gbk-soundfonts-v1")).keys()).length)).toBeGreaterThan(0);
  const before = sfReqs.length;
  await page.reload();
  await page.waitForFunction(() => !!(globalThis as any).__gbkWorkstation);
  const t1 = Date.now();
  await expect(page.getByTestId("ws-play").first()).toBeEnabled({ timeout: 60_000 });
  console.log("soundfont-cache", JSON.stringify({ firstMs, secondMs: Date.now() - t1, networkRequestsOnReload: sfReqs.length - before }));
  expect(sfReqs.length - before).toBe(0);
});
