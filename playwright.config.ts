import { defineConfig, devices } from "@playwright/test";

const enableVisualChrome = process.env.PW_VISUAL_CHROME === "1";
const baseURL = process.env.PW_BASE_URL || "http://127.0.0.1:5173/gbk/";
const chromeChannel = process.env.PW_CHROME_CHANNEL || "chrome";

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: "GBK_BASE_PATH=${GBK_BASE_PATH:-/gbk/} npm run dev -- --host 127.0.0.1",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /workstation-(webmcp|voice)\.spec\.ts|autonomous-compose\.spec\.ts|song-video\.spec\.ts|composer\.spec\.ts|keyboard-flash\.spec\.ts|chat-autoscroll\.spec\.ts/,
    },
    // Real WebMCP runtime: Chrome stable with the WebMCP testing feature (exposes document.modelContext).
    {
      name: "chrome-webmcp",
      testMatch: /workstation-(webmcp|voice)\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1500, height: 900 }, launchOptions: { args: ["--enable-features=WebMCPTesting", "--autoplay-policy=no-user-gesture-required"] } },
    },
    // Autonomous composition e2e: real WebMCP, clean profile, NO autoplay flag (rendering must not need audio).
    {
      name: "chrome-webmcp-autonomous",
      testMatch: /autonomous-compose\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1500, height: 900 }, acceptDownloads: true, launchOptions: { args: ["--enable-features=WebMCPTesting"] } },
    },
    // Same autonomous flow in Chrome with NO launch flags: tools come from the in-page shim (window.gbkTools).
    // Run with GBK_SHIM=1 so the spec drives gbkTools.call instead of document.modelContext.
    {
      name: "chrome-shim-autonomous",
      testMatch: /autonomous-compose\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1500, height: 900 }, acceptDownloads: true },
    },
    // Song video renderer + gallery (Chrome stable, no flags; needs ffmpeg/ffprobe and a published song folder).
    {
      name: "chrome-song",
      testMatch: /song-video\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1500, height: 900 } },
    },
    // WAV render in a real WebKit (Safari engine): OfflineAudioContext + AudioWorklet, no realtime AudioContext.
    {
      name: "webkit-render",
      testMatch: /offline-render\.spec\.ts|share-link-pin\.spec\.ts|one-tap-play\.spec\.ts|studio-new\.spec\.ts|keyboard-flash\.spec\.ts|chat-autoscroll\.spec\.ts/,
      use: { ...devices["iPhone 13"] },
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
