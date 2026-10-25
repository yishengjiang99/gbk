// Usage accounting + daily token/cost budgets (per user and global), plus per-user concurrent-run limits.
import type { Config } from "../config.ts";
import type { ModelUsage } from "./model-client.ts";
import type { AccountStore } from "../persistence/accounts.ts";

/** Per-account daily limits. Accounts younger than auth.newAccountDays get the smaller "new account" limits. */
export class AccountLimits {
  /** Pro entitlement (Apple IAP): 10x the daily agent token budget. Set by app.ts once the IAP store exists. */
  pro: (user: string) => boolean = () => false;
  static PRO_TOKEN_MULTIPLIER = 10;
  constructor(private cfg: Config, private accounts: AccountStore | null, private now: () => number = Date.now) {}
  isNew(user: string) { const a = this.accounts?.get(user); return !!a && this.now() - a.created_at < this.cfg.auth.newAccountDays * 86_400_000; }
  for(user: string) {
    const fresh = this.isNew(user);
    if (this.pro(user)) return { newAccount: false, dailyTokens: this.cfg.agent.dailyTokenBudget * AccountLimits.PRO_TOKEN_MULTIPLIER, dailyRenders: this.cfg.mcp.maxRendersPerDay };
    return { newAccount: fresh, dailyTokens: fresh ? Math.min(this.cfg.agent.newAccountDailyTokenBudget, this.cfg.agent.dailyTokenBudget) : this.cfg.agent.dailyTokenBudget,
      dailyRenders: fresh ? Math.min(this.cfg.mcp.newAccountRendersPerDay, this.cfg.mcp.maxRendersPerDay) : this.cfg.mcp.maxRendersPerDay };
  }
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

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
  cost(u: ModelUsage) { return (u.promptTokens * this.cfg.llm.priceInPerMTok + u.completionTokens * this.cfg.llm.priceOutPerMTok) / 1e6; }
  /** Throws BudgetError before a model call when the user or the whole server is out of budget. */
  check(user: string) {
    const r = this.u(user);
    const lim = this.limits.for(user);
    if (r.tokens >= lim.dailyTokens) throw new BudgetError("TOKEN_BUDGET_EXHAUSTED", `daily token limit (${lim.dailyTokens}${lim.newAccount ? ", new account" : ""}) used up; resets at 00:00 UTC`);
    if (r.cost >= this.cfg.agent.dailyCostBudgetUsd) throw new BudgetError("COST_BUDGET_EXHAUSTED", `daily cost budget ($${this.cfg.agent.dailyCostBudgetUsd}) used up; resets at 00:00 UTC`);
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
