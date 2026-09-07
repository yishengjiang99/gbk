import { expect, type Page } from "@playwright/test";

export async function openAppMenu(page: Page) {
  const menu = page.locator("details.navMenu");
  if (!(await menu.getAttribute("open"))) {
    await menu.locator("summary").click();
  }
  await expect(menu).toHaveAttribute("open", "");
}

export async function waitForSf2Ready(page: Page) {
  await expect(page.getByText("GeneralUser-GS.sf2")).toBeAttached({ timeout: 30_000 });
}
