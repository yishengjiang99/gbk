// #168 batched approval: proposals from one agent run collapse into one change set with a single
// Accept all / Reject all (plus A/B preview and a combined overlay). Desktop grid + iPhone WebKit.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
const SHOTS = process.env.GBK_SHOTS ?? "/workspace/shots/pr168";
mkdirSync(SHOTS, { recursive: true });

/** A user-owned song plus three agent proposals from one run (the third label carries markup: it must render as text). */
const seed = (page: Page) => page.evaluate(async () => { const c = (globalThis as any).__gbkWorkstation;
  await c.createProject({ name: "Batch approval E2E", owner: "user", replaceCurrent: true });
  c.edit([{ op: "addTrack", name: "Melody", channel: 0, id: "t_mel", program: 0 }, { op: "addTrack", name: "Bass", channel: 1, id: "t_bass", program: 33 },
    { op: "addNotes", notes: [72, 74, 76, 79, 77, 76, 74, 72].map((p, i) => ({ trackId: "t_mel", channel: 0, tick: i * 480, duration: 440, pitch: p, velocity: 90 })) }], { label: "seed" });
  c.setActiveRun("run_e2e");
  c.propose([{ op: "addNotes", notes: [36, 43, 45, 40].map((p, i) => ({ trackId: "t_bass", channel: 1, tick: i * 960, duration: 900, pitch: p, velocity: 100 })) }], { source: "agent", summary: "Add a bass line under bars 1-2" });
  c.propose([{ op: "updateNotes", updates: c.project.notes.filter((n: any) => n.trackId === "t_mel").slice(0, 4).map((n: any) => ({ id: n.id, velocity: 112 })) }], { source: "agent", summary: "Accent the opening phrase" });
  c.propose([{ op: "updateTrack", trackId: "t_mel", mix: { volume: 110 } }], { source: "agent", summary: "<img src=x onerror=alert(1)> Bring the melody forward" });
  c.setActiveRun(null);
  dispatchEvent(new CustomEvent("gbk-approval-request")); // opens the agent panel (desktop side panel / mobile Agent tab)
  return c.project.revision as number;
});
const state = (page: Page) => page.evaluate(() => { const c = (globalThis as any).__gbkWorkstation;
  return { rev: c.project.revision as number, notes: c.project.notes.length as number, statuses: c.getState().proposals.map((p: any) => p.status) as string[] }; });
const overflow = (page: Page) => page.evaluate(() => { const d = document.scrollingElement!; return { v: d.scrollHeight - innerHeight, h: d.scrollWidth - innerWidth }; });

async function exercise(page: Page, shot: (name: string) => Promise<void>) {
  await seed(page);
  const card = page.getByTestId("proposal-batch");
  await expect(card).toBeVisible();
  await expect(card).toContainText("3 changes from this agent run");
  await expect(card.locator("img")).toHaveCount(0); // summaries are text, never HTML
  await expect(card).toContainText("<img src=x onerror=alert(1)>");
  await card.evaluate((e) => e.scrollIntoView({ block: "start" }));
  // Review all focuses the combined overlay; individual Accept buttons are folded into the set.
  await page.getByTestId("batch-review").click();
  await expect(card).toHaveClass(/focus/);
  await expect(card).toContainText("+4 notes");
  await shot("review");
  // Reject all, then re-seed and Accept all: one revision, one Undo reverts everything.
  await page.getByTestId("batch-reject").click();
  await expect(card).toHaveCount(0);
  expect((await state(page)).statuses).toEqual(["discarded", "discarded", "discarded"]);
  await seed(page);
  const before = await state(page);
  await page.getByTestId("batch-accept").click();
  await expect(card).toHaveCount(0);
  const after = await state(page);
  expect(after.rev).toBe(before.rev + 1); expect(after.notes).toBe(before.notes + 4);
  expect(after.statuses.slice(-3)).toEqual(["committed", "committed", "committed"]);
  await page.evaluate(() => (globalThis as any).__gbkWorkstation.undo());
  expect((await state(page)).notes).toBe(before.notes);
}

test("desktop batch approval: Accept all / Reject all / Review all, no page scroll, light + dark", async ({ page }) => {
  test.skip(test.info().project.name !== "chrome-no-webmcp", "desktop Chrome");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/studio"); await expect(page.getByTestId("workstation")).toBeVisible();
    await exercise(page, async (n) => {
      expect(await overflow(page), `1440 ${scheme}`).toEqual({ v: 0, h: 0 });
      await page.screenshot({ path: `${SHOTS}/batch-1440-${scheme}.png` });
    });
    expect(await overflow(page)).toEqual({ v: 0, h: 0 });
  }
});

test("iphone batch approval: change set card fits 390px, no horizontal overflow, Accept all is one undo step", async ({ page }) => {
  test.skip(test.info().project.name !== "mobile-webkit", "iPhone WebKit");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/studio"); await expect(page.getByTestId("workstation")).toBeVisible();
    await exercise(page, async () => {
      expect((await overflow(page)).h, `390 ${scheme}`).toBeLessThanOrEqual(0);
      const box = await page.getByTestId("proposal-batch").boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      await page.screenshot({ path: `${SHOTS}/batch-390-${scheme}.png` });
    });
  }
});
