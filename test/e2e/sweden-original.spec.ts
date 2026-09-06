import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

test("original Sweden transcription matches the Python MIDI and survives reload", async ({ page }) => {
  await page.goto("/");
  await page.locator("summary").filter({ hasText: "Files" }).click();
  await page.getByRole("button", { name: "Show Sweden sheet music" }).click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    window.addEventListener("sheetmusicreader:generated-midi", (event) => {
      const detail = (event as CustomEvent<{ midiData: ArrayBuffer }>).detail;
      document.documentElement.dataset.originalMidi = JSON.stringify([...new Uint8Array(detail.midiData)]);
    }, { once: true });
  });
  await page.getByRole("button", { name: "Load original Sweden transcription" }).click();
  const metadata = page.getByLabel("MIDI metadata");
  await expect(metadata).toContainText("sweden.midi");
  const bytes = await page.locator("html").getAttribute("data-original-midi");
  expect(Buffer.from(JSON.parse(bytes!))).toEqual(fs.readFileSync(path.resolve("sweden.midi")));
  await expect(page.locator(".sheetMusicStatus")).toContainText("Original visual transcription");
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  await page.reload();
  await expect(metadata).toContainText("sweden.midi");
  await expect(metadata).toContainText("195 notes");
});
