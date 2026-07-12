import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { parseMidiBuffer } from "../../src/midi-timer.worker.ts";

test("sweden sheet photo transcribes close to the baseline MIDI", async ({ page }) => {
  const imagePath = path.resolve(process.cwd(), "sweden.jpg");
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
  await page.getByLabel("Scan or upload sheet music").setInputFiles(imagePath);
  const generatedMidi = await generatedMidiPromise;
  const generatedBytes = Uint8Array.from(generatedMidi.midiBytes);
  const generatedSong = parseMidiBuffer(generatedBytes.buffer.slice(0));
  const generatedNotes = generatedSong.tracks.flatMap((track) => track.notes);
  const generatedPitchClasses = new Set(generatedNotes.map((note) => note.note % 12));
  const baselinePitchClasses = new Set(baselineNotes.map((note) => note.note % 12));
  const matchingPitchClasses = [...generatedPitchClasses].filter((pitch) => baselinePitchClasses.has(pitch)).length;

  const result = {
    fileName: generatedMidi.fileName,
    warnings: generatedMidi.warnings.join(" "),
    generatedNoteCount: generatedNotes.length,
    baselineNoteCount: baselineNotes.length,
    generatedPitchClassCount: generatedPitchClasses.size,
    baselinePitchClassCount: baselinePitchClasses.size,
    matchingPitchClasses,
    bpm: generatedSong.bpm,
    timeSig: generatedSong.timeSig,
  };

  await test.step("scan status reflects real detection", async () => {
    const metadata = page.getByLabel("MIDI metadata");
    await expect(metadata).toBeVisible({ timeout: 30_000 });
    await expect(metadata).toContainText("sweden-scan.mid");
    await expect(metadata).toContainText("Generated");
    await expect(page.locator(".sheetMusicStatus")).not.toContainText(/Sweden transcription demo/i);
  });

  expect(result.fileName).toBe("sweden-scan.mid");
  expect(result.warnings).toMatch(/Detected \d+ staff groups?, \d+ notehead candidates?, and imported \d+ MIDI notes?/i);
  expect(result.warnings).not.toMatch(/Sweden transcription demo/i);
  expect(result.generatedNoteCount).toBeGreaterThanOrEqual(Math.floor(result.baselineNoteCount * 0.35));
  expect(result.generatedPitchClassCount).toBeGreaterThanOrEqual(Math.min(4, result.baselinePitchClassCount));
  expect(result.matchingPitchClasses).toBeGreaterThanOrEqual(Math.min(4, result.baselinePitchClassCount));
  expect(result.bpm).toBe(92);
  expect(result.timeSig).toBe("4/4");
});

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
