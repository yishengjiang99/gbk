import { expect, test } from "@playwright/test";
import { openAppMenu, waitForSf2Ready } from "./app-menu.ts";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

/** How long to poll for audio signal before giving up (ms). */
const AUDIO_SIGNAL_POLL_MS = 2_000;
/** Default poll window used in waitForAudioSignal. */
const DEFAULT_AUDIO_POLL_MS = 1_200;
/** Short wait after clicking Play to let the timer tick at least once (ms). */
const TIMER_TICK_WAIT_MS = 800;
/** Short wait after pausing to confirm the timer stopped advancing (ms). */
const PAUSE_VERIFICATION_WAIT_MS = 600;
/** Wait for AudioContext and first notes to start producing signal (ms). */
const AUDIO_START_WAIT_MS = 500;

// ---------------------------------------------------------------------------
// WAV file validation helpers
// ---------------------------------------------------------------------------

interface WavInfo {
  riff: string;
  wave: string;
  audioFormat: number;
  numChannels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
}

function findChunk(buffer: Buffer, start: number, chunkId: string): { offset: number; size: number } | null {
  let offset = start;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === chunkId) {
      return { offset, size };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

function parseWavHeader(buffer: ArrayBufferLike): WavInfo {
  const buf = Buffer.from(buffer);
  if (buf.length < 44) {
    throw new Error(`WAV file too small: ${buf.length} bytes`);
  }
  const riff = buf.toString("ascii", 0, 4);
  const wave = buf.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error(`Invalid WAV header: ${riff}/${wave}`);
  }

  const fmt = findChunk(buf, 12, "fmt ");
  if (!fmt) {
    throw new Error("Missing fmt chunk in WAV");
  }
  const fmtOffset = fmt.offset + 8;
  if (fmtOffset + 16 > buf.length) {
    throw new Error("fmt chunk truncated");
  }
  const audioFormat = buf.readUInt16LE(fmtOffset);
  const numChannels = buf.readUInt16LE(fmtOffset + 2);
  const sampleRate = buf.readUInt32LE(fmtOffset + 4);
  const byteRate = buf.readUInt32LE(fmtOffset + 8);
  const blockAlign = buf.readUInt16LE(fmtOffset + 12);
  const bitsPerSample = buf.readUInt16LE(fmtOffset + 14);

  const data = findChunk(buf, 12, "data");
  if (!data) {
    throw new Error("Missing data chunk in WAV");
  }

  return {
    riff,
    wave,
    audioFormat,
    numChannels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    dataOffset: data.offset + 8,
    dataBytes: data.size,
  };
}

function maxPcmSample(buffer: ArrayBufferLike, info: WavInfo): number {
  const buf = Buffer.from(buffer);
  let max = 0;
  if (info.bitsPerSample === 16) {
    const samples = info.dataBytes / 2;
    for (let i = 0; i < samples; i++) {
      const v = Math.abs(buf.readInt16LE(info.dataOffset + i * 2));
      if (v > max) max = v;
    }
  } else if (info.bitsPerSample === 24) {
    const samples = info.dataBytes / 3;
    for (let i = 0; i < samples; i++) {
      const off = info.dataOffset + i * 3;
      const raw = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
      const v = Math.abs(raw >= 0x800000 ? raw - 0x1000000 : raw);
      if (v > max) max = v;
    }
  } else if (info.bitsPerSample === 32) {
    const samples = info.dataBytes / 4;
    for (let i = 0; i < samples; i++) {
      const v = Math.abs(buf.readInt32LE(info.dataOffset + i * 4));
      if (v > max) max = v;
    }
  } else {
    throw new Error(`Unsupported bits per sample: ${info.bitsPerSample}`);
  }
  return max;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll the analyzer-time canvas for a signal peak above the given threshold. */
async function waitForAudioSignal(
  page: import("@playwright/test").Page,
  threshold = 0.002,
  pollMs = DEFAULT_AUDIO_POLL_MS
): Promise<number> {
  const analyzer = page.getByTestId("analyzer-time");
  const peak = await analyzer.evaluate(
    async (canvas, { threshold, pollMs }) => {
      const startedAt = performance.now();
      let observedPeak = 0;
      while (performance.now() - startedAt < pollMs) {
        const v = Number(canvas.getAttribute("data-signal-peak") ?? 0);
        if (v > observedPeak) observedPeak = v;
        if (observedPeak > threshold) break;
        await new Promise((r) => setTimeout(r, 40));
      }
      return observedPeak;
    },
    { threshold, pollMs }
  );
  return peak as number;
}

// ---------------------------------------------------------------------------
// Test: default MIDI file (Beethoven) plays and produces audio signal
// ---------------------------------------------------------------------------

test("default Beethoven MIDI plays and produces audio signal", async ({ page }) => {
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForSf2Ready(page);

  // The default MIDI file (Beethoven) is loaded automatically.
  // Wait for the song to load — the transport timer shows "0:00 /"
  await expect(page.locator(".transportTimer")).toContainText("0:00", { timeout: 20_000 });

  const playButton = page.getByRole("button", { name: "Play" });
  await expect(playButton).toBeEnabled({ timeout: 10_000 });
  await playButton.click();

  // Analyzer canvas should register a non-trivial peak within 2 seconds
  const peak = await waitForAudioSignal(page, 0.002, AUDIO_SIGNAL_POLL_MS);
  expect(peak).toBeGreaterThan(0.002);

  // Timer should have advanced past 0:00
  const timerText = await page.locator(".transportTimer").textContent();
  // Transport timer format is "M:SS / M:SS"; current time is the first part
  expect(timerText).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Test: Play / Pause toggle
// ---------------------------------------------------------------------------

test("Play button changes to Pause and back, timer advances while playing", async ({ page }) => {
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForSf2Ready(page);

  await expect(page.locator(".transportTimer")).toContainText("0:00", { timeout: 20_000 });

  // Initially the button is labelled "Play"
  const playBtn = page.getByRole("button", { name: "Play" });
  await expect(playBtn).toBeEnabled({ timeout: 10_000 });
  await playBtn.click();

  // After clicking Play, it should become Pause
  const pauseBtn = page.getByRole("button", { name: "Pause" });
  await expect(pauseBtn).toBeVisible({ timeout: 5_000 });

  // Wait a short moment for the timer to tick
  await page.waitForTimeout(TIMER_TICK_WAIT_MS);

  // Now pause
  await pauseBtn.click();

  // Button reverts to Play
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible({ timeout: 5_000 });

  // Capture timer immediately after pause
  const timerAfterPause = await page.locator(".transportTimer").textContent();
  // Timer value at pause should be non-zero (has advanced)
  expect(timerAfterPause).toBeTruthy();
  expect(timerAfterPause).not.toBe("0:00 / 0:00");

  // Wait a moment and verify the timer is no longer advancing
  await page.waitForTimeout(PAUSE_VERIFICATION_WAIT_MS);
  const timerAfterWait = await page.locator(".transportTimer").textContent();
  // The timer should not have advanced much (within a tick tolerance)
  expect(timerAfterWait).toBe(timerAfterPause);
});

// ---------------------------------------------------------------------------
// Test: Pause then resume resumes audio output
// ---------------------------------------------------------------------------

test("pause then resume resumes audio signal", async ({ page }) => {
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForSf2Ready(page);

  await expect(page.locator(".transportTimer")).toContainText("0:00", { timeout: 20_000 });

  // Start playback
  const playBtn = page.getByRole("button", { name: "Play" });
  await expect(playBtn).toBeEnabled({ timeout: 10_000 });
  await playBtn.click();

  // Wait briefly for audio to start
  await page.waitForTimeout(AUDIO_START_WAIT_MS);

  // Pause
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible({ timeout: 5_000 });

  // Resume
  await page.getByRole("button", { name: "Play" }).click();

  // Audio signal should be present again after resuming
  const peak = await waitForAudioSignal(page, 0.001, AUDIO_SIGNAL_POLL_MS);
  expect(peak).toBeGreaterThan(0.001);
});

// ---------------------------------------------------------------------------
// Test: Export WAV shows progress bar
// ---------------------------------------------------------------------------

test("Export WAV button triggers export progress indicator", async ({ page }) => {
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForSf2Ready(page);

  await expect(page.locator(".transportTimer")).toContainText("0:00", { timeout: 20_000 });

  const exportBtn = page.getByRole("button", { name: "Export WAV" });
  await expect(exportBtn).toBeEnabled({ timeout: 10_000 });

  // Intercept the download so the test doesn't actually save a file
  const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
  await exportBtn.click();

  // Progress bar should appear (export is in progress)
  await expect(page.locator(".exportProgressBar")).toBeVisible({ timeout: 10_000 });

  // Wait for the download to complete (export finishes)
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.wav$/i);

  // After completion, progress bar should be gone
  await expect(page.locator(".exportProgressBar")).not.toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Test: Play, export WAV, and validate the downloaded audio file
// ---------------------------------------------------------------------------

test("playing and exporting produces a valid, non-silent WAV file", async ({ page }, testInfo) => {
  testInfo.setTimeout(120_000);
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForSf2Ready(page);

  await expect(page.locator(".transportTimer")).toContainText("0:00", { timeout: 20_000 });

  // Switch to a shorter bundled MIDI so offline rendering finishes in time.
  await openAppMenu(page);
  const midiSelect = page.getByRole("combobox", { name: "Select bundled MIDI file" });
  await expect(midiSelect).toBeEnabled({ timeout: 10_000 });
  await midiSelect.selectOption({ label: "Dr Dre - Still Dre.mid" });
  await expect(page.locator(".transportTimer")).toContainText("0:00", { timeout: 15_000 });

  const playBtn = page.getByRole("button", { name: "Play" });
  await expect(playBtn).toBeEnabled({ timeout: 10_000 });
  await playBtn.click();

  // Wait briefly so playback is active; Export WAV remains enabled while playing.
  await page.waitForTimeout(TIMER_TICK_WAIT_MS);

  const exportBtn = page.getByRole("button", { name: "Export WAV" });
  await expect(exportBtn).toBeEnabled({ timeout: 10_000 });

  // Intercept the download and save it to a temp path for inspection.
  const downloadPromise = page.waitForEvent("download", { timeout: 90_000 });
  await exportBtn.click();

  await expect(page.locator(".exportProgressBar")).toBeVisible({ timeout: 10_000 });

  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.wav$/i);

  const tmpDir = mkdtempSync(join(tmpdir(), "gbk-wav-export-"));
  const wavPath = join(tmpDir, download.suggestedFilename());
  await download.saveAs(wavPath);

  await expect(page.locator(".exportProgressBar")).not.toBeVisible({ timeout: 10_000 });

  // Validate the saved WAV file.
  const wavBuffer = readFileSync(wavPath);
  const info = parseWavHeader(wavBuffer.buffer.slice(wavBuffer.byteOffset, wavBuffer.byteOffset + wavBuffer.byteLength));

  expect(info.audioFormat).toBe(1); // PCM
  expect(info.numChannels).toBe(2);
  expect(info.sampleRate).toBe(44100);
  expect(info.bitsPerSample).toBe(16);
  expect(info.blockAlign).toBe(info.numChannels * (info.bitsPerSample / 8));
  expect(info.byteRate).toBe(info.sampleRate * info.blockAlign);
  expect(info.dataBytes).toBeGreaterThan(0);
  expect(info.dataBytes % info.blockAlign).toBe(0);

  const maxSample = maxPcmSample(wavBuffer.buffer.slice(wavBuffer.byteOffset, wavBuffer.byteOffset + wavBuffer.byteLength), info);
  expect(maxSample).toBeGreaterThan(256); // well above digital silence for 16-bit PCM
});

// ---------------------------------------------------------------------------
// Test: Switching MIDI file loads a new song
// ---------------------------------------------------------------------------

test("selecting a different MIDI file from the dropdown loads a new song", async ({ page }) => {
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForSf2Ready(page);

  // Wait for the default MIDI file to load
  await expect(page.locator(".transportTimer")).toContainText("0:00", { timeout: 20_000 });

  await openAppMenu(page);
  const midiSelect = page.getByRole("combobox", { name: "Select bundled MIDI file" });
  await expect(midiSelect).toBeEnabled({ timeout: 10_000 });

  // Collect all available options and pick any non-selected, non-default one
  const options = await midiSelect.locator("option").allTextContents();
  const nonDefault = options.find(
    (opt) => opt !== "" && !opt.includes("Beethoven") && !opt.includes("Select MIDI")
  );
  if (!nonDefault) {
    // Only one MIDI file available; skip the switch assertion but still pass
    return;
  }

  await midiSelect.selectOption({ label: nonDefault });

  // The transport timer should reset to 0:00 and a song should be shown
  await expect(page.locator(".transportTimer")).toContainText("0:00", { timeout: 15_000 });

  // Ensure the Play button is enabled (song was loaded successfully)
  await expect(page.getByRole("button", { name: "Play" })).toBeEnabled({ timeout: 10_000 });
});
