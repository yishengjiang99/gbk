// /studio?new=<n> (iOS app Create): skip the autosave restore, start blank, strip the param; plain /studio still restores.
import { test, expect, type Page } from "@playwright/test";
const NAME = "StudioNew E2E";
const ws = (page: Page) => page.waitForFunction(() => !!(globalThis as any).__gbkWorkstation);
const name = (page: Page) => page.evaluate(() => (globalThis as any).__gbkWorkstation.project.name as string);

test("/studio?new=1 starts blank and strips the param; plain /studio restores the autosave", async ({ page }) => {
  await page.goto("studio"); await ws(page);
  await page.evaluate(async (n) => { const c = (globalThis as any).__gbkWorkstation;
    await c.createProject({ name: n, owner: "user", replaceCurrent: true });
    c.edit([{ op: "addTrack", name: "Melody", channel: 0, id: "t_mel", program: 0 },
      { op: "addNotes", notes: [{ trackId: "t_mel", channel: 0, tick: 0, duration: 440, pitch: 60, velocity: 90 }] }], { label: "seed" }); }, NAME);
  await page.waitForTimeout(1500); // autosave debounce (800 ms)

  await page.goto("studio"); await ws(page);
  await expect.poll(() => name(page)).toBe(NAME);

  await page.goto("studio?new=1&x=2#h"); await ws(page);
  if (process.env.PW_BASE_URL) await expect(page.getByTestId("composer-input")).toBeVisible(); // needs the Composer server (prod)
  const u = new URL(page.url()); expect(u.searchParams.has("new")).toBe(false); expect(u.searchParams.get("x")).toBe("2"); expect(u.hash).toBe("#h");
  await page.waitForTimeout(1500);
  expect(await name(page)).not.toBe(NAME);
  expect(await page.evaluate(() => (globalThis as any).__gbkWorkstation.project.notes.length)).toBe(0);

  await page.reload(); await ws(page); // param gone, so a reload restores again
  await expect.poll(() => name(page)).toBe(NAME);
});
