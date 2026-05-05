import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __sf2E2e?: {
      playbackEvents: Array<Record<string, unknown>>;
    };
  }
}

test("generated Bach playback primes presets before opening note-ons", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("sf2-e2e-debug", "1");
  });
  await page.goto("/");
  await page.setViewportSize({ width: 1440, height: 900 });

  await expect(page.getByText("GeneralUser-GS.sf2")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: /Bach Composer/i }).click();
  await page.getByRole("button", { name: "Generate Bach Music" }).click();
  await expect(page.getByText("Generated Bach Soprano")).toBeVisible({ timeout: 30_000 });

  const playButton = page.getByRole("button", { name: "Play" });
  await expect(playButton).toBeEnabled();
  await playButton.click();

  const debugHandle = await page.waitForFunction(() => {
    const events = window.__sf2E2e?.playbackEvents ?? [];
    const expectedTracks = [0, 1, 2, 3];

    const checks = expectedTracks.map((trackIndex) => {
      const program = events.find(
        (event) =>
          event.kind === "programChangeRequest" &&
          event.trackIndex === trackIndex &&
          event.eventSec === 0
      );
      const noteOn = events.find(
        (event) =>
          event.kind === "noteOn" &&
          event.trackIndex === trackIndex &&
          event.eventSec === 0
      );
      const preset = events.find(
        (event) =>
          event.kind === "presetApplied" &&
          event.trackIndex === trackIndex &&
          program &&
          noteOn &&
          Number(event.order) > Number(program.order) &&
          Number(event.order) < Number(noteOn.order)
      );
      return { trackIndex, program, preset, noteOn };
    });

    if (
      checks.every(
        (check) =>
          check.program &&
          check.preset &&
          check.noteOn &&
          Number(check.noteOn.atSec) < 1
      )
    ) {
      return checks;
    }

    return false;
  }, null, { timeout: 5_000 });

  const checks = await debugHandle.jsonValue() as unknown[];
  expect(checks).toHaveLength(4);
});
