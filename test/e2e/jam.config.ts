// Live Jam e2e: real server (rooms + /api/jam/ws) + Vite app at "/", 2-4 independent headless Chromium contexts
// with real RTCPeerConnections. Run: npx playwright test --config test/e2e/jam.config.ts
import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const DATA = mkdtempSync(join(tmpdir(), "gbk-jam-e2e-"));
const WEB = 5211, API = 8811; const origin = `http://127.0.0.1:${WEB}`;
export default defineConfig({
  testDir: ".", testMatch: /e2e\/jam\.spec\.ts$/, timeout: 180_000, expect: { timeout: 30_000 }, workers: 1,
  use: { baseURL: `${origin}/`, trace: "retain-on-failure" },
  webServer: [
    { command: "node --disable-warning=ExperimentalWarning --import tsx/esm server/src/index.ts", url: `http://127.0.0.1:${API}/api/health`, cwd: "../..", reuseExistingServer: false, timeout: 60_000,
      env: { PORT: String(API), COMPOSER_PUBLIC_ORIGIN: origin, SESSION_SECRET: "jam-e2e-".repeat(6), COMPOSER_DATA_DIR: DATA, SERVER_RENDER: "0", COMPOSER_ACCESS_CODES: "p1:jam-1,p2:jam-2,p3:jam-3,p4:jam-4,p5:jam-5", RATE_LOGIN_PER_MINUTE: "200", RATE_IP_PER_MINUTE: "5000", LOG_LEVEL: "warn" } },
    { command: `npm run dev -- --host 127.0.0.1 --port ${WEB} --strictPort`, url: `${origin}/`, cwd: "../..", reuseExistingServer: false, timeout: 90_000, env: { GBK_BASE_PATH: "/", GBK_DEV_API_PROXY: `http://127.0.0.1:${API}` } },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns"] } } }],
});
