// gbk Social e2e (Pixel, WebKit iPhone, desktop Chrome): feed cards, rating, flat comments (escaped), tag filter,
// report, profile; no horizontal overflow and 16px inputs. Seeds one public song via the API and deletes it after.
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const project = JSON.parse(readFileSync(new URL("../fixtures/social-song.json", import.meta.url), "utf8"));
async function apiLogin(req: APIRequestContext, base: string, code: string) {
  const csrf = (await (await req.get("/api/session")).json()).csrf as string;
  const r = await req.post("/api/login", { headers: { origin: base, "x-gbk-csrf": csrf }, data: { code } }); expect(r.ok()).toBeTruthy();
  return { origin: base, "x-gbk-csrf": (await r.json()).csrf as string };
}
const origin = (p: Page) => new URL(p.url() === "about:blank" ? test.info().project.use.baseURL! : p.url()).origin;

test("social feed: rate, comment, tag filter, report, profile (mobile + desktop)", async ({ page, browser, baseURL }) => {
  const base = new URL(baseURL!).origin; void origin;
  const owner = await browser.newContext({ baseURL }); const oh = await apiLogin(owner.request, base, "e2e-code");
  const title = `Social E2E ${test.info().project.name} ${Date.now() % 100000}`;
  const sh = await (await owner.request.post("/api/shares", { headers: oh, data: { title, project, public: true } })).json();
  const tag = `e2e-${test.info().project.name.replace(/[^a-z0-9]/g, "").slice(0, 10)}`;
  expect((await owner.request.patch(`/api/songs/${sh.slug}/meta`, { headers: oh, data: { labels: ["classical"], tags: [tag] } })).ok()).toBeTruthy();
  try {
    await apiLogin(page.request, base, "e2e-code-2");
    await page.goto("/feed?sort=new");
    const card = page.getByTestId("feed-card").filter({ hasText: title }).first();
    await expect(card).toBeVisible();
    await expect(card.getByTestId("card-pianoroll")).toBeVisible();
    // rating
    await card.getByTestId("star-4").click();
    await expect(card.getByTestId("rating-summary")).toHaveText("4.0 (1)");
    // comments: plain text, never HTML
    await card.getByTestId("card-comments").click();
    await expect(page.getByTestId("comments-sheet")).toBeVisible();
    const input = page.getByTestId("comment-input");
    expect(await input.evaluate((e) => getComputedStyle(e).fontSize)).toBe("16px");
    await input.fill("<img src=x onerror=alert(1)> lovely");
    await page.getByTestId("comment-send").click();
    await expect(page.getByTestId("comment-body").first()).toHaveText("<img src=x onerror=alert(1)> lovely");
    expect(await page.getByTestId("comments-sheet").locator("img").count()).toBe(0);
    await page.getByTestId("sheet-close").click();
    // report the song
    await card.getByTestId("card-report").click();
    await page.getByTestId("report-reason").fill("e2e test report");
    await page.getByTestId("report-send").click();
    await expect(page.getByTestId("toast")).toContainText("review");
    // tag filter + browse sheet
    await card.getByRole("button", { name: `#${tag}` }).click();
    await expect(page).toHaveURL(new RegExp(`/t/${tag}$`));
    await expect(page.getByTestId("feed-card")).toHaveCount(1);
    await page.getByTestId("browse").click(); await expect(page.getByTestId("browse-sheet")).toBeVisible(); await page.getByTestId("sheet-close").click();
    // layout: no horizontal overflow
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/social-feed-${test.info().project.name}.png` });
    // profile
    await page.getByTestId("feed-card").first().getByTestId("card-author").click();
    await expect(page.getByTestId("profile-view")).toBeVisible();
    await expect(page.getByTestId("profile-song").filter({ hasText: title })).toBeVisible();
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
    await page.getByTestId("tab-profile").click(); await expect(page.getByTestId("profile-settings")).toBeVisible();
    expect(await page.getByTestId("settings-name").evaluate((e) => getComputedStyle(e).fontSize)).toBe("16px");
  } finally {
    await owner.request.delete(`/api/shares/${sh.slug}`, { headers: oh }); await owner.close();
  }
});

function silentWav(sec = 2, rate = 8000) {
  const n = sec * rate, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40); return b;
}
test("social feed autoplay: tap unlocks audio, active card plays, snapping to the next card switches playback", async ({ page, browser, baseURL }) => {
  const base = new URL(baseURL!).origin;
  const owner = await browser.newContext({ baseURL }); const oh = await apiLogin(owner.request, base, "e2e-code");
  const slugs: string[] = [];
  for (const t of ["Autoplay Two", "Autoplay One"]) {
    const sh = await (await owner.request.post("/api/shares", { headers: oh, data: { title: `${t} ${test.info().project.name} ${Date.now() % 100000}`, project, public: true } })).json();
    expect((await owner.request.put(`/api/shares/${sh.slug}/media/wav`, { headers: { ...oh, "content-type": "audio/wav" }, data: silentWav() })).ok()).toBeTruthy();
    slugs.push(sh.slug);
  }
  try {
    await page.goto("/feed?sort=new");
    const cards = page.getByTestId("feed-card");
    await expect(cards.first()).toHaveAttribute("data-slug", slugs[1]);
    await expect(page.getByTestId("tap-to-play")).toBeVisible();
    await page.getByTestId("tap-to-play").click();
    await expect(cards.first()).toHaveAttribute("data-playing", "1");
    await expect(page.getByTestId("feed")).toHaveAttribute("data-unlocked", "1");
    // snap to the next card: it becomes active and plays; the first stops
    await page.getByTestId("feed").evaluate((f) => f.scrollBy({ top: f.clientHeight }));
    await expect(page.getByTestId("feed")).toHaveAttribute("data-active", "1");
    await expect(cards.nth(1)).toHaveAttribute("data-playing", "1");
    await expect(cards.first()).toHaveAttribute("data-playing", "0");
    const snap = await page.getByTestId("feed").evaluate((f) => [getComputedStyle(f).scrollSnapType, Math.round(f.scrollTop / f.clientHeight * 100)]);
    expect(String(snap[0])).toContain("mandatory"); expect(snap[1]).toBe(100);
  } finally {
    for (const s of slugs) await owner.request.delete(`/api/shares/${s}`, { headers: oh }); await owner.close();
  }
});

test("social prompt sharing: off by default, owner opts in, feed shows prompt, Remix prefills the Composer (not run)", async ({ page, browser, baseURL }) => {
  const base = new URL(baseURL!).origin;
  const owner = await browser.newContext({ baseURL }); const oh = await apiLogin(owner.request, base, "e2e-code");
  const title = `Prompt Share ${test.info().project.name} ${Date.now() % 100000}`;
  const sh = await (await owner.request.post("/api/shares", { headers: oh, data: { title, project, public: true } })).json();
  try {
    const before = await (await owner.request.get(`/api/songs/${sh.slug}`)).json(); expect(before.prompt_shared).toBe(false); expect(before.prompt_text).toBeNull();
    await owner.request.patch(`/api/songs/${sh.slug}/meta`, { headers: oh, data: { prompt_shared: true, prompt_text: "a stormy sea shanty in A minor" } });
    await apiLogin(page.request, base, "e2e-code-2");
    await page.goto("/feed?sort=new");
    const card = page.getByTestId("feed-card").filter({ hasText: title }).first();
    await expect(card.getByTestId("card-prompt")).toContainText("a stormy sea shanty in A minor");
    await card.getByTestId("card-remix").click();
    await expect(page).toHaveURL(/\/studio$/);
    const tab = page.getByTestId("tab-composer"); if (await tab.isVisible() && (await tab.getAttribute("aria-selected")) !== "true") await tab.click();
    await expect(page.getByTestId("composer-input")).toHaveValue("a stormy sea shanty in A minor");
  } finally { await owner.request.delete(`/api/shares/${sh.slug}`, { headers: oh }); await owner.close(); }
});
