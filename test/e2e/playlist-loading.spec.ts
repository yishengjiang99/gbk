import { expect, test } from "@playwright/test";

test("Play queues while SoundFont downloads and starts when ready", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/GeneralUser-GS.sf2", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/gbk/");
  await expect(page.locator(".gbk-dock")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Downloading SoundFont");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel pending playback" })).toBeVisible();
  release();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".transportTimer")).not.toHaveText(/^0:00 /);
});

test("failed SoundFont loading can be retried with Play; playlist works without menu", async ({ page }) => {
  let attempts = 0;
  await page.route("**/GeneralUser-GS.sf2", async (route) => {
    if (++attempts === 1) await route.abort();
    else await route.continue();
  });
  await page.goto("/gbk/");
  await expect(page.getByText(/SoundFont loading failed:/)).toBeVisible();
  const playlist = page.getByRole("region", { name: "MIDI playlist" });
  await expect(playlist).toBeVisible();
  await page.getByRole("searchbox", { name: "Search playlist" }).fill("Still Dre");
  await expect(playlist.locator(".midiPlaylistTrack")).toHaveCount(1);
  await playlist.locator(".midiPlaylistTrack").click();
  await expect(page.locator(".gbk-dock")).toContainText("Dr Dre - Still Dre.mid");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible({ timeout: 30000 });
  expect(attempts).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(playlist).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/synth-playlist-mobile.png", fullPage: true });
});
