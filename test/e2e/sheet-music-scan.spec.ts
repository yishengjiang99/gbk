import { expect, test } from "@playwright/test";
import path from "node:path";

test("scan sheet music image imports generated MIDI", async ({ page }) => {
  const fixturePath = path.resolve(process.cwd(), "dieLetzteKompanie.jpg");

  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });

  await expect(page.getByText("GeneralUser-GS.sf2")).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Scan or upload sheet music").setInputFiles(fixturePath);

  const metadata = page.getByLabel("MIDI metadata");
  await expect(metadata).toBeVisible({ timeout: 30_000 });
  await expect(metadata.getByText("Generated")).toBeVisible();
  await expect(metadata).toContainText("dieLetzteKompanie-scan.mid");
  await expect(metadata).toContainText(/tracks/);
  await expect(metadata).toContainText(/1[0-9] notes|[2-8][0-9] notes/);

  await expect(page.locator(".sheetMusicStatus")).toContainText(/Detected \d+ staff groups?, \d+ notehead candidates?, and imported \d+ MIDI notes?/i);
  await expect(page.locator(".sheetMusicStatus")).not.toContainText(/Sweden transcription demo/i);
});
