// Guest publish in the iOS app web view (window.gbkNative), WebKit iPhone 390px: no sign-in gate, guest cookie session
// from the app's device id, native publish handler hand-off, publish-sheet layout (bright + dark). Cleans up its data.
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
const SHOTS = process.env.GBK_SHOTS ?? "/workspace/shots";
const word = () => { const a = "abcdefghijklmnopqrstuvwxyz"; let s = ""; for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * 26)]; return s; };
const guestName = () => `Pub${word().replace(/^./, (c) => c.toUpperCase())}`;

async function studioWithSong(page: Page, native: object | null, handler = false) {
  await page.addInitScript(([n, h]) => {
    const w = window as any; w.__signin = 0; w.__posted = [];
    addEventListener("gbk:need-signin", () => { w.__signin++; });
    if (n) w.gbkNative = n;
    if (h) w.webkit = { messageHandlers: { publish: { postMessage: (m: unknown) => w.__posted.push(m) } } };
  }, [native, handler] as const);
  await page.goto("/studio");
  await page.waitForFunction(async () => ((await (window as any).gbkTools?.list()) ?? []).length > 40, undefined, { timeout: 60_000 });
  const call = async (n: string, a: unknown) => JSON.parse(await page.evaluate(([n, a]) => (window as any).gbkTools.call(n, a), [n, a] as const) as string);
  expect((await call("gbk_create_project", { name: "Guest Publish E2E", tempo: 96, key: "C major", replaceCurrent: true })).ok).toBe(true);
  expect((await call("gbk_generate_arrangement", { style: "ambient", key: "C major", bars: 4, seed: 3, voices: 2 })).ok).toBe(true);
}
test.beforeEach(() => { test.skip(test.info().project.name !== "mobile-webkit", "WebKit iPhone (390px) only"); });
const openPublish = async (page: Page) => { await page.getByTestId("studio-overflow").click(); await page.getByTestId("more-publish").click(); };

test("guest publish: native app web view publishes without sign-in; sheet fits 390px (light + dark)", async ({ page }) => {
  const dev = randomUUID(), name = guestName();
  await studioWithSong(page, { deviceId: dev, guestName: name });
  let slug = "";
  try {
    await openPublish(page);
    const dlg = page.getByTestId("publish-dialog"); await expect(dlg).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => (window as any).__signin)).toBe(0);
    const vw = page.viewportSize()!; expect(vw.width).toBe(390);
    for (const id of ["publish-title", "publish-tag-input"]) {
      const st = await page.getByTestId(id).evaluate((e) => { const c = getComputedStyle(e); return { fs: c.fontSize, bg: c.backgroundColor, color: c.color }; });
      expect(st.fs).toBe("16px"); expect(st.bg).toBe("rgb(255, 255, 255)"); expect(st.color).not.toBe("rgb(255, 255, 255)");
    }
    const label = await page.locator(".pub-share-prompt").boundingBox(); expect(label!.x + label!.width).toBeLessThanOrEqual(vw.width);
    expect(await page.evaluate(() => [document.documentElement.scrollWidth, document.querySelector(".pub-card")!.scrollWidth - document.querySelector(".pub-card")!.clientWidth])).toEqual([390, 0]);
    for (const id of ["publish-cancel", "publish-confirm"]) { const b = await page.getByTestId(id).boundingBox(); expect(b!.y + b!.height).toBeLessThanOrEqual(vw.height - 56); expect(b!.x + b!.width).toBeLessThanOrEqual(vw.width); }
    await expect(page.locator(".cmp-input textarea, .ms-foot textarea").first()).toBeAttached();
    await page.getByTestId("publish-share-prompt").check();
    await page.screenshot({ path: `${SHOTS}/publish-sheet-390-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await page.getByTestId("publish-title").evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe("rgb(0, 0, 0)");
    await page.screenshot({ path: `${SHOTS}/publish-sheet-390-dark.png` });
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByTestId("publish-title").fill(`<b>Guest E2E</b> ${Date.now() % 100000}`);
    await page.getByTestId("publish-share-prompt").uncheck();
    const resp = page.waitForResponse((r) => /\/api\/shares\/[^/]+$/.test(r.url()) && r.request().method() === "PATCH");
    await page.getByTestId("publish-confirm").click();
    const pj = await (await resp).json(); slug = pj.slug; expect(pj.public).toBe(true);
    await expect(page.getByTestId("publish-dialog")).toBeHidden();
    const me = await (await page.request.get("/api/me")).json(); expect(me.is_guest).toBe(true); expect(me.handle).toMatch(new RegExp(`^${name.toLowerCase()}\\d*$`));
    const pub = await (await page.request.get(`/api/shares/${slug}`)).json(); expect(pub.public).toBe(true);
    expect(await page.evaluate(() => (window as any).__signin)).toBe(0);
  } finally {
    const csrf = (await page.context().cookies()).find((c) => c.name === "gbk_csrf")?.value ?? "";
    const origin = new URL(page.url()).origin;
    await page.request.delete("/api/me", { headers: { origin, "x-gbk-csrf": decodeURIComponent(csrf) } }); // guest + its songs
    if (slug) expect((await page.request.get(`/api/shares/${slug}`)).status()).toBe(404);
  }
});

test("guest publish: native publish handler gets {projectId,title,labels,tags}; no web sheet, no sign-in event", async ({ page }) => {
  await studioWithSong(page, { deviceId: randomUUID(), guestName: guestName() }, true);
  await openPublish(page);
  await expect.poll(() => page.evaluate(() => (window as any).__posted.length)).toBe(1);
  const m = await page.evaluate(() => (window as any).__posted[0]);
  expect(Object.keys(m).sort()).toEqual(["labels", "projectId", "tags", "title"]); expect(m.title).toBe("Guest Publish E2E"); expect(typeof m.projectId).toBe("string");
  await expect(page.getByTestId("publish-dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__signin)).toBe(0);
});

test("guest publish: plain mobile web still asks to sign in", async ({ page }) => {
  await studioWithSong(page, null);
  await openPublish(page);
  await expect.poll(() => page.evaluate(() => (window as any).__signin)).toBe(1);
  await expect(page.getByTestId("publish-dialog")).toHaveCount(0);
});
