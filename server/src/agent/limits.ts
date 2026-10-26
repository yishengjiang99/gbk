// Usage accounting + daily token/cost budgets (per user and global), plus per-user concurrent-run limits.
import type { Config } from "../config.ts";
import type { ModelUsage } from "./model-client.ts";
import type { AccountStore } from "../persistence/accounts.ts";

/** Per-account daily limits. Accounts younger than auth.newAccountDays get the smaller "new account" limits. */
export class AccountLimits {
  /** Pro entitlement (Apple IAP OR Stripe): 10x the daily agent token budget. Set by app.ts once the IAP store exists. */
  pro: (user: string) => boolean = () => false;
  /** Where Pro comes from (Apple IAP or an active Stripe subscription); set by app.ts. */
  proSource: (user: string) => "apple" | "stripe" | null = (u) => (this.pro(u) ? "apple" : null);
  /** Refresh async entitlement sources (Stripe lookup) before a limit decision; never throws. */
  refresh: (user: string) => Promise<unknown> = async () => {};
  /** Force a fresh entitlement lookup, bypassing the cache (post-purchase). */
  recheck: (user: string) => Promise<unknown> = async () => {};
  static PRO_TOKEN_MULTIPLIER = 10;
  constructor(private cfg: Config, private accounts: AccountStore | null, private now: () => number = Date.now) {}
  /** Owner/admin accounts (COMPOSER_ADMIN_USERS) are never "new" and get at least the Pro budget. */
  isAdmin(user: string) { return this.cfg.adminUsers.includes(user); }
  isNew(user: string) { if (this.isAdmin(user)) return false; const a = this.accounts?.get(user); return !!a && this.now() - a.created_at < this.cfg.auth.newAccountDays * 86_400_000; }
  for(user: string) {
    const fresh = this.isNew(user);
    if (this.pro(user) || this.isAdmin(user)) return { newAccount: false, pro: true, dailyTokens: this.cfg.agent.dailyTokenBudget * AccountLimits.PRO_TOKEN_MULTIPLIER, dailyRenders: this.cfg.mcp.maxRendersPerDay };
    return { newAccount: fresh, pro: false, dailyTokens: fresh ? Math.min(this.cfg.agent.newAccountDailyTokenBudget, this.cfg.agent.dailyTokenBudget) : this.cfg.agent.dailyTokenBudget,
      dailyRenders: fresh ? Math.min(this.cfg.mcp.newAccountRendersPerDay, this.cfg.mcp.maxRendersPerDay) : this.cfg.mcp.maxRendersPerDay };
  }
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Budgets reset at 00:00 UTC; say when that is in Pacific time (5 PM PDT / 4 PM PST). */
export function resetTimePT(now: number = Date.now()): string {
  const next = Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000;
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric" }).format(next).replace(/\s+/g, " ") + " PT";
}
/** The plain chat message for a hit daily limit (shown verbatim in mobile and desktop studio). */
export function limitMessage(pro: boolean, now: number = Date.now()): string {
  return `You've hit today's AI limit. It resets at ${resetTimePT(now)}.${pro ? "" : " Go Pro for a 10× daily AI budget."}`;
}
/** A run that started under budget may finish with this much overrun (fraction of the daily limit) instead of stopping mid-composition. */
export const IN_FLIGHT_OVERRUN = 0.25;

export class BudgetError extends Error { constructor(public code: "TOKEN_BUDGET_EXHAUSTED" | "COST_BUDGET_EXHAUSTED" | "GLOBAL_BUDGET_EXHAUSTED", message: string) { super(message); } }

export class UsageLedger {
  private users = new Map<string, { day: string; tokens: number; cost: number }>();
  private global = { day: "", cost: 0, tokens: 0 };
  constructor(private cfg: Config, private now: () => number = Date.now, private accounts: AccountStore | null = null, private limits: AccountLimits = new AccountLimits(cfg, accounts, now)) {}
  private u(user: string) {
    const d = day(this.now()); let r = this.users.get(user);
    // Usage survives restarts when an AccountStore is attached (seeded from today's persisted row).
    if (!r || r.day !== d) { const p = this.accounts?.usage(user); r = { day: d, tokens: p?.tokens ?? 0, cost: p?.cost ?? 0 }; this.users.set(user, r); }
    if (this.global.day !== d) this.global = { day: d, cost: 0, tokens: 0 };
    return r;
  }
  /** Refresh async Pro sources (Stripe) before a start-of-run check. */
  async prepare(user: string) { try { await this.limits.refresh(user); } catch { /* fail closed: cached/Free */ } }
  cost(u: ModelUsage) { return (u.promptTokens * this.cfg.llm.priceInPerMTok + u.completionTokens * this.cfg.llm.priceOutPerMTok) / 1e6; }
  /** Throws BudgetError before a model call when the user or the whole server is out of budget. */
  /** inFlight: a later step of a run that passed the start-of-run check; it may overrun the per-user limits by IN_FLIGHT_OVERRUN. */
  check(user: string, opts: { inFlight?: boolean } = {}) {
    const r = this.u(user);
    const lim = this.limits.for(user);
    const k = opts.inFlight ? 1 + IN_FLIGHT_OVERRUN : 1;
    const msg = limitMessage(lim.pro, this.now());
    if (r.tokens >= lim.dailyTokens * k) throw new BudgetError("TOKEN_BUDGET_EXHAUSTED", msg);
    if (r.cost >= this.cfg.agent.dailyCostBudgetUsd * k) throw new BudgetError("COST_BUDGET_EXHAUSTED", msg);
    if (this.global.cost >= this.cfg.agent.globalDailyCostBudgetUsd) throw new BudgetError("GLOBAL_BUDGET_EXHAUSTED", "the Composer's daily server budget is used up; try again tomorrow");
  }
  record(user: string, u: ModelUsage) {
    const r = this.u(user); const c = this.cost(u); const t = u.promptTokens + u.completionTokens;
    r.tokens += t; r.cost += c; this.global.tokens += t; this.global.cost += c;
    this.accounts?.addUsage(user, { tokens: t, cost: c });
    return { tokens: t, cost: c, dayTokens: r.tokens, dayCost: r.cost };
  }
  snapshot(user: string) { const r = this.u(user); const lim = this.limits.for(user); return { dayTokens: r.tokens, dayCostUsd: +r.cost.toFixed(4), dailyTokenLimit: lim.dailyTokens, newAccount: lim.newAccount }; }
  globalSnapshot() { this.u("__"); return { day: this.global.day, tokens: this.global.tokens, costUsd: +this.global.cost.toFixed(4) }; }
}

export class RunSlots {
  private active = new Map<string, number>();
  constructor(private max: number) {}
  acquire(user: string): boolean { const n = this.active.get(user) ?? 0; if (n >= this.max) return false; this.active.set(user, n + 1); return true; }
  release(user: string) { const n = (this.active.get(user) ?? 1) - 1; if (n <= 0) this.active.delete(user); else this.active.set(user, n); }
  count(user: string) { return this.active.get(user) ?? 0; }
}
