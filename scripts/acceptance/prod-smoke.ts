// Production smoke test (#72 Phase 8). Safe to run against prod: every composition it creates is private and is
// deleted at the end with its own key; nothing is published; no tokens are printed.
//   node --import tsx/esm scripts/acceptance/prod-smoke.ts [https://compose.grepawk.com]
// Covers: HTTPS pages (landing, gallery, legal, sitemap), MCP initialize + tools/list, anonymous create, edit with
// the capability, headless server render, WAV/SMF validation, cross-project denial, read-only key cannot edit or
// publish, no public sharing, cancel without partial artifacts, cleanup (all via runAcceptance).
import { runAcceptance } from "./mcp-acceptance.ts";

const base = process.argv[2] ?? "https://compose.grepawk.com";
const fails: string[] = [];
for (const [path, want] of [["/", "text/html"], ["/chatgpt", "text/html"], ["/chatgpt/gallery", "text/html"], ["/privacy", "text/html"], ["/sitemap.xml", "xml"], ["/studio", "text/html"]] as const) {
  const r = await fetch(base + path); const ct = r.headers.get("content-type") ?? "";
  const good = r.status === 200 && ct.includes(want); console.log(`${good ? "PASS" : "FAIL"} [pages] GET ${path} (${r.status} ${ct})`); if (!good) fails.push(path);
}
const checks = await runAcceptance(base, { log: console.log });
const bad = checks.filter((c) => !c.ok).length + fails.length;
console.log(`${checks.length + 6 - bad}/${checks.length + 6} smoke checks passed against ${new URL(base).host}`);
process.exit(bad ? 1 : 0);
