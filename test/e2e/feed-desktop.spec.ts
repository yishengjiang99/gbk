// Desktop feed is full-viewport (one card per screen): the card spans >=90% of the content width, nothing overflows
// horizontally, and the card + roll fit inside the viewport between the chips row and the tab bar. Read-only (guest).
import { test, expect } from "@playwright/test";

const SIZES = [[1024, 650], [1280, 800], [1440, 900], [1920, 1080]] as const;
for (const [width, height] of SIZES) {
  test(`feed desktop layout ${width}x${height}`, async ({ page }) => {
    test.skip(test.info().project.name !== "chromium", "desktop viewport check");
    await page.setViewportSize({ width, height });
    await page.goto("feed");
    const card = page.getByTestId("feed-card").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    const m = await page.evaluate(() => {
      const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const de = document.documentElement, feed = document.querySelector(".so-feed") as HTMLElement;
      const c = box("[data-testid=feed-card]"), roll = box(".so-rollwrap"), tabs = box("[data-testid=tabs]"), chips = box(".so-filterbar"), side = box(".so-side");
      return { vw: de.clientWidth, sw: de.scrollWidth, feedW: feed.clientWidth, feedSW: feed.scrollWidth, c, roll, tabs, chips, side, cardH: feed.clientHeight };
    });
    expect(m.sw).toBeLessThanOrEqual(m.vw);
    expect(m.feedSW).toBeLessThanOrEqual(m.feedW);
    expect(m.c.width).toBeGreaterThanOrEqual(0.9 * m.vw);
    expect(m.chips.width).toBeGreaterThanOrEqual(0.9 * m.vw);
    expect(m.c.top).toBeGreaterThanOrEqual(m.chips.bottom - 1);
    expect(m.c.bottom).toBeLessThanOrEqual(m.tabs.top + 1);
    expect(m.c.right).toBeLessThanOrEqual(m.vw + 0.5);
    expect(m.roll.width).toBeGreaterThanOrEqual(0.6 * m.vw);
    expect(m.roll.bottom).toBeLessThanOrEqual(m.c.bottom);
    // action rail overlaid on the roll
    expect(m.side.left).toBeGreaterThanOrEqual(m.roll.left); expect(m.side.right).toBeLessThanOrEqual(m.roll.right);
    // canvas backing store matches CSS size * devicePixelRatio
    await expect.poll(() => page.getByTestId("card-pianoroll").first().evaluate((el) => { const c = el as HTMLCanvasElement, d = Math.min(3, devicePixelRatio || 1); return Math.abs(c.width - Math.round(c.getBoundingClientRect().width * d)) <= 1; })).toBe(true);
  });
}
