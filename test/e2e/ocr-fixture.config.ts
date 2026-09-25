import { defineConfig, devices } from "@playwright/test";

// Dedicated config for the OCR ground-truth iteration loop.
// Unlike the main playwright.config.ts this needs NO dev server: the spec
// transpiles src/sheet-music-reader.ts and runs parseSheetMusicToMidi on an
// about:blank page, so the loop is a single self-contained command:
//
//   npm run test:e2e:ocr-fixture
//
// In environments without Playwright's bundled Chromium, point
// OCR_FIXTURE_CHROME at a Chromium binary.

const chromePath = process.env.OCR_FIXTURE_CHROME;

export default defineConfig({
  testDir: "./",
  testMatch: "ocr-ground-truth.spec.ts",
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(chromePath
          ? {
              launchOptions: {
                executablePath: chromePath,
                args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
              },
            }
          : {}),
      },
    },
  ],
});
