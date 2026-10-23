import { defineConfig, devices } from "@playwright/test";

const enableVisualChrome = process.env.PW_VISUAL_CHROME === "1";
const chromeChannel = process.env.PW_CHROME_CHANNEL || "chrome";

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: "http://127.0.0.1:5173/gbk/",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:5173/gbk/",
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /workstation-webmcp\.spec\.ts/,
    },
    // Real WebMCP runtime: Chrome stable with the WebMCP testing feature (exposes document.modelContext).
    {
      name: "chrome-webmcp",
      testMatch: /workstation-webmcp\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1500, height: 900 }, launchOptions: { args: ["--enable-features=WebMCPTesting", "--autoplay-policy=no-user-gesture-required"] } },
    },
    ...(enableVisualChrome
      ? [
          {
            name: "chrome-headed",
            use: {
              ...devices["Desktop Chrome"],
              channel: chromeChannel,
              headless: false,
              launchOptions: {
                slowMo: 250,
              },
            },
          },
        ]
      : []),
  ],
});
