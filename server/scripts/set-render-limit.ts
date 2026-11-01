// Admin: set or clear a per-token-family daily MCP render limit (overrides MCP_MAX_RENDERS_PER_DAY for that family).
//   set-render-limit <family-prefix> <n|null> [--db <path to mcp.sqlite>]
// The DB defaults to $COMPOSER_DATA_DIR/mcp.sqlite. Runs the idempotent column migration first. Prints family ids and
// row counts only — never token values or hashes. Opens the SQLite file directly (no McpStore startup side effects),
// so it is safe to run against a live server.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { McpStore, setFamilyRenderLimit } from "../src/mcp/store.ts";

export function parseLimit(v: string | undefined): number | null {
  if (v === "null" || v === "none") return null;
  if (!v || !/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 1_000_000) throw new Error(`limit must be a positive integer or "null", got ${JSON.stringify(v)}`);
  return Number(v);
}

function main(argv: string[]) {
  const args = [...argv]; let db: string | undefined;
  const i = args.indexOf("--db"); if (i >= 0) { db = args[i + 1]; args.splice(i, 2); }
  const [prefix, raw] = args;
  if (!prefix || raw === undefined) { console.error("usage: set-render-limit <family-prefix> <n|null> [--db path/to/mcp.sqlite]"); return 2; }
  if (prefix.length < 6) { console.error("family prefix must be at least 6 characters"); return 2; }
  const limit = parseLimit(raw);
  const file = db ?? join(process.env.COMPOSER_DATA_DIR ?? "./composer-data", "mcp.sqlite");
  if (!existsSync(file)) { console.error(`no MCP database at ${file}`); return 1; }
  const conn = new DatabaseSync(file);
  try {
    conn.exec("PRAGMA busy_timeout=5000");
    McpStore.migrate(conn);
    const r = setFamilyRenderLimit(conn, prefix, limit);
    if (!r.families.length) { console.error(`no token family starts with ${JSON.stringify(prefix)}; nothing changed`); return 1; }
    console.log(`daily_render_limit=${limit ?? "null (global cap)"} on ${r.tokens} token row(s) in ${r.families.length} famil${r.families.length === 1 ? "y" : "ies"}: ${r.families.join(", ")}`);
    return 0;
  } finally { conn.close(); }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("set-render-limit.mjs")) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error((e as Error).message); process.exitCode = 2; }
}
