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

/** Phone studio (chat-first MobileStudio): reach a control the way a user would. Editor panels (tab-*, add-track) open
 * from a song card's "Open editor"; menu items from ⋯ (Export / Settings sub-sheets); Keys/MIDI from + -> MIDI keyboard.
 * The composer is the main view, so "tab-composer" is the input itself. No-op when already visible or on desktop. */
export async function studioReveal(page: Page, testId: string) {
  const el = page.getByTestId(testId).first();
  if (await el.isVisible()) return el;
  if (!(await page.getByTestId("plus-btn").count())) return el; // desktop / feed
  if (testId === "tab-composer") return page.getByTestId("composer-input");
  const closeSheets = async () => { if (await page.getByTestId("sheet-scrim").isVisible()) await page.getByTestId("sheet-scrim").click({ position: { x: 10, y: 120 } }); };
  if (testId.startsWith("tab-") || testId === "add-track") {
    if (!(await page.getByTestId("sheet-editor").isVisible())) { await closeSheets(); const open = page.getByTestId("version-open-editor").last(); if (await open.count()) await open.click(); }
    return (await el.isVisible()) ? el : page.getByTestId(`${testId}-unavailable`); // no song yet: no editor (count 0)
  }
  if (["keys-toggle", "midi-toggle", "midi-enable", "bt-midi"].includes(testId)) {
    await closeSheets(); await page.getByTestId("plus-btn").click(); await page.getByTestId("plus-midi-keyboard").click();
    return testId === "keys-toggle" || testId === "midi-toggle" ? page.getByTestId("midi-enable").or(page.getByTestId("midi-unsupported")).first() : el;
  }
  await closeSheets(); await page.getByTestId("studio-overflow").click();
  if (["export-midi", "export-wav", "export-video"].includes(testId)) await page.getByTestId("more-export").click();
  if (["import-input", "composer-settings", "composer-model"].includes(testId)) await page.getByTestId("more-settings").click();
  return el;
}

/** Composer connection state: desktop panel badge or the phone studio's input bar (both carry data-state). */
export const composerConn = (page: Page) => page.locator("[data-testid=composer-conn], [data-testid=composer-bar]").first();
