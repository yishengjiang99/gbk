// Usage accounting + daily token/cost budgets (per user and global), plus per-user concurrent-run limits.
import type { Config } from "../config.ts";
import type { ModelUsage } from "./model-client.ts";

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

export class BudgetError extends Error { constructor(public code: "TOKEN_BUDGET_EXHAUSTED" | "COST_BUDGET_EXHAUSTED" | "GLOBAL_BUDGET_EXHAUSTED", message: string) { super(message); } }

export class UsageLedger {
  private users = new Map<string, { day: string; tokens: number; cost: number }>();
  private global = { day: "", cost: 0, tokens: 0 };
  constructor(private cfg: Config, private now: () => number = Date.now) {}
  private u(user: string) {
    const d = day(this.now()); let r = this.users.get(user);
    if (!r || r.day !== d) { r = { day: d, tokens: 0, cost: 0 }; this.users.set(user, r); }
    if (this.global.day !== d) this.global = { day: d, cost: 0, tokens: 0 };
    return r;
  }
  cost(u: ModelUsage) { return (u.promptTokens * this.cfg.llm.priceInPerMTok + u.completionTokens * this.cfg.llm.priceOutPerMTok) / 1e6; }
  /** Throws BudgetError before a model call when the user or the whole server is out of budget. */
  check(user: string) {
    const r = this.u(user);
    if (r.tokens >= this.cfg.agent.dailyTokenBudget) throw new BudgetError("TOKEN_BUDGET_EXHAUSTED", `daily token budget (${this.cfg.agent.dailyTokenBudget}) used up; resets at 00:00 UTC`);
    if (r.cost >= this.cfg.agent.dailyCostBudgetUsd) throw new BudgetError("COST_BUDGET_EXHAUSTED", `daily cost budget ($${this.cfg.agent.dailyCostBudgetUsd}) used up; resets at 00:00 UTC`);
    if (this.global.cost >= this.cfg.agent.globalDailyCostBudgetUsd) throw new BudgetError("GLOBAL_BUDGET_EXHAUSTED", "the Composer's daily server budget is used up; try again tomorrow");
  }
  record(user: string, u: ModelUsage) {
    const r = this.u(user); const c = this.cost(u); const t = u.promptTokens + u.completionTokens;
    r.tokens += t; r.cost += c; this.global.tokens += t; this.global.cost += c;
    return { tokens: t, cost: c, dayTokens: r.tokens, dayCost: r.cost };
  }
  snapshot(user: string) { const r = this.u(user); return { dayTokens: r.tokens, dayCostUsd: +r.cost.toFixed(4) }; }
  globalSnapshot() { this.u("__"); return { day: this.global.day, tokens: this.global.tokens, costUsd: +this.global.cost.toFixed(4) }; }
}

export class RunSlots {
  private active = new Map<string, number>();
  constructor(private max: number) {}
  acquire(user: string): boolean { const n = this.active.get(user) ?? 0; if (n >= this.max) return false; this.active.set(user, n + 1); return true; }
  release(user: string) { const n = (this.active.get(user) ?? 1) - 1; if (n <= 0) this.active.delete(user); else this.active.set(user, n); }
  count(user: string) { return this.active.get(user) ?? 0; }
}
