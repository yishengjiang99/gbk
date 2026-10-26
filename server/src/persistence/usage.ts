// Per-user lifetime engagement counters (accounts, app guests and MCP guest owners) and paywall eligibility (#115).
// Counts only: no content, no IPs. Surfaced to the signed-in user in /api/me; never in MCP/ChatGPT responses.
// Trigger (monetization plan): soft paywall when the 2nd composition completes; again on the 1st WAV/MIDI export
// after that; hard gates at real cost limits (daily AI budget, render limit). A dismiss starts a 24 h cooldown.
import type { DatabaseSync } from "node:sqlite";

export const USAGE_COUNTERS = ["compositions", "ai_runs", "renders", "exports", "shares", "paywall_views"] as const;
export type UsageCounter = typeof USAGE_COUNTERS[number];
export type PaywallReason = "second_composition" | "export_after_2" | "ai_limit" | "render_limit";
export const PAYWALL_COOLDOWN_MS = 24 * 3_600_000;

interface Row { user: string; compositions: number; ai_runs: number; renders: number; exports: number; shares: number; paywall_views: number;
  last_paywall_at: number | null; last_export_at: number | null; dismissed_at: number | null }

export class UsageStore {
  constructor(private db: DatabaseSync, private now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS user_usage (user TEXT PRIMARY KEY, compositions INTEGER NOT NULL DEFAULT 0, ai_runs INTEGER NOT NULL DEFAULT 0,
      renders INTEGER NOT NULL DEFAULT 0, exports INTEGER NOT NULL DEFAULT 0, shares INTEGER NOT NULL DEFAULT 0, paywall_views INTEGER NOT NULL DEFAULT 0,
      last_paywall_at INTEGER, last_export_at INTEGER, dismissed_at INTEGER)`);
  }
  /** Never throws: counting must not break the request it observes. */
  bump(user: string, c: UsageCounter, n = 1) {
    if (!user || !(USAGE_COUNTERS as readonly string[]).includes(c)) return;
    try {
      const now = this.now();
      const extra = c === "exports" ? ", last_export_at = ?" : c === "paywall_views" ? ", last_paywall_at = ?" : "";
      this.db.prepare("INSERT OR IGNORE INTO user_usage (user) VALUES (?)").run(user);
      this.db.prepare(`UPDATE user_usage SET ${c} = ${c} + ?${extra} WHERE user = ?`).run(...(extra ? [n, now, user] : [n, user]));
    } catch { /* ignore */ }
  }
  dismiss(user: string) { this.db.prepare("INSERT OR IGNORE INTO user_usage (user) VALUES (?)").run(user); this.db.prepare("UPDATE user_usage SET dismissed_at = ? WHERE user = ?").run(this.now(), user); }
  private row(user: string): Row {
    return (this.db.prepare("SELECT * FROM user_usage WHERE user = ?").get(user) as unknown as Row | undefined)
      ?? { user, compositions: 0, ai_runs: 0, renders: 0, exports: 0, shares: 0, paywall_views: 0, last_paywall_at: null, last_export_at: null, dismissed_at: null };
  }
  usage(user: string) { const r = this.row(user); return { compositions: r.compositions, ai_runs: r.ai_runs, renders: r.renders, exports: r.exports, shares: r.shares, paywall_views: r.paywall_views, last_paywall_at: r.last_paywall_at }; }
  /** Eligibility only (no UI here). Pro users are never eligible. Hard gates first, then the soft triggers. */
  paywall(user: string, o: { pro: boolean; aiLimit?: boolean; renderLimit?: boolean }): { eligible: boolean; reason: PaywallReason | null; cooldown_until: number | null } {
    const r = this.row(user); const now = this.now();
    const cooldown = r.dismissed_at !== null && r.dismissed_at + PAYWALL_COOLDOWN_MS > now ? r.dismissed_at + PAYWALL_COOLDOWN_MS : null;
    if (o.pro) return { eligible: false, reason: null, cooldown_until: cooldown };
    const reason: PaywallReason | null = o.aiLimit ? "ai_limit" : o.renderLimit ? "render_limit"
      : r.compositions >= 2 && r.paywall_views > 0 && r.last_export_at !== null && r.last_export_at > (r.last_paywall_at ?? 0) ? "export_after_2"
      : r.compositions >= 2 && r.paywall_views === 0 ? "second_composition" : null;
    return { eligible: reason !== null && cooldown === null, reason, cooldown_until: cooldown };
  }
  moveUser(from: string, to: string) {
    const a = this.row(from); if (!this.db.prepare("SELECT 1 FROM user_usage WHERE user = ?").get(from)) return;
    this.db.prepare("INSERT OR IGNORE INTO user_usage (user) VALUES (?)").run(to);
    this.db.prepare(`UPDATE user_usage SET compositions = compositions + ?, ai_runs = ai_runs + ?, renders = renders + ?, exports = exports + ?, shares = shares + ?, paywall_views = paywall_views + ?,
      last_paywall_at = NULLIF(MAX(COALESCE(last_paywall_at, 0), COALESCE(?, 0)), 0), last_export_at = NULLIF(MAX(COALESCE(last_export_at, 0), COALESCE(?, 0)), 0) WHERE user = ?`)
      .run(a.compositions, a.ai_runs, a.renders, a.exports, a.shares, a.paywall_views, a.last_paywall_at, a.last_export_at, to);
    this.db.prepare("DELETE FROM user_usage WHERE user = ?").run(from);
  }
}
