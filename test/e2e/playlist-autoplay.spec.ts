import { expect, test, type Page } from "@playwright/test";

async function playNearEnd(page: Page) {
  const seek = page.getByRole("slider", { name: "Playback position" });
  const duration = Number(await seek.getAttribute("max"));
  await seek.evaluate((element, value) => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, Math.max(0, duration - 0.5).toFixed(2));
  await page.getByRole("button", { name: "Play", exact: true }).click();
}

test("playlist advances automatically and stops after the final song", async ({ page }) => {
  await page.goto("/gbk/");
  const playlist = page.getByRole("region", { name: "MIDI playlist" });
  await playlist.getByRole("button", { name: "Never-Gonna-Give-You-Up-1.mid", exact: true }).click();
  await expect(page.locator(".midiMetadataTitle")).toContainText("Never-Gonna");
  await expect(page.getByRole("button", { name: "Export WAV", exact: true })).toBeEnabled();
  // Filtering the visible list must not change playback order.
  await page.getByRole("searchbox", { name: "Search playlist" }).fill("Never");
  await playNearEnd(page);
  await expect(page.locator(".midiMetadataTitle")).toContainText("Queen", { timeout: 15000 });
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(page.locator(".transportTimer")).not.toHaveText(/^0:00 /);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await playNearEnd(page);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".midiMetadataTitle")).toContainText("Queen");
});

test("pausing does not advance the playlist", async ({ page }) => {
  await page.goto("/gbk/");
  await expect(page.locator(".midiMetadataTitle")).toBeVisible();
  const title = await page.locator(".midiMetadataTitle").textContent();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(page.locator(".midiMetadataTitle")).toHaveText(title!);
});
