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

// Create rule (web + iOS): resume only when hasContent && (!published || dirtySincePublish); else /studio?new=.
test("Create resumes an unpublished draft, starts fresh when the latest version is published; New keeps the old one in Recent", async ({ page }) => {
  await page.goto("studio"); await ws(page); await page.waitForFunction(() => !!(window as any).gbkStudio);
  await page.evaluate(async (n) => { const c = (globalThis as any).__gbkWorkstation;
    await c.createProject({ name: n, owner: "user", replaceCurrent: true });
    c.edit([{ op: "addTrack", name: "Melody", channel: 0, id: "t_mel", program: 0 },
      { op: "addNotes", notes: [{ trackId: "t_mel", channel: 0, tick: 0, duration: 440, pitch: 60, velocity: 90 }] }], { label: "seed" }); }, NAME + " draft");
  const cp = () => page.evaluate(() => (window as any).gbkStudio.currentProject());
  let c = await cp();
  expect(c).toMatchObject({ title: NAME + " draft", published: false, dirtySincePublish: false, hasContent: true });
  expect(await page.evaluate(() => (window as any).gbkStudio.createPath())).toBe("studio");
  // Published at this revision and not edited since: done, so Create starts fresh.
  await page.evaluate(({ id, rev }) => localStorage.setItem("gbk.publishedRevs.v1", JSON.stringify({ [id]: rev })), { id: c.id, rev: await page.evaluate(() => (globalThis as any).__gbkWorkstation.project.revision) });
  c = await cp(); expect(c).toMatchObject({ published: true, dirtySincePublish: false });
  expect(await page.evaluate(() => (window as any).gbkStudio.createPath())).toMatch(/^studio\?new=\d+$/);
  // An edit after publishing makes it a draft again.
  await page.evaluate(() => (globalThis as any).__gbkWorkstation.edit([{ op: "addNotes", notes: [{ trackId: "t_mel", channel: 0, tick: 480, duration: 440, pitch: 62, velocity: 90 }] }], { label: "more" }));
  c = await cp(); expect(c).toMatchObject({ published: true, dirtySincePublish: true });
  expect(await page.evaluate(() => (window as any).gbkStudio.createPath())).toBe("studio");
  // The New button starts blank; the old project stays reachable in Recent.
  if (process.env.PW_BASE_URL) await page.getByTestId("studio-new").click(); // the studio UI needs the Composer server (prod)
  else await page.evaluate(() => (window as any).gbkStudio.startNew());
  await expect.poll(() => page.evaluate(() => (globalThis as any).__gbkWorkstation.project.notes.length)).toBe(0);
  expect((await cp()).hasContent).toBe(false);
  expect(await page.evaluate(() => (window as any).gbkStudio.createPath())).toMatch(/^studio\?new=/);
  const recent = await page.evaluate(() => (window as any).gbkStudio.recentProjects());
  const old = recent.find((r: { title: string }) => r.title === NAME + " draft"); expect(old).toBeTruthy();
  expect(await page.evaluate((id) => (window as any).gbkStudio.openRecent(id), old.id)).toBe(true);
  expect(await name(page)).toBe(NAME + " draft");
  // No horizontal overflow at phone width with the New button in the header.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
