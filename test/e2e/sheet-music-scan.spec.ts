import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { parseMidiBuffer } from "../../src/midi-timer.worker.ts";

const keepChromeOpen = process.env.PW_KEEP_CHROME_OPEN === "1";

test("sweden sheet photo transcribes close to the baseline MIDI", async ({ page }) => {
  if (keepChromeOpen) test.setTimeout(0);

  const baselineMidi = fs.readFileSync(path.resolve(process.cwd(), "sweden.midi"));
  const baselineSong = parseMidiBuffer(baselineMidi.buffer.slice(baselineMidi.byteOffset, baselineMidi.byteOffset + baselineMidi.byteLength));
  const baselineNotes = baselineSong.tracks.flatMap((track) => track.notes);

  await page.goto("/");

  const generatedMidiPromise = page.evaluate(
    () =>
      new Promise<{ fileName: string; midiBytes: number[]; warnings: string[] }>((resolve) => {
        window.addEventListener(
          "sheetmusicreader:generated-midi",
          (event) => {
            const customEvent = event as CustomEvent<{ fileName: string; midiData: ArrayBuffer; warnings: string[] }>;
            resolve({
              fileName: customEvent.detail.fileName,
              midiBytes: Array.from(new Uint8Array(customEvent.detail.midiData)),
              warnings: customEvent.detail.warnings,
            });
          },
          { once: true }
        );
      })
  );
  await page.getByRole("button", { name: "Show Sweden sheet music" }).click();
  await expect(page.getByLabel("Displayed sheet music")).toContainText("sweden.jpg");
  await expect(page.getByRole("img", { name: "sweden.jpg sheet music preview" })).toBeVisible();
  await page.getByRole("button", { name: "Convert previewed sheet music to MIDI" }).click();
  const generatedMidi = await generatedMidiPromise;
  const generatedBytes = Uint8Array.from(generatedMidi.midiBytes);
  const generatedSong = parseMidiBuffer(generatedBytes.buffer.slice(0));
  const generatedNotes = generatedSong.tracks.flatMap((track) => track.notes);
  const generatedPitchClasses = new Set(generatedNotes.map((note) => note.note % 12));
  const baselinePitchClasses = new Set(baselineNotes.map((note) => note.note % 12));
  const matchingPitchClasses = [...generatedPitchClasses].filter((pitch) => baselinePitchClasses.has(pitch)).length;
  const baselineBassNotes = baselineNotes.filter((note) => note.note < 55);
  const generatedBassNotes = generatedNotes.filter((note) => note.note < 55);
  const detectedStaffCount = Number(/Detected (\d+) staff/.exec(generatedMidi.warnings.join(" "))?.[1] ?? 0);
  const firstGeneratedOnset = Math.min(...generatedNotes.map((note) => note.startSec));
  const firstGeneratedNotes = generatedNotes.filter((note) => note.startSec === firstGeneratedOnset);

  const result = {
    fileName: generatedMidi.fileName,
    warnings: generatedMidi.warnings.join(" "),
    generatedNoteCount: generatedNotes.length,
    baselineNoteCount: baselineNotes.length,
    generatedPitchClassCount: generatedPitchClasses.size,
    baselinePitchClassCount: baselinePitchClasses.size,
    matchingPitchClasses,
    baselineBassNoteCount: baselineBassNotes.length,
    generatedBassNoteCount: generatedBassNotes.length,
    detectedStaffCount,
    firstGeneratedNotes: firstGeneratedNotes.map((note) => note.note),
    bpm: generatedSong.bpm,
    timeSig: generatedSong.timeSig,
    totalBars: generatedSong.totalBars,
  };

  await test.step("scan status reflects real detection", async () => {
    const metadata = page.getByLabel("MIDI metadata");
    await expect(metadata).toBeVisible({ timeout: 30_000 });
    await expect(metadata).toContainText("sweden-scan.mid");
    await expect(metadata).toContainText("Generated");
    await expect(metadata).toContainText(`${generatedSong.tracks.length} tracks`);
    await expect(page.locator(".sheetMusicStatus")).not.toContainText(/Sweden transcription demo/i);
  });

  await test.step("generated scan loads into regular MIDI Explorer tracks", async () => {
    await expect(page.locator(".midiTimelineWrap")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".midiTrackLabelRow")).toHaveCount(generatedSong.tracks.length);
    await expect(page.locator(".midiTrackSvgRow")).toHaveCount(generatedSong.tracks.length);
    await expect(page.locator(".midiTrackSvg rect[fill='#2d6a93']").first()).toBeVisible();
    await expect(page.locator(".midiTrackSvg rect[fill='#2d6a93']")).toHaveCount(generatedNotes.length);
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  });

  expect(result.fileName).toBe("sweden-scan.mid");
  expect(result.warnings).toMatch(/Detected \d+ staff groups?, \d+ notehead candidates?, and imported \d+ MIDI notes?/i);
  expect(result.warnings).not.toMatch(/Sweden transcription demo/i);
  expect(result.generatedNoteCount).toBeGreaterThanOrEqual(Math.floor(result.baselineNoteCount * 0.35));
  expect(result.generatedPitchClassCount).toBeGreaterThanOrEqual(Math.min(4, result.baselinePitchClassCount));
  expect(result.matchingPitchClasses).toBeGreaterThanOrEqual(Math.min(4, result.baselinePitchClassCount));
  expect(result.generatedBassNoteCount).toBeGreaterThanOrEqual(Math.floor(result.baselineBassNoteCount * 0.25));
  expect(result.detectedStaffCount).toBeGreaterThanOrEqual(6);
  expect(result.detectedStaffCount % 2).toBe(0);
  expect(result.firstGeneratedNotes.some((note) => note < 60)).toBe(true);
  expect(result.firstGeneratedNotes.some((note) => note >= 60)).toBe(true);
  expect(result.totalBars).toBeGreaterThanOrEqual(14);
  expect(result.bpm).toBe(46);
  expect(result.timeSig).toBe("4/4");

  if (keepChromeOpen) {
    await test.step("keep headed Chrome open for visual inspection", async () => {
      await page.waitForTimeout(24 * 60 * 60 * 1000);
    });
  }
});

test("scan sheet music image imports generated MIDI", async ({ page }) => {
  const fixturePath = path.resolve(process.cwd(), "dieLetzteKompanie.jpg");

  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });

  await expect(page.getByText("GeneralUser-GS.sf2")).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Scan or upload sheet music").setInputFiles(fixturePath);
  await expect(page.getByLabel("Displayed sheet music")).toContainText("dieLetzteKompanie.jpg");
  await page.getByRole("button", { name: "Convert previewed sheet music to MIDI" }).click();

  const metadata = page.getByLabel("MIDI metadata");
  await expect(metadata).toBeVisible({ timeout: 30_000 });
  await expect(metadata.getByText("Generated")).toBeVisible();
  await expect(metadata).toContainText("dieLetzteKompanie-scan.mid");
  await expect(metadata).toContainText(/tracks/);
  await expect(metadata).toContainText(/1[0-9] notes|[2-8][0-9] notes/);

  await expect(page.locator(".sheetMusicStatus")).toContainText(/Detected \d+ staff groups?, \d+ notehead candidates?, and imported \d+ MIDI notes?/i);
  await expect(page.locator(".sheetMusicStatus")).not.toContainText(/Sweden transcription demo/i);
});
