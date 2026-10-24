// Captures OpenAI submission media (NOT a test gate): starter-prompt screenshots at exactly 706 px wide and a
// demo recording of a studio session. Same local stack as composer.config.ts (real server + real workstation +
// deterministic fake model), plus MCP_TEST_AUTH so the capture can drive /mcp as the signed-in studio user.
//   GBK_NODE22="npx -y node@22" npx playwright test --config test/e2e/submission.config.ts
import { defineConfig, devices } from "@playwright/test";
import base from "./composer.config.ts";
const servers = (base.webServer as { env?: Record<string, string> }[]).map((w) => (w.env?.COMPOSER_ACCESS_CODES ? { ...w, env: { ...w.env, MCP_TEST_AUTH: "1" } } : w));
export default defineConfig({
  ...base, testMatch: /e2e\/submission-media\.capture\.ts$/, webServer: servers as never,
  projects: [{ name: "capture", use: { ...devices["Desktop Chrome"], channel: process.env.PW_CHROME_CHANNEL ?? "chrome", viewport: { width: 1280, height: 800 } } }],
});
