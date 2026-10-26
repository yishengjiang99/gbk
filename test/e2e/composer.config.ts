// Composer e2e: real Composer server (agent loop + bridge) + deterministic fake OpenAI-compatible model + the real
// GBK workstation in plain Chrome/Chromium (NO WebMCP flags), served at "/" like compose.grepawk.com.
import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Fresh data dir per run so a previous conversation never leaks into the next run.
const DATA = process.env.GBK_E2E_DATA ?? mkdtempSync(join(tmpdir(), "gbk-composer-e2e-"));
const WEB = 5181, API = 8781, MODEL = 8799;
const origin = `http://127.0.0.1:${WEB}`;
const node22 = process.env.GBK_NODE22 ?? "node";
export default defineConfig({
  testDir: ".", testMatch: /e2e\/(composer|social|guest-publish|studio-desktop)\.spec\.ts$/, timeout: 600_000, expect: { timeout: 20_000 }, workers: 1,
  use: { baseURL: `${origin}/`, trace: "retain-on-failure" },
  webServer: [
    { command: `${node22} --import tsx/esm server/test/fake-model.ts`, url: `http://127.0.0.1:${MODEL}/healthz`, reuseExistingServer: false, cwd: "../..", env: { FAKE_MODEL_PORT: String(MODEL) }, timeout: 30_000, ignoreHTTPSErrors: true },
    { command: `${node22} --disable-warning=ExperimentalWarning --import tsx/esm server/src/index.ts`, url: `http://127.0.0.1:${API}/api/health`, cwd: "../..", reuseExistingServer: false, timeout: 60_000,
      env: { PORT: String(API), COMPOSER_PUBLIC_ORIGIN: origin, LLM_BASE_URL: `http://127.0.0.1:${MODEL}/v1`, LLM_API_KEY: "fake-key", LLM_MODEL: "fake-composer", LLM_PROVIDER_NAME: "fake (e2e)", SESSION_SECRET: "e2e-".repeat(10), COMPOSER_ACCESS_CODES: "tester:e2e-code,viewer2:e2e-code-2", COMPOSER_DATA_DIR: DATA, AGENT_TOOL_TIMEOUT_MS: "300000", RATE_MESSAGES_PER_MINUTE: "30", RATE_IP_PER_MINUTE: "5000", RATE_LOGIN_PER_MINUTE: "200", RATE_SHARES_PER_MINUTE: "500", LOG_LEVEL: "warn" } },
    { command: `npm run dev -- --host 127.0.0.1 --port ${WEB} --strictPort`, url: `${origin}/`, cwd: "../..", reuseExistingServer: false, timeout: 60_000, env: { GBK_BASE_PATH: "/", GBK_DEV_API_PROXY: `http://127.0.0.1:${API}` } },
  ],
  projects: [
    { name: "chrome-no-webmcp", use: { ...devices["Desktop Chrome"], channel: process.env.PW_CHROME_CHANNEL ?? "chrome", viewport: { width: 1500, height: 950 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /mobile|social/ },
    { name: "mobile-webkit", use: { ...devices["iPhone 13"] }, grep: /mobile composer view|social|guest publish/ },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, grep: /smoke/ },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, grep: /smoke/ },
  ],
});
