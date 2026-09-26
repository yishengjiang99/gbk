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
