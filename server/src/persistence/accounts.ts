// Accounts (Google / GitHub sign-in, plus migrated access-code users) and their persisted daily usage.
// One SQLite file (accounts.sqlite) under COMPOSER_DATA_DIR. The account id is the `user` string every other
// store keys on (shares.owner, mcp compositions.owner, OAuth token subject), so it never changes once issued.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Provider = "github" | "google" | "apple" | "phone" | "guest" | "legacy";
/** Guest accounts (POST /api/auth/anonymous): ids start with "gu-" and provider is "guest" until upgraded (linked). */
let current: AccountStore | null = null;
export const isGuestAccount = (id: string) => id.startsWith("gu-") && current?.get(id)?.provider === "guest";
export interface Account { id: string; provider: Provider; provider_id: string; name: string; email: string | null; created_at: number; last_login: number | null }
export interface UsageRow { tokens: number; cost: number; renders: number }

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
/** Account ids follow the existing user-name alphabet ([\w.-], max 40) so no downstream store needs a migration. */
export const accountIdFor = (provider: Exclude<Provider, "legacy">, providerId: string) => `${provider === "github" ? "gh" : provider === "apple" ? "ap" : provider === "phone" ? "ph" : provider === "guest" ? "gu" : "g"}-${providerId.replace(/[^\w.-]/g, "")}`.slice(0, 40);

export class AccountStore {
  private db: DatabaseSync;
  constructor(file: string, private now: () => number = Date.now) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file); current = this; // eslint-disable-line @typescript-eslint/no-this-alias
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT,
        created_at INTEGER NOT NULL, last_login INTEGER, UNIQUE(provider, provider_id));
      CREATE TABLE IF NOT EXISTS usage (user TEXT NOT NULL, day TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, renders INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user, day));`);
  }
  get(id: string): Account | null { return (this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as unknown as Account) ?? null; }
  /** Sign-in with an external provider: find or create the account; the id is derived from the provider's stable user id. */
  upsertOAuth(provider: Exclude<Provider, "legacy">, providerId: string, name: string, email: string | null): { account: Account; created: boolean } {
    const id = accountIdFor(provider, providerId); const now = this.now();
    const cur = this.db.prepare("SELECT * FROM accounts WHERE provider = ? AND provider_id = ?").get(provider, providerId) as unknown as Account | undefined;
    if (cur) { this.db.prepare("UPDATE accounts SET name = ?, email = ?, last_login = ? WHERE id = ?").run(name.slice(0, 80), email, now, cur.id); return { account: this.get(cur.id)!, created: false }; }
    this.db.prepare("INSERT INTO accounts (id, provider, provider_id, name, email, created_at, last_login) VALUES (?,?,?,?,?,?,?)").run(id, provider, providerId, name.slice(0, 80), email, now, now);
    return { account: this.get(id)!, created: true };
  }
  byProvider(provider: string, providerId: string): Account | null { return (this.db.prepare("SELECT * FROM accounts WHERE provider = ? AND provider_id = ?").get(provider, providerId) as unknown as Account) ?? null; }
  /** Guest upgrade in place: attach an external identity to the guest's account (same id). */
  link(id: string, provider: Exclude<Provider, "legacy" | "guest">, providerId: string, name: string, email: string | null) { this.db.prepare("UPDATE accounts SET provider = ?, provider_id = ?, name = ?, email = ?, last_login = ? WHERE id = ?").run(provider, providerId, name.slice(0, 80), email, this.now(), id); }
  delete(id: string) { this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id); this.db.prepare("DELETE FROM usage WHERE user = ?").run(id); }
  /** Migration of pre-sign-in users (access-code names and existing song owners). They count as established accounts. */
  ensureLegacy(user: string, createdAt = 0): boolean {
    if (!user || this.get(user)) return false;
    this.db.prepare("INSERT OR IGNORE INTO accounts (id, provider, provider_id, name, email, created_at, last_login) VALUES (?,?,?,?,NULL,?,NULL)").run(user, "legacy", user, user, createdAt);
    return true;
  }
  touchLogin(id: string) { this.db.prepare("UPDATE accounts SET last_login = ? WHERE id = ?").run(this.now(), id); }
  count() { return Number((this.db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n); }

  usage(user: string): UsageRow {
    const r = this.db.prepare("SELECT tokens, cost, renders FROM usage WHERE user = ? AND day = ?").get(user, day(this.now())) as unknown as UsageRow | undefined;
    return r ? { tokens: Number(r.tokens), cost: Number(r.cost), renders: Number(r.renders) } : { tokens: 0, cost: 0, renders: 0 };
  }
  addUsage(user: string, d: Partial<UsageRow>) {
    this.db.prepare(`INSERT INTO usage (user, day, tokens, cost, renders) VALUES (?,?,?,?,?)
      ON CONFLICT(user, day) DO UPDATE SET tokens = tokens + excluded.tokens, cost = cost + excluded.cost, renders = renders + excluded.renders`)
      .run(user, day(this.now()), Math.round(d.tokens ?? 0), d.cost ?? 0, d.renders ?? 0);
  }
  /** Account deletion (App Store 5.1.1(v)): the account row and its usage. */
  delete(id: string) { this.db.prepare("DELETE FROM usage WHERE user = ?").run(id); this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id); }
  close() { this.db.close(); }
}
