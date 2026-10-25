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
