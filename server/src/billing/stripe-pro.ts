// Stripe Pro entitlement (web purchases on grepawk.com). Looks up GET {origin}/api/compose/entitlement?email=
// with Bearer COMPOSE_ENTITLEMENT_TOKEN. Results are cached in SQLite: fresh for 10 min; on lookup error we fail
// closed to Free, except a previously confirmed `pro: true` is kept for up to 24 h. Only accounts whose email came
// from a verified identity provider (Google, Apple, GitHub) can be Stripe-Pro; guests/phone/legacy never are.
// The token and the email are never logged or put in URLs other than the lookup's own query string.
import type { DatabaseSync } from "node:sqlite";
import type { AccountStore } from "../persistence/accounts.ts";

export const STRIPE_FRESH_MS = 10 * 60_000;
export const STRIPE_KEEP_TRUE_MS = 24 * 3_600_000;
const VERIFIED_EMAIL_PROVIDERS = new Set(["google", "apple", "github"]);

interface Row { user: string; email: string; pro: number; checked_at: number; confirmed_at: number | null }

export class StripePro {
  private inflight = new Map<string, Promise<boolean>>();
  constructor(private db: DatabaseSync, private accounts: AccountStore, private o: { origin: string; token: string; fetch?: typeof fetch; now?: () => number; log?: (o: object) => void }) {
    db.exec(`CREATE TABLE IF NOT EXISTS stripe_entitlements (user TEXT PRIMARY KEY, email TEXT NOT NULL, pro INTEGER NOT NULL, checked_at INTEGER NOT NULL, confirmed_at INTEGER)`);
  }
  private now() { return (this.o.now ?? Date.now)(); }
  get enabled() { return !!this.o.token; }
  /** Verified email for a user, or null (guests, phone, legacy, no email). */
  email(user: string): string | null {
    const a = this.accounts.get(user);
    if (!a || !a.email || !VERIFIED_EMAIL_PROVIDERS.has(a.provider)) return null;
    return a.email.trim().toLowerCase();
  }
  private row(user: string) { return this.db.prepare("SELECT * FROM stripe_entitlements WHERE user = ?").get(user) as unknown as Row | undefined; }
  /** Synchronous view from the cache (used by AccountLimits). Kicks off a background refresh when stale. */
  pro(user: string): boolean {
    const email = this.email(user); if (!email || !this.enabled) return false;
    const r = this.row(user); const now = this.now();
    if (!r || r.email !== email || now - r.checked_at >= STRIPE_FRESH_MS) void this.refresh(user).catch(() => {});
    return this.fromRow(r, email, now);
  }
  private fromRow(r: Row | undefined, email: string, now: number) {
    if (!r || r.email !== email) return false;
    if (r.pro) return now - r.checked_at < STRIPE_KEEP_TRUE_MS || (r.confirmed_at !== null && now - r.confirmed_at < STRIPE_KEEP_TRUE_MS);
    return false;
  }
  /** Await a fresh-enough answer (used by /api/me and before render/agent limit checks). Never throws. */
  async ensure(user: string): Promise<boolean> {
    const email = this.email(user); if (!email || !this.enabled) return false;
    const r = this.row(user);
    if (r && r.email === email && this.now() - r.checked_at < STRIPE_FRESH_MS) return this.fromRow(r, email, this.now());
    try { return await this.refresh(user); } catch { return this.fromRow(this.row(user), email, this.now()); }
  }
  private refresh(user: string): Promise<boolean> {
    const cur = this.inflight.get(user); if (cur) return cur;
    const p = this.lookup(user).finally(() => this.inflight.delete(user));
    this.inflight.set(user, p); return p;
  }
  private async lookup(user: string): Promise<boolean> {
    const email = this.email(user); if (!email) return false;
    const prev = this.row(user);
    try {
      const res = await (this.o.fetch ?? fetch)(`${this.o.origin}/api/compose/entitlement?email=${encodeURIComponent(email)}`, { headers: { authorization: `Bearer ${this.o.token}`, accept: "application/json" }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const j = (await res.json()) as { pro?: unknown };
      const pro = j.pro === true; const now = this.now();
      this.db.prepare("INSERT INTO stripe_entitlements (user, email, pro, checked_at, confirmed_at) VALUES (?,?,?,?,?) ON CONFLICT(user) DO UPDATE SET email=excluded.email, pro=excluded.pro, checked_at=excluded.checked_at, confirmed_at=excluded.confirmed_at")
        .run(user, email, pro ? 1 : 0, now, pro ? now : null);
      return pro;
    } catch (e) {
      this.o.log?.({ evt: "stripe_entitlement_lookup_failed", user, error: (e as Error).message.slice(0, 80) });
      // Fail closed, but keep a confirmed true for up to 24 h (stale row is left as-is).
      return this.fromRow(prev, email, this.now());
    }
  }
}

/** The unified Pro status: Apple OR Stripe. */
export type ProSource = "apple" | "stripe" | null;
