#!/usr/bin/env node
// Funnel analytics summary on the server (aggregate daily counts only; no IPs or user ids are stored):
//   cd /var/www/gbk-composer/current && sudo -u www-data node --disable-warning=ExperimentalWarning deploy/funnel.mjs [--days 30] [--json] [--db PATH]
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
const a = process.argv.slice(2); const opt = (k, d) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
if (a.includes("--help")) { console.log("usage: funnel.mjs [--days N] [--json] [--db PATH]"); process.exit(0); }
const db = new DatabaseSync(opt("db", join(process.env.COMPOSER_DATA_DIR ?? "/var/lib/gbk-composer", "analytics.sqlite")), { readOnly: true });
const days = Number(opt("days", 30));
const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
const rows = db.prepare("SELECT day, event, source, count FROM funnel_daily WHERE day >= ? ORDER BY day, event, source").all(since);
if (a.includes("--json")) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
const ORDER = ["page_view_landing", "page_view_chatgpt", "page_view_legal", "mcp_connect", "create", "edit", "render_requested", "browser_render_completed", "midi_download", "wav_download", "claim", "publish", "delete"];
const tot = {}, src = {};
for (const r of rows) { tot[r.event] = (tot[r.event] ?? 0) + r.count; if (r.source) (src[r.event] ??= {})[r.source] = (src[r.event]?.[r.source] ?? 0) + r.count; }
console.log(`GBK funnel, last ${days} days (since ${since} UTC)`);
for (const e of ORDER) console.log(`  ${e.padEnd(26)} ${String(tot[e] ?? 0).padStart(7)}  ${src[e] ? Object.entries(src[e]).map(([k, v]) => `${k}=${v}`).join(" ") : ""}`);
