import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const configDir = path.dirname(fileURLToPath(import.meta.url));

// Serves the production build (dist/) for the offline-OMR acceptance test.
export default defineConfig({
  testDir: configDir,
  testMatch: /omr-offline-cscale\.spec\.ts/,
  timeout: 900_000,
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL: "http://127.0.0.1:4173/gbk/",
  },
  webServer: {
    command: `node ${path.join(repoRoot, "scripts", "serve-dist.mjs")} 4173`,
    url: "http://127.0.0.1:4173/gbk/",
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
