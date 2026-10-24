// Privacy-respecting funnel analytics: aggregate daily counters only. No IPs, no user or account ids, no
// prompts, no project content, no tokens, no URLs/query strings — just (UTC day, event, source) -> count.
// Lives in analytics.sqlite. Read via GET /api/admin/funnel (COMPOSER_ADMIN_USERS) or deploy/funnel.mjs.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const FUNNEL_EVENTS = [
  "page_view_landing", "page_view_chatgpt", "page_view_legal",
  "mcp_connect", "create", "edit", "render_requested", "browser_render_completed",
  "midi_download", "wav_download", "claim", "publish", "delete",
] as const;
export type FunnelEvent = typeof FUNNEL_EVENTS[number];
/** Coarse, non-identifying segment: who (guest/account) or where (widget/studio) — never an identity. */
export const FUNNEL_SOURCES = ["", "guest", "account", "widget", "studio", "studio-tab", "web"] as const;
export type FunnelSource = typeof FUNNEL_SOURCES[number];

export class FunnelStore {
  private db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS funnel_daily (day TEXT NOT NULL, event TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, event, source));`);
  }
  /** Never throws: analytics must not break the request it observes. Unknown events/sources are dropped. */
  bump(event: FunnelEvent, source: FunnelSource = "", now = Date.now()) {
    if (!(FUNNEL_EVENTS as readonly string[]).includes(event) || !(FUNNEL_SOURCES as readonly string[]).includes(source)) return;
    try {
      this.db.prepare("INSERT INTO funnel_daily (day, event, source, count) VALUES (?,?,?,1) ON CONFLICT(day, event, source) DO UPDATE SET count = count + 1")
        .run(new Date(now).toISOString().slice(0, 10), event, source);
    } catch { /* best effort */ }
  }
  /** Totals per event (and per source) over the last `days` UTC days, plus a per-day series. */
  summary(days = 30, now = Date.now()) {
    const since = new Date(now - (Math.max(1, days) - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = this.db.prepare("SELECT day, event, source, count FROM funnel_daily WHERE day >= ? ORDER BY day, event, source").all(since) as { day: string; event: string; source: string; count: number }[];
    const totals: Record<string, number> = Object.fromEntries(FUNNEL_EVENTS.map((e) => [e, 0]));
    const bySource: Record<string, Record<string, number>> = {};
    const byDay: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      totals[r.event] = (totals[r.event] ?? 0) + r.count;
      if (r.source) (bySource[r.event] ??= {})[r.source] = ((bySource[r.event] ??= {})[r.source] ?? 0) + r.count;
      (byDay[r.day] ??= {})[r.event] = ((byDay[r.day] ??= {})[r.event] ?? 0) + r.count;
    }
    const rate = (a: string, b: string) => (totals[b] ? +(totals[a] / totals[b]).toFixed(3) : null);
    return { since, days, totals, bySource, byDay,
      conversion: { createPerConnect: rate("create", "mcp_connect"), renderPerCreate: rate("render_requested", "create"),
        browserRenderPerRequest: rate("browser_render_completed", "render_requested"), downloadPerCreate: totals.create ? +((totals.midi_download + totals.wav_download) / totals.create).toFixed(3) : null } };
  }
  close() { try { this.db.close(); } catch { /* closed */ } }
}
