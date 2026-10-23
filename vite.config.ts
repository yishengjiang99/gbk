import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, existsSync } from "node:fs";

/**
 * WebMCP origin trial: inject <meta http-equiv="origin-trial" content="TOKEN"> into every HTML entry when a token is
 * configured. Tokens are origin-bound (register https://yishengjiang99.github.io at
 * https://developer.chrome.com/origintrials) and are never committed. Sources, first wins:
 *   1. env GBK_WEBMCP_ORIGIN_TRIAL_TOKEN (CI: repo variable/secret of the same name, see .github/workflows/deploy.yml)
 *   2. gitignored file webmcp-origin-trial.local.json  {"token": "..."}
 * Several tokens (e.g. localhost + github.io) may be given comma-separated.
 */
export function originTrialTokens(env: NodeJS.ProcessEnv = process.env, file = "webmcp-origin-trial.local.json"): string[] {
  let raw = env.GBK_WEBMCP_ORIGIN_TRIAL_TOKEN ?? "";
  if (!raw.trim() && existsSync(file)) { try { raw = String(JSON.parse(readFileSync(file, "utf8")).token ?? ""); } catch { raw = ""; } }
  return raw.split(",").map((t) => t.trim()).filter((t) => /^[A-Za-z0-9+/=]+$/.test(t));
}

function webMcpOriginTrial(): Plugin {
  const tokens = originTrialTokens();
  return {
    name: "gbk-webmcp-origin-trial",
    transformIndexHtml: () => tokens.map((content) => ({ tag: "meta", attrs: { "http-equiv": "origin-trial", content }, injectTo: "head-prepend" as const })),
  };
}

export default defineConfig({
  plugins: [react(), webMcpOriginTrial()],
  base: "/gbk/",
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        "sheet-cam": "sheet-cam.html",
        "midi-clock": "midi-clock.html",
      },
    },
  },
});
