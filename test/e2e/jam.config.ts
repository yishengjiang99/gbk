// Live Jam e2e: real server (rooms + /api/jam/ws) + Vite app at "/", 2-4 independent headless Chromium contexts
// with real RTCPeerConnections. Run: npx playwright test --config test/e2e/jam.config.ts
import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";
type WebServer = Extract<NonNullable<PlaywrightTestConfig["webServer"]>, unknown[]>[number];
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const DATA = mkdtempSync(join(tmpdir(), "gbk-jam-e2e-"));
const WEB = 5211, API = 8811; const origin = `http://127.0.0.1:${WEB}`;
// JAM_E2E_RELAY=1: start a local coturn (scripts/jam-turn-local.sh; TURNSERVER= points at the binary) and force
// every client to relay-only ICE, so all tests run through TURN.
const RELAY = process.env.JAM_E2E_RELAY === "1"; const TURN_SECRET = "jam-e2e-turn-secret-0123456789";
const relayEnv: Record<string, string> = RELAY ? { JAM_TURN_URLS: "turn:127.0.0.1:3478?transport=udp,turn:127.0.0.1:3478?transport=tcp", JAM_TURN_SHARED_SECRET: TURN_SECRET, JAM_RELAY_ONLY: "1" } : {};
export default defineConfig({
  testDir: ".", testMatch: /e2e\/jam(-mobile)?\.spec\.ts$/, timeout: 180_000, expect: { timeout: 30_000 }, workers: 1,
  use: { baseURL: `${origin}/`, trace: "retain-on-failure" },
  webServer: [
    { command: "node --disable-warning=ExperimentalWarning --import tsx/esm server/src/index.ts", url: `http://127.0.0.1:${API}/api/health`, cwd: "../..", reuseExistingServer: false, timeout: 60_000,
      env: { PORT: String(API), COMPOSER_PUBLIC_ORIGIN: origin, SESSION_SECRET: "jam-e2e-".repeat(6), COMPOSER_DATA_DIR: DATA, SERVER_RENDER: "0", COMPOSER_ACCESS_CODES: "p1:jam-1,p2:jam-2,p3:jam-3,p4:jam-4,p5:jam-5", RATE_LOGIN_PER_MINUTE: "200", RATE_IP_PER_MINUTE: "5000", JAM_JOINS_PER_MINUTE: "200", LOG_LEVEL: "warn", ...relayEnv } },
    { command: `npm run dev -- --host 127.0.0.1 --port ${WEB} --strictPort`, url: `${origin}/`, cwd: "../..", reuseExistingServer: false, timeout: 90_000, env: { GBK_BASE_PATH: "/", GBK_DEV_API_PROXY: `http://127.0.0.1:${API}` } },
    ...(RELAY ? [{ command: "scripts/jam-turn-local.sh", port: 3478, cwd: "../..", reuseExistingServer: false, timeout: 20_000, env: { JAM_TURN_SECRET: TURN_SECRET, TURNSERVER: process.env.TURNSERVER ?? "turnserver" } } as WebServer] : []),
  ],
  projects: [
    { name: "iphone-se", testMatch: /jam-mobile\.spec\.ts$/, use: { ...devices["iPhone SE"] } },
    { name: "iphone-14", testMatch: /jam-mobile\.spec\.ts$/, use: { ...devices["iPhone 14"] } },
    { name: "chromium", testMatch: /jam\.spec\.ts$/, use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns"] } } }
  ],
});
