// Billing funnel telemetry (#118): the single server-side recording entry point for the monetization
// plan's event taxonomy (BILLING_EVENTS in persistence/funnel.ts). Two sinks, deliberately separated:
//  - aggregates: FunnelStore.billing_daily — counts only, (day, event, surface, platform), no identities;
//  - support log: billing_log in the shares DB (next to apple_tx) — one row per event per account, so
//    support can answer "what happened with my subscription" without touching payment processors.
// Sources wired in app.ts / routes: signup (AccountStore.onCreated), composition_created/first_composition
// and export (the #115 usage-counter callbacks), share_published (POST /api/shares), paywall_view/dismiss
// (/api/me/engagement + POST /api/billing/events), the Apple ASSN handler (purchase/trial/renew/cancel/
// refund/restore) and the Stripe hop POST /api/billing/stripe-events (finalcut forwards its webhook).
import type { DatabaseSync } from "node:sqlite";
import { BILLING_EVENTS, type BillingEvent, type FunnelStore } from "./funnel.ts";

export const BILLING_SURFACES = ["studio", "pricing", "ios", "chatgpt", "mcp", "server"] as const;
export const BILLING_PLATFORMS = ["web", "ios", "server"] as const;
export const BILLING_PLANS = ["pro_monthly", "pro_yearly", "lifetime"] as const;
export const BILLING_PROVIDERS = ["apple", "stripe"] as const;
/** Paywall triggers from #115 (usage.ts PaywallReason) plus a manual upgrade tap. */
export const BILLING_REASONS = ["second_composition", "export_after_2", "ai_limit", "render_limit", "landing", "manual", "profile", "studio_link"] as const;
/** Client-reported plan value -> billing plan id: accepts a plan slug as-is, or a StoreKit product id
 *  (suffix match, mirroring routes/iap.ts planOf) since the iOS app reports product ids (#119). */
export const billingPlanOf = (v: string): string => ((BILLING_PLANS as readonly string[]).includes(v) ? v
  : v.endsWith(".pro_monthly") ? "pro_monthly" : v.endsWith(".pro_yearly") ? "pro_yearly" : v.endsWith(".lifetime") ? "lifetime" : "");
export const RESTORE_RESULTS = ["success", "none", "failed", "cancelled"] as const;

export interface BillingDims {
  account?: string | null; surface?: string; platform?: string; plan?: string; provider?: string;
  valueCents?: number | null; reason?: string; result?: string; detail?: string;
}
interface LogRow { id: number; ts: number; account: string; event: string; plan: string; provider: string; value_cents: number | null; surface: string; platform: string; detail: string }
/** Sanitized dimensions as stored in the log (reason/result are already folded into detail). */
export interface BillingLogEntry { plan: string; provider: string; valueCents: number | null; surface: string; platform: string; detail: string }

const pick = (v: string | undefined, allowed: readonly string[]) => (v && allowed.includes(v) ? v : "");

/** Per-account billing event log for support. Lives in the shares database. */
export class BillingLog {
  constructor(private db: DatabaseSync, private now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS billing_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, account TEXT NOT NULL, event TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '', value_cents INTEGER, surface TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS billing_log_account ON billing_log(account, id);`);
  }
  record(account: string, event: BillingEvent, d: BillingLogEntry) {
    this.db.prepare("INSERT INTO billing_log (ts, account, event, plan, provider, value_cents, surface, platform, detail) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(this.now(), account, event, d.plan, d.provider, d.valueCents, d.surface, d.platform, d.detail);
  }
  forAccount(account: string, limit = 100): LogRow[] {
    return this.db.prepare("SELECT * FROM billing_log WHERE account = ? ORDER BY id DESC LIMIT ?").all(account, Math.min(500, Math.max(1, limit))) as unknown as LogRow[];
  }
  /** True when the account's latest money event is a trial start (a DID_RENEW then reads as a conversion). */
  hasOpenTrial(account: string): boolean {
    const r = this.db.prepare("SELECT event FROM billing_log WHERE account = ? AND event IN ('trial_start','purchase','renewal','trial_convert') ORDER BY id DESC LIMIT 1").get(account) as { event: string } | undefined;
    return r?.event === "trial_start";
  }
}

/** Records one billing event into the aggregates and (when an account is known) the support log.
 * Never throws: telemetry must not break the flow it observes. Unknown events/dimensions are dropped
 * or sanitized to "" rather than stored raw. */
export class BillingRecorder {
  constructor(private funnel: FunnelStore, private log: BillingLog | null, private now: () => number = Date.now) {}
  record(event: BillingEvent, dims: BillingDims = {}) {
    try {
      if (!(BILLING_EVENTS as readonly string[]).includes(event)) return;
      const d = {
        plan: pick(dims.plan, BILLING_PLANS), provider: pick(dims.provider, BILLING_PROVIDERS),
        surface: pick(dims.surface, BILLING_SURFACES), platform: pick(dims.platform, BILLING_PLATFORMS),
        valueCents: typeof dims.valueCents === "number" && Number.isFinite(dims.valueCents) ? Math.round(dims.valueCents) : null,
        detail: [pick(dims.reason, BILLING_REASONS) && `reason=${pick(dims.reason, BILLING_REASONS)}`,
          pick(dims.result, RESTORE_RESULTS) && `result=${pick(dims.result, RESTORE_RESULTS)}`,
          typeof dims.detail === "string" ? dims.detail.slice(0, 120) : ""].filter(Boolean).join(" ").slice(0, 200),
      };
      this.funnel.bumpBilling(event, d.surface, d.platform, this.now());
      const account = typeof dims.account === "string" && dims.account ? dims.account.slice(0, 128) : null;
      if (account && this.log) this.log.record(account, event, d);
    } catch { /* best effort */ }
  }
  hasOpenTrial(account: string | null | undefined): boolean {
    try { return !!account && !!this.log && this.log.hasOpenTrial(account); } catch { return false; }
  }
}
