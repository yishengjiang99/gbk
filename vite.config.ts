import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync, utimesSync, createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, constants as zc } from "node:zlib";
import { execSync } from "node:child_process";

/** Release id baked into the bundle for error reports: GBK_RELEASE_ID (deploy.sh) or the git short sha. */
function releaseId(): string {
  if (process.env.GBK_RELEASE_ID) return process.env.GBK_RELEASE_ID;
  try { return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "dev"; } catch { return "dev"; }
}

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

/**
 * Content-hashed SoundFonts (src/audio/soundfont-assets.ts): build writes dist/static/sf/<name>.<sha12>.sf2 plus a
 * gzip -9 sibling for nginx gzip_static, with a fixed mtime so ETag/Last-Modified are stable across deploys. Dev serves
 * the hashed URL from public/static/<name>.sf2.
 */
function hashedSoundFonts(): Plugin {
  const fonts = (JSON.parse(readFileSync("soundfonts/catalog.json", "utf8")).fonts as { file: string; sha256: string; delivery: string }[]).filter((f) => f.delivery === "bundled");
  const hashed = (f: { file: string; sha256: string }) => `${f.file.replace(/\.sf2$/i, "")}.${f.sha256.slice(0, 12)}.sf2`;
  let outDir = "dist";
  const FIXED = new Date("2020-01-01T00:00:00Z");
  return {
    name: "gbk-hashed-soundfonts",
    configResolved(c) { outDir = c.build.outDir; },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /\/static\/sf\/([^/?]+)\.[0-9a-f]{12}\.sf2(\?.*)?$/.exec(req.url ?? "");
        const src = m && join("public", "static", `${m[1]}.sf2`);
        if (!src || !existsSync(src)) return next();
        res.setHeader("content-type", "application/octet-stream"); res.setHeader("content-length", String(statSync(src).size));
        createReadStream(src).pipe(res);
      });
    },
    closeBundle() {
      const dir = join(outDir, "static", "sf"); mkdirSync(dir, { recursive: true });
      for (const f of fonts) {
        const src = join(outDir, "static", f.file); if (!existsSync(src)) continue;
        const dest = join(dir, hashed(f)); copyFileSync(src, dest);
        writeFileSync(`${dest}.gz`, gzipSync(readFileSync(dest), { level: zc.Z_BEST_COMPRESSION }));
        for (const p of [dest, `${dest}.gz`]) utimesSync(p, FIXED, FIXED);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), webMcpOriginTrial(), hashedSoundFonts()],
  define: { __GBK_RELEASE__: JSON.stringify(releaseId()) },
  // "/" for compose.grepawk.com (default), "/gbk/" for the GitHub Pages build (GBK_BASE_PATH=/gbk/).
  base: process.env.GBK_BASE_PATH ?? "/",
  // Local dev / e2e only: proxy same-origin /api (+ WebSocket) to a Composer agent server, like nginx does in production.
  ...(process.env.GBK_DEV_API_PROXY ? { server: { proxy: { "/api": { target: process.env.GBK_DEV_API_PROXY, ws: true, changeOrigin: false } } }, preview: { proxy: { "/api": { target: process.env.GBK_DEV_API_PROXY, ws: true, changeOrigin: false } } } } : {}),
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
