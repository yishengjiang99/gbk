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
  // Launch analytics (#72 Phase 6)
  "page_view_gallery", "first_tool_call", "server_render_completed", "render_failed", "install_cta_click", "install_link_unavailable",
] as const;
export type FunnelEvent = typeof FUNNEL_EVENTS[number];
/** Coarse, non-identifying segment: who (guest/account) or where (widget/studio) — never an identity. */
export const FUNNEL_SOURCES = ["", "guest", "account", "widget", "studio", "studio-tab", "web", "server"] as const;
export type FunnelSource = typeof FUNNEL_SOURCES[number];

/** Billing funnel taxonomy (#118): the monetization plan's event list. Aggregates live in billing_daily
 * (same analytics DB, same aggregate-only rule: no identities — the per-account support log is separate,
 * in persistence/billing.ts). Surface/platform are coarse segments (where / on what), never identities. */
export const BILLING_EVENTS = [
  "signup", "first_composition", "composition_created", "export", "share_published",
  "paywall_view", "paywall_dismiss", "plan_select", "checkout_start",
  "purchase", "trial_start", "trial_convert", "renewal", "cancel", "refund", "restore",
] as const;
export type BillingEvent = typeof BILLING_EVENTS[number];
/** The funnel steps the admin report tracks end to end. */
export const BILLING_STEPS = ["paywall_view", "checkout_start", "purchase"] as const;

export class FunnelStore {
  private db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS funnel_daily (day TEXT NOT NULL, event TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, event, source));
      CREATE TABLE IF NOT EXISTS billing_daily (day TEXT NOT NULL, event TEXT NOT NULL, surface TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, event, surface, platform));`);
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
        browserRenderPerRequest: rate("browser_render_completed", "render_requested"), downloadPerCreate: totals.create ? +((totals.midi_download + totals.wav_download) / totals.create).toFixed(3) : null,
        firstToolCallPerConnect: rate("first_tool_call", "mcp_connect"), serverRenderPerRequest: rate("server_render_completed", "render_requested"),
        renderFailurePerRequest: rate("render_failed", "render_requested"), installClickPerChatgptView: rate("install_cta_click", "page_view_chatgpt") } };
  }
  /** Billing aggregate bump (#118). Never throws; unknown events are dropped. Dimensions are sanitized
   * by the caller (BillingRecorder); they are segments, never identities. */
  bumpBilling(event: BillingEvent, surface = "", platform = "", now = Date.now()) {
    if (!(BILLING_EVENTS as readonly string[]).includes(event)) return;
    try {
      this.db.prepare("INSERT INTO billing_daily (day, event, surface, platform, count) VALUES (?,?,?,?,1) ON CONFLICT(day, event, surface, platform) DO UPDATE SET count = count + 1")
        .run(new Date(now).toISOString().slice(0, 10), event, surface.slice(0, 32), platform.slice(0, 32));
    } catch { /* best effort */ }
  }
  /** Billing totals over the last `days` UTC days, plus the paywall_view -> checkout_start -> purchase
   * steps overall and split by surface and by platform, plus a per-day series. */
  billingSummary(days = 30, now = Date.now()) {
    const since = new Date(now - (Math.max(1, days) - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = this.db.prepare("SELECT day, event, surface, platform, count FROM billing_daily WHERE day >= ? ORDER BY day, event, surface, platform").all(since) as { day: string; event: string; surface: string; platform: string; count: number }[];
    const totals: Record<string, number> = Object.fromEntries(BILLING_EVENTS.map((e) => [e, 0]));
    const byDay: Record<string, Record<string, number>> = {};
    const stepRows = new Map<string, Record<string, number>>();
    const stepRow = (kind: string, key: string) => { const k = `${kind}:${key}`; let r = stepRows.get(k); if (!r) { r = { paywall_view: 0, checkout_start: 0, purchase: 0 }; stepRows.set(k, r); } return r; };
    for (const r of rows) {
      totals[r.event] = (totals[r.event] ?? 0) + r.count;
      (byDay[r.day] ??= {})[r.event] = ((byDay[r.day] ??= {})[r.event] ?? 0) + r.count;
      if ((BILLING_STEPS as readonly string[]).includes(r.event)) {
        const all = stepRow("all", ""); all[r.event] = (all[r.event] ?? 0) + r.count;
        if (r.surface) { const s = stepRow("surface", r.surface); s[r.event] = (s[r.event] ?? 0) + r.count; }
        if (r.platform) { const p = stepRow("platform", r.platform); p[r.event] = (p[r.event] ?? 0) + r.count; }
      }
    }
    const rate = (a: number, b: number) => (b ? +(a / b).toFixed(3) : null);
    const finish = (kind: string, key: string, r: Record<string, number>) => ({ [kind]: key, paywall_view: r.paywall_view ?? 0, checkout_start: r.checkout_start ?? 0, purchase: r.purchase ?? 0,
      view_to_checkout: rate(r.checkout_start ?? 0, r.paywall_view ?? 0), checkout_to_purchase: rate(r.purchase ?? 0, r.checkout_start ?? 0), view_to_purchase: rate(r.purchase ?? 0, r.paywall_view ?? 0) });
    const bySurface: object[] = [], byPlatform: object[] = [];
    for (const [k, r] of stepRows) { const [kind, key] = k.split(/:(.*)/s).slice(0, 2); if (kind === "surface") bySurface.push(finish("surface", key, r)); else if (kind === "platform") byPlatform.push(finish("platform", key, r)); }
    const all = stepRows.get("all:") ?? { paywall_view: 0, checkout_start: 0, purchase: 0 };
    return { since, days, totals, byDay, steps: { overall: finish("scope", "all", all), bySurface, byPlatform } };
  }
  close() { try { this.db.close(); } catch { /* closed */ } }
}
