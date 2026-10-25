#!/usr/bin/env node
// Funnel analytics summary on the server (aggregate daily counts only; no IPs or user ids are stored):
//   cd /var/www/gbk-composer/current && sudo -u www-data node --disable-warning=ExperimentalWarning deploy/funnel.mjs [--days 30] [--json] [--db PATH]
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
const a = process.argv.slice(2); const opt = (k, d) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
if (a.includes("--help")) { console.log("usage: funnel.mjs [--days N] [--daily] [--json] [--db PATH]"); process.exit(0); }
const db = new DatabaseSync(opt("db", join(process.env.COMPOSER_DATA_DIR ?? "/var/lib/gbk-composer", "analytics.sqlite")), { readOnly: true });
const days = Number(opt("days", 30));
const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
const rows = db.prepare("SELECT day, event, source, count FROM funnel_daily WHERE day >= ? ORDER BY day, event, source").all(since);
if (a.includes("--json")) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
const ORDER = ["page_view_landing", "page_view_chatgpt", "page_view_legal", "mcp_connect", "create", "edit", "render_requested", "browser_render_completed", "midi_download", "wav_download", "claim", "publish", "delete",
  "page_view_gallery", "first_tool_call", "server_render_completed", "render_failed", "install_cta_click", "install_link_unavailable"];
const tot = {}, src = {};
for (const r of rows) { tot[r.event] = (tot[r.event] ?? 0) + r.count; if (r.source) (src[r.event] ??= {})[r.source] = (src[r.event]?.[r.source] ?? 0) + r.count; }
console.log(`GBK funnel, last ${days} days (since ${since} UTC)`);
for (const e of ORDER) console.log(`  ${e.padEnd(26)} ${String(tot[e] ?? 0).padStart(7)}  ${src[e] ? Object.entries(src[e]).map(([k, v]) => `${k}=${v}`).join(" ") : ""}`);
// Ratios of aggregate counts (not unique users: GBK stores no identifiers, so nothing here counts people).
const r = (a, b) => (tot[b] ? (tot[a] ?? 0) / tot[b] : null);
const fmt = (v) => (v == null ? "n/a" : v.toFixed(2));
console.log("Ratios (event counts, not people):");
for (const [label, a, b] of [["create / mcp_connect", "create", "mcp_connect"], ["first_tool_call / mcp_connect", "first_tool_call", "mcp_connect"], ["render_requested / create", "render_requested", "create"],
  ["server_render_completed / render_requested", "server_render_completed", "render_requested"], ["render_failed / render_requested", "render_failed", "render_requested"],
  ["install_cta_click / page_view_chatgpt", "install_cta_click", "page_view_chatgpt"]]) console.log(`  ${label.padEnd(44)} ${fmt(r(a, b))}`);
if (a.includes("--daily")) {
  const KEY = ["page_view_chatgpt", "mcp_connect", "first_tool_call", "create", "edit", "render_requested", "server_render_completed", "browser_render_completed", "render_failed", "wav_download", "midi_download"];
  const byDay = {}; for (const row of rows) (byDay[row.day] ??= {})[row.event] = (byDay[row.day]?.[row.event] ?? 0) + row.count;
  console.log(["day".padEnd(10), ...KEY.map((k, i) => `e${i}`.padStart(6))].join(" ")); KEY.forEach((k, i) => console.log(`  e${i} = ${k}`));
  for (const [d, v] of Object.entries(byDay)) console.log([d, ...KEY.map((k) => String(v[k] ?? 0).padStart(6))].join(" "));
}
