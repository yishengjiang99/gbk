import { expect, test } from "@playwright/test";
import path from "node:path";
import { openAppMenu } from "./app-menu";

/**
 * Ticket 1 acceptance: the OMR path works with cdn.jsdelivr.net fully
 * blocked, served entirely from same-origin staged files.
 *
 * Fixture: test/fixtures/ocr-ground-truth/c-scale.png (C major scale, one
 * staff; the ground-truth MIDI has 15 notes).
 *
 * Flow: open the Sheet Cam modal, "Use photo" with the fixture PNG, and
 * assert the scan completes through the homr music-recognition worker —
 * no "used the built-in reader instead" fallback warning — reporting
 * exactly 15 notes. Every request to cdn.jsdelivr.net is aborted; any
 * such request fails the test.
 *
 * The sandbox has no GPU: SwiftShader exposes navigator.gpu but cannot run
 * the fp16 transformer encoder (its WebGPU shaders can't compile there, and
 * ORT 1.30's wasm-EP fp16 kernels emit NaNs on real staff input, which the
 * decoder reads as PAD — verified in Node). Hiding navigator.gpu makes the
 * app take its genuine GPU-less path (fp32 encoder, wasm EP), exactly what
 * Safari and other WebGPU-less browsers do. The jsdelivr block and the
 * /ort-runtime/ staging assertions below are unaffected.
 *
 * Run (after `npm run build`):
 *   npx playwright test --config test/e2e/omr-offline.config.ts
 */
test("C-scale via OMR with jsdelivr blocked: 15 notes, same-origin runtime", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // See the header comment: force the app's GPU-less (fp32/wasm) path.
    delete (Navigator.prototype as unknown as Record<string, unknown>).gpu;
  });

  const jsdelivrHits: string[] = [];
  const ortRuntimeHits: string[] = [];
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.includes("cdn.jsdelivr.net")) {
      jsdelivrHits.push(url);
      return route.abort();
    }
    if (url.includes("/ort-runtime/")) ortRuntimeHits.push(url);
    return route.continue();
  });

  await page.goto("/gbk/");
  const shutter = page.getByRole("button", { name: "Scan sheet music with camera" });
  await expect(shutter).toBeVisible({ timeout: 60_000 });

  // No ORT runtime bytes on initial page load: the worker (and its wasm
  // files) must lazy-load on first scan only.
  expect(
    ortRuntimeHits,
    "ORT runtime files must not load before the first scan",
  ).toEqual([]);

  await shutter.click();
  const modal = page.getByRole("dialog", { name: "Scan sheet music" });
  await expect(modal).toBeVisible();

  const fixture = path.resolve(process.cwd(), "test", "fixtures", "ocr-ground-truth", "c-scale.png");
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    modal.getByRole("button", { name: "Use photo" }).click(),
  ]);
  await fileChooser.setFiles(fixture);

  // Diagnostic: sample the status line while the scan runs so the log shows
  // stage progression and timing (the scan takes minutes on SwiftShader).
  const t0 = Date.now();
  const sampler = setInterval(() => {
    void page
      .locator(".sheetMusicStatus")
      .textContent()
      .then((t) =>
        console.log(`[+${Math.round((Date.now() - t0) / 1000)}s] status: ${(t ?? "").slice(0, 120)}`),
      )
      .catch(() => {});
  }, 15_000);
  try {
    // Scan completion surfaces the OMR warnings in the status line. The
    // fallback path would instead say "used the built-in reader instead".
    const status = page.locator(".sheetMusicStatus");
    await expect(status).toContainText("Transcribed with the homr music-recognition model", {
      timeout: 480_000,
    });
  } finally {
    clearInterval(sampler);
  }
  const status = page.locator(".sheetMusicStatus");
  await expect(status).not.toContainText("used the built-in reader instead");

  // The CDN was never touched; the runtime came from same-origin staging.
  expect(jsdelivrHits, "requests to cdn.jsdelivr.net must be zero").toEqual([]);
  expect(
    ortRuntimeHits.length,
    "expected same-origin /ort-runtime/ requests during the scan",
  ).toBeGreaterThan(0);
  console.log("ort-runtime requests:", JSON.stringify(ortRuntimeHits, null, 1));

  // The generated MIDI is the scan product with 15 notes. (The OMR path is
  // proven by the status assertions above; the "-omr.mid" fileName is
  // internal to the scan result and not shown in this panel.)
  // The scan opens the scanned-sheet overlay; close it before using the menu.
  await page.getByRole("button", { name: /Close Scanned Sheet/ }).click();
  await openAppMenu(page);
  await page.getByRole("button", { name: /Current MIDI/i }).click();
  const metadata = page.getByLabel("MIDI metadata");
  await expect(metadata).toBeVisible({ timeout: 60_000 });
  await expect(metadata).toContainText("Scanned sheet");
  await expect(metadata).toContainText("15 notes");
});
