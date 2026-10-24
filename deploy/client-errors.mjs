#!/usr/bin/env node
// Read browser error reports on the server (no HTTP, no auth needed beyond shell access):
//   cd /var/www/gbk-composer/current && sudo -u www-data node --disable-warning=ExperimentalWarning deploy/client-errors.mjs [--limit 20] [--since 2026-10-24] [--user ID] [--kind report] [--json]
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
const a = process.argv.slice(2); const opt = (k, d) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
if (a.includes("--help")) { console.log("usage: client-errors.mjs [--limit N] [--since ISO|ms] [--user ID] [--kind error|unhandledrejection|console|report] [--release ID] [--json] [--db PATH]"); process.exit(0); }
const db = new DatabaseSync(opt("db", join(process.env.COMPOSER_DATA_DIR ?? "/var/lib/gbk-composer", "accounts.sqlite")), { readOnly: true });
const where = [], args = [];
const since = opt("since"); if (since) { where.push("created_at >= ?"); args.push(/^\d+$/.test(since) ? Number(since) : Date.parse(since)); }
for (const [k, col] of [["user", "user_id"], ["kind", "kind"], ["release", "release"]]) { const v = opt(k); if (v) { where.push(`${col} = ?`); args.push(v); } }
const rows = db.prepare(`SELECT * FROM client_errors ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`).all(...args, Number(opt("limit", 20)));
if (a.includes("--json")) console.log(JSON.stringify(rows, null, 2));
else for (const r of rows) {
  console.log(`#${r.id} ${new Date(r.created_at).toISOString()} [${r.kind}] x${r.count} user=${r.user_id ?? "-"} release=${r.release} ${r.url}`);
  console.log(`  ${r.message}`); if (r.stack) console.log(r.stack.split("\n").slice(0, 4).map((l) => "    " + l).join("\n"));
  if (r.context !== "{}") console.log(`  context: ${r.context}`); if (r.breadcrumbs !== "[]") console.log(`  crumbs: ${r.breadcrumbs}`);
}
