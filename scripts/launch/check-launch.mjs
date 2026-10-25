#!/usr/bin/env node
// Launch CI checks (#72 Phase 8), no network and no secrets:
//  1. plugin manifest: plugin.json + mcp.json parse, MCP URL is the prod /mcp, auth none, icons exist.
//  2. deploy package: after `npm run build:server`, the render worker and widget assets exist and deploy.sh ships them.
//  3. token-leak scan of tracked files: GBK capability tokens, GitHub/xAI/OpenAI keys, private keys.
// Usage: node scripts/launch/check-launch.mjs [--skip-build-artifacts]
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const fail = []; const ok = (c, m) => { if (!c) fail.push(m); };

const pkg = "plugins/gbk-composer";
const mcp = JSON.parse(readFileSync(join(pkg, "mcp.json"), "utf8"));
const srv = Object.values(mcp.mcpServers ?? {})[0] ?? {};
ok(srv.url === "https://compose.grepawk.com/mcp", `mcp.json url is ${srv.url}`);
ok(srv.type === "streamable-http", "mcp.json type streamable-http");
ok(srv.extensions?.["com.openai"]?.auth?.type === "none", "mcp.json auth none");
const plugin = JSON.parse(readFileSync(join(pkg, "plugin.json"), "utf8"));
const json = JSON.stringify(plugin);
for (const m of json.matchAll(/"(\.\/)?assets\/[^"]+"/g)) { const f = join(pkg, m[0].slice(1, -1)); ok(existsSync(f), `plugin.json references missing ${f}`); }
for (const k of ["shortDescription", "longDescription", "displayName", "category"]) ok(json.includes(`"${k}"`), `plugin.json has ${k}`);

if (!process.argv.includes("--skip-build-artifacts")) {
  ok(existsSync("server/dist/index.mjs"), "server/dist/index.mjs built");
  ok(existsSync("server/dist/render-worker.mjs"), "server/dist/render-worker.mjs built");
  ok(existsSync("server/dist/widget") && readdirSync("server/dist/widget").length > 0, "server/dist/widget assets built");
  const deploy = readFileSync("deploy/deploy.sh", "utf8");
  for (const f of ["server/dist/index.mjs", "server/dist/render-worker.mjs", "server/dist/widget", "deploy"]) ok(deploy.includes(f), `deploy.sh tarball includes ${f}`);
}

const PATTERNS = [
  [/cmp_[A-Za-z0-9_-]{16}\.(edit|read)\.[A-Za-z0-9_-]{43}/, "GBK capability token"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/, "GitHub token"], [/\bxai-[A-Za-z0-9]{40,}/, "xAI key"], [/\bsk-[A-Za-z0-9_-]{32,}/, "OpenAI-style key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
];
if (process.argv.includes("--self-test")) {
  const samples = ["cmp_" + "a".repeat(16) + ".edit." + "b".repeat(43), "gh" + "o_" + "c".repeat(36), "xai-" + "d".repeat(40), "-----BEGIN RSA PRIVATE" + " KEY-----"];
  for (const t of samples) if (!PATTERNS.some(([re]) => re.test(t))) { console.error("self-test: pattern missed", t.slice(0, 8)); process.exit(1); }
  console.log("leak-scan self-test OK"); process.exit(0);
}
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
for (const f of files) {
  if (!existsSync(f) || statSync(f).size > 2_000_000 || /\.(sf2|png|jpg|wav|mid|onnx|wasm|pdf|ico|gz|zip|mp4)$/i.test(f)) continue;
  const t = readFileSync(f, "utf8");
  for (const [re, name] of PATTERNS) if (re.test(t)) fail.push(`${name} pattern in ${f}`);
}
if (fail.length) { console.error("launch checks FAILED:\n  " + fail.join("\n  ")); process.exit(1); }
console.log(`launch checks OK (manifest, deploy package, leak scan of ${files.length} files)`);
