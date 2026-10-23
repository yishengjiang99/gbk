import { test, expect } from "@playwright/test";
// Bundled Playwright Chromium has no WebMCP: the workstation must work and fall back to the in-page shim.
test("no-WebMCP fallback: workstation renders, shim tools on by default, manual editing works", async ({ page }) => {
  await page.goto("/gbk/");
  await expect(page.getByTestId("workstation")).toBeVisible();
  const has = await page.evaluate(() => !!(document as any).modelContext || !!(navigator as any).modelContext);
  test.skip(has, "this browser exposes WebMCP");
  await expect(page.getByTestId("agent-toggle")).toBeEnabled();
  await expect(page.getByTestId("agent-toggle")).toBeChecked();
  await expect(page.getByTestId("agent-mode")).toHaveAttribute("data-mode", "shim");
  await expect(page.getByTestId("webmcp-status")).toHaveText(/shim.*on/);
  await page.getByTestId("agent-toggle").uncheck();
  await expect(page.getByTestId("webmcp-status")).toHaveText(/shim.*off/);
  expect(await page.evaluate(async () => (await (window as any).gbkTools.list()).length)).toBe(0);
  await page.getByTestId("agent-toggle").check();
  await expect(page.getByTestId("webmcp-status")).toHaveText(/shim.*on/);
  await page.getByTestId("open-player").click();
  await expect(page.getByTestId("player-modal")).toHaveClass(/open/);
  await page.getByText(/habanera/i).first().click();
  await page.getByTestId("close-player").click();
  await expect(page.locator(".ws-name")).toContainText(/habanera/i, { timeout: 20_000 });
  const rev = Number(await page.getByTestId("revision").innerText());
  const roll = page.getByTestId("piano-roll"); const box = (await roll.boundingBox())!;
  await roll.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(page.getByTestId("revision")).toHaveText(String(rev + 1));
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect(page.getByTestId("revision")).toHaveText(String(rev + 2));
});
