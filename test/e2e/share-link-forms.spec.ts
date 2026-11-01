import { test, expect } from "@playwright/test";
// Every share URL form lands on THAT song (feed card pinned first), and an unknown slug shows "Song not found".
const BASE = (process.env.GBK_URL ?? "/gbk/").replace(/\/?$/, "/");

test("share URL forms open the linked song; unknown slug shows Song not found", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(BASE);
  const r = await page.request.get(new URL(`${BASE}api/feed?sort=for_you&limit=10`, page.url()).toString());
  const items = (await r.json()).items as { slug: string; title: string }[];
  test.skip(items.length < 2, "needs a feed with >= 2 songs");
  const { slug, title } = items[items.length - 1];
  for (const form of [`s/${slug}`, `feed?pin=${slug}`, `song/${slug}`, `share/${slug}`, `?s=${slug}`]) {
    await page.goto(`${BASE}${form}`);
    const first = page.getByTestId("feed-card").first();
    await expect(first, form).toHaveAttribute("data-slug", slug, { timeout: 20_000 });
    await expect(first, form).toContainText(title);
  }
  await page.goto(`${BASE}s/no-such-song-zz99`);
  await expect(page.getByTestId("song-not-found")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("feed-card")).toHaveCount(0);
});
