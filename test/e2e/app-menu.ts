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
  if (await page.locator("[data-layout=grid]").count()) return desktopReveal(page, testId, el); // desktop studio grid
  if (!(await page.getByTestId("plus-btn").count())) return el; // feed
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

/** Desktop studio grid: controls live in the header menus (Import ▾, Export, ⋯) and the ⋯ side panels. */
async function desktopReveal(page: Page, testId: string, el: ReturnType<Page["getByTestId"]>) {
  if (testId === "tab-composer") return page.getByTestId("composer-input"); // the composer is always in the footer
  const open = async (btn: string) => { const b = page.getByTestId(btn); if ((await b.getAttribute("aria-expanded")) !== "true") await b.click(); };
  if (["keys-toggle", "midi-toggle", "bt-midi", "import-sheet-music", "import-midi-file"].includes(testId)) await open("import-menu");
  else if (["export-midi", "export-wav", "export-video"].includes(testId)) await open("export-menu");
  else if (["import-input", "composer-settings", "composer-model", "import-file"].includes(testId)) { await open("studio-overflow"); await page.getByTestId("more-settings").click(); }
  else if (testId === "my-songs-studio") { await open("studio-overflow"); await page.getByTestId("more-songs").click(); }
  else if (["new-project", "open-player", "agent-toggle", "more-agent", "more-settings", "more-songs", "ts-select", "key-select", "bpm-tap"].includes(testId)) await open("studio-overflow");
  return el;
}

/** Composer connection state: desktop panel badge or the phone studio's input bar (both carry data-state). */
export const composerConn = (page: Page) => page.locator("[data-testid=composer-conn], [data-testid=composer-bar]").first();
