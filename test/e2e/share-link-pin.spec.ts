import { test, expect, type Page } from "@playwright/test";
// /s/<slug> must pin, show, and play THAT song, even when the slug is already on the feed's first page further down
// (regression: it stayed at its feed index while card 0, a different song, showed and played), and ?edit=1 must open it.
const BASE = (process.env.GBK_URL ?? "/gbk/").replace(/\/?$/, "/");
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function feedSlugs(page: Page): Promise<string[]> {
  const r = await page.request.get(new URL("api/feed?sort=for_you&limit=10", new URL(BASE, page.url() === "about:blank" ? (test.info().project.use.baseURL ?? "http://127.0.0.1:5173/") : page.url())).toString());
  return ((await r.json()).items as { slug: string }[]).map((x) => x.slug);
}
async function checkShare(page: Page, slug: string, title: string) {
  await page.goto(`${BASE}s/${slug}`);
  const first = page.getByTestId("feed-card").first();
  await expect(first).toHaveAttribute("data-slug", slug, { timeout: 20_000 });
  await expect(first).toContainText(title);
  await expect(page.getByTestId("feed")).toHaveAttribute("data-active", "0");
  await page.getByTestId("tap-to-play").tap();
  await expect(page.locator(`[data-testid=feed-card][data-playing="1"]`)).toHaveAttribute("data-slug", slug, { timeout: 30_000 });
  await page.goto(`${BASE}s/${slug}?edit=1`);
  await expect.poll(() => page.evaluate(() => (globalThis as any).__gbkWorkstation?.project?.name ?? null), { timeout: 30_000 }).toBe(title);
}

test("share link pins, plays and opens the linked song (cold and warm)", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(BASE);
  const slugs = await feedSlugs(page);
  test.skip(slugs.length < 3, "needs a feed with >= 3 songs");
  const target = slugs[slugs.length - 1], other = slugs[0];
  const meta = async (s: string) => (await (await page.request.get(`${new URL(BASE, page.url())}api/shares/${s}`)).json()).title as string;
  // cold
  await checkShare(page, target, await meta(target));
  // warm: a different song played and was opened in the studio first (autosave + feed state exist)
  await checkShare(page, other, await meta(other));
  await checkShare(page, target, await meta(target));
});
