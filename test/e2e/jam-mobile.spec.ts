// Phones (WebKit iPhone emulation): the room page scrolls and the on-screen keyboard is visible without scrolling.
import { test, expect } from "@playwright/test";

test("iPhone: room page scrolls, keyboard stays on screen and plays", async ({ page, context }) => {
  const csrf = (await (await context.request.get("/api/session")).json()).csrf as string;
  expect((await context.request.post("/api/login", { headers: { origin: "http://127.0.0.1:5211", "x-gbk-csrf": csrf }, data: { code: "jam-1" } })).ok()).toBe(true);
  await page.goto("/jam"); await page.getByTestId("jam-create").tap(); await page.getByTestId("jam-room").waitFor();
  const kb = page.getByTestId("jam-keyboard");
  await expect(kb).toBeInViewport({ ratio: 0.9 });
  const scroll = await page.evaluate(() => { const before = document.scrollingElement!.scrollHeight - innerHeight; window.scrollTo(0, 1e5); return { room: before, y: scrollY }; });
  expect(scroll.room, "page is taller than the screen").toBeGreaterThan(0);
  expect(scroll.y, "page scrolls").toBeGreaterThan(0);
  await expect(kb).toBeInViewport({ ratio: 0.9 });
  await page.getByTestId("jam-leave").scrollIntoViewIfNeeded(); await expect(page.getByTestId("jam-leave")).toBeInViewport();
  // The sticky keyboard is on top at its spot (not covered), and touching it doesn't scroll the page.
  const box = (await kb.boundingBox())!; const y0 = await page.evaluate(() => scrollY);
  expect(await page.evaluate(([x, y]) => (document.elementFromPoint(x, y) as HTMLElement | null)?.dataset.note ?? null, [box.x + 10, box.y + box.height - 10])).not.toBeNull();
  await page.touchscreen.tap(box.x + 10, box.y + box.height - 10);
  expect(await page.evaluate(() => scrollY)).toBe(y0);
  page.on("dialog", (d) => d.accept()); await page.getByRole("button", { name: "End room" }).tap(); // free the room slot for other tests
  await expect(page.getByTestId("jam-over")).toBeVisible();
});
