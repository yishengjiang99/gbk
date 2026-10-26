import { expect, type Page } from "@playwright/test";

export async function openAppMenu(page: Page) {
  const toggle = page.getByRole("button", { name: "Player menu" });
  const panel = page.locator(".winamp-menu-panel");
  if (!(await panel.isVisible())) {
    await toggle.click();
  }
  await expect(panel).toBeVisible();
}

export async function closeAppMenu(page: Page) {
  const toggle = page.getByRole("button", { name: "Player menu" });
  const panel = page.locator(".winamp-menu-panel");
  if (await panel.isVisible()) {
    await toggle.click();
  }
  await expect(panel).not.toBeVisible();
}

export async function waitForSf2Ready(page: Page) {
  await expect(page.locator("#webamp")).toHaveAttribute("data-sf2-ready", "true", { timeout: 60_000 });
}

/** Compact phone studio: controls live behind the … menu, tabs behind its "Panels" item. No-op when already visible. */
export async function studioReveal(page: Page, testId: string) {
  const el = page.getByTestId(testId).first();
  if (await el.isVisible()) return el;
  const more = page.getByTestId("studio-overflow");
  if (!(await more.count())) return el;
  if (!(await page.getByTestId("studio-menu").isVisible())) await more.click();
  if (testId.startsWith("tab-")) await page.getByTestId("panels-more").click();
  return el;
}
