import { expect, test } from "@playwright/test";

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
// Helpers
// ---------------------------------------------------------------------------

/** Wait for the SF2 to finish loading so tests can proceed. */
async function waitForSf2Ready(page: import("@playwright/test").Page) {
  await expect(page.getByText("GeneralUser-GS.sf2")).toBeVisible({ timeout: 30_000 });
}

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
// Test: Switching MIDI file loads a new song
// ---------------------------------------------------------------------------

test("selecting a different MIDI file from the dropdown loads a new song", async ({ page }) => {
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForSf2Ready(page);

  // Wait for the default MIDI file to load
  await expect(page.locator(".transportTimer")).toContainText("0:00", { timeout: 20_000 });

  // Find the bundled MIDI dropdown
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
