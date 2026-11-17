// Per-user lifetime engagement counters (accounts, app guests and MCP guest owners) and paywall eligibility (#115).
// Counts only: no content, no IPs. Surfaced to the signed-in user in /api/me; never in MCP/ChatGPT responses.
// Triggers (paywall plan approved 2026-11-16; no landing paywall): export/download is Pro only (a hard block the
// client asks POST /api/paywall/check about, see routes/paywall.ts); hard gates at the real cost limits (daily AI
// budget, render limit); and a one-time, dismissible popup when a free user starts their 3rd composition
// (`third_song_seen` remembers it per account). A dismiss of a hard modal starts a 1 h cooldown.
import type { DatabaseSync } from "node:sqlite";

export const USAGE_COUNTERS = ["compositions", "ai_runs", "renders", "exports", "shares", "paywall_views"] as const;
export type UsageCounter = typeof USAGE_COUNTERS[number];
/** The paywall reasons (the stable iOS/web contract, docs/social-api.md "Paywall"): `export` (hard, Pro only),
 *  `ai_budget` / `render_limit` (hard, free daily limit hit), `third_song` (soft, once). */
export const PAYWALL_REASONS = ["export", "ai_budget", "render_limit", "third_song"] as const;
export type PaywallReason = typeof PAYWALL_REASONS[number];
// 1 h (was 24 h until 2026-10-26): the owner directed the paywall to show more frequently — a dismiss
// silences soft triggers for an hour, then the landing/composition triggers may present again.
export const PAYWALL_COOLDOWN_MS = 3_600_000;

interface Row { user: string; compositions: number; ai_runs: number; renders: number; exports: number; shares: number; paywall_views: number;
  last_paywall_at: number | null; last_export_at: number | null; dismissed_at: number | null; third_song_at: number | null }

export class UsageStore {
  constructor(private db: DatabaseSync, private now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS user_usage (user TEXT PRIMARY KEY, compositions INTEGER NOT NULL DEFAULT 0, ai_runs INTEGER NOT NULL DEFAULT 0,
      renders INTEGER NOT NULL DEFAULT 0, exports INTEGER NOT NULL DEFAULT 0, shares INTEGER NOT NULL DEFAULT 0, paywall_views INTEGER NOT NULL DEFAULT 0,
      last_paywall_at INTEGER, last_export_at INTEGER, dismissed_at INTEGER)`);
    // Paywall plan (2026-11-16): when the one-time 3rd-song popup was shown or dismissed (null = not yet).
    const cols = (db.prepare("PRAGMA table_info(user_usage)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("third_song_at")) db.exec("ALTER TABLE user_usage ADD COLUMN third_song_at INTEGER");
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
  /** The 3rd-song popup was shown (or dismissed): it never presents again for this account. Idempotent. */
  markThirdSong(user: string) {
    if (!user) return;
    try {
      this.db.prepare("INSERT OR IGNORE INTO user_usage (user) VALUES (?)").run(user);
      this.db.prepare("UPDATE user_usage SET third_song_at = COALESCE(third_song_at, ?) WHERE user = ?").run(this.now(), user);
    } catch { /* ignore */ }
  }
  private row(user: string): Row {
    return (this.db.prepare("SELECT * FROM user_usage WHERE user = ?").get(user) as unknown as Row | undefined)
      ?? { user, compositions: 0, ai_runs: 0, renders: 0, exports: 0, shares: 0, paywall_views: 0, last_paywall_at: null, last_export_at: null, dismissed_at: null, third_song_at: null };
  }
  usage(user: string) { const r = this.row(user); return { compositions: r.compositions, ai_runs: r.ai_runs, renders: r.renders, exports: r.exports, shares: r.shares, paywall_views: r.paywall_views, last_paywall_at: r.last_paywall_at }; }
  /** Eligibility only (no UI here). Pro users are never eligible. Only the hard gates are server-driven reasons:
   *  the export block is asked per action (POST /api/paywall/check) and the 3rd-song popup is decided by the
   *  client when a song starts, using `third_song_seen`. No landing / composition-count / export-count triggers. */
  paywall(user: string, o: { pro: boolean; aiLimit?: boolean; renderLimit?: boolean }): { eligible: boolean; reason: PaywallReason | null; cooldown_until: number | null; third_song_seen: boolean } {
    const r = this.row(user); const now = this.now();
    const cooldown = r.dismissed_at !== null && r.dismissed_at + PAYWALL_COOLDOWN_MS > now ? r.dismissed_at + PAYWALL_COOLDOWN_MS : null;
    const third_song_seen = r.third_song_at !== null;
    if (o.pro) return { eligible: false, reason: null, cooldown_until: cooldown, third_song_seen };
    const reason: PaywallReason | null = o.aiLimit ? "ai_budget" : o.renderLimit ? "render_limit" : null;
    return { eligible: reason !== null && cooldown === null, reason, cooldown_until: cooldown, third_song_seen };
  }
  moveUser(from: string, to: string) {
    const a = this.row(from); if (!this.db.prepare("SELECT 1 FROM user_usage WHERE user = ?").get(from)) return;
    this.db.prepare("INSERT OR IGNORE INTO user_usage (user) VALUES (?)").run(to);
    this.db.prepare(`UPDATE user_usage SET compositions = compositions + ?, ai_runs = ai_runs + ?, renders = renders + ?, exports = exports + ?, shares = shares + ?, paywall_views = paywall_views + ?,
      last_paywall_at = NULLIF(MAX(COALESCE(last_paywall_at, 0), COALESCE(?, 0)), 0), last_export_at = NULLIF(MAX(COALESCE(last_export_at, 0), COALESCE(?, 0)), 0), third_song_at = COALESCE(third_song_at, ?) WHERE user = ?`)
      .run(a.compositions, a.ai_runs, a.renders, a.exports, a.shares, a.paywall_views, a.last_paywall_at, a.last_export_at, a.third_song_at, to);
    this.db.prepare("DELETE FROM user_usage WHERE user = ?").run(from);
  }
}
