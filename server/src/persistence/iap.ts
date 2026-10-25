// Apple IAP state: one row per originalTransactionId (latest transaction wins), app_account_token ownership,
// processed notification ids. Lives in the shares database.
import type { DatabaseSync } from "node:sqlite";

export interface AppleTx { original_tx: string; last_tx: string; user: string | null; app_token: string | null; product_id: string; environment: string; expires_at: number | null; revoked_at: number | null; auto_renew: number | null; grace_until: number | null; updated_at: number }
export class IapStore {
  constructor(private db: DatabaseSync, private now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS apple_tx (original_tx TEXT PRIMARY KEY, last_tx TEXT NOT NULL, user TEXT, app_token TEXT, product_id TEXT NOT NULL, environment TEXT NOT NULL,
        expires_at INTEGER, revoked_at INTEGER, auto_renew INTEGER, grace_until INTEGER, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS apple_tx_user ON apple_tx(user); CREATE INDEX IF NOT EXISTS apple_tx_token ON apple_tx(app_token);
      CREATE TABLE IF NOT EXISTS apple_tx_seen (tx TEXT PRIMARY KEY, original_tx TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS apple_tokens (token TEXT PRIMARY KEY, user TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS apple_notifications (uuid TEXT PRIMARY KEY, created_at INTEGER NOT NULL);`);
  }
  get(orig: string) { return (this.db.prepare("SELECT * FROM apple_tx WHERE original_tx = ?").get(orig) as unknown as AppleTx) ?? null; }
  tokenOwner(token: string) { return (this.db.prepare("SELECT user FROM apple_tokens WHERE token = ?").get(token) as { user: string } | undefined)?.user ?? null; }
  bindToken(token: string, user: string) { this.db.prepare("INSERT OR IGNORE INTO apple_tokens (token, user) VALUES (?,?)").run(token, user); this.db.prepare("UPDATE apple_tx SET user = ? WHERE app_token = ? AND user IS NULL").run(user, token); }
  seenTx(tx: string) { return !!this.db.prepare("SELECT 1 FROM apple_tx_seen WHERE tx = ?").get(tx); }
  upsert(t: Omit<AppleTx, "updated_at" | "auto_renew" | "grace_until"> & { auto_renew?: number | null; grace_until?: number | null }) {
    this.db.prepare(`INSERT INTO apple_tx (original_tx, last_tx, user, app_token, product_id, environment, expires_at, revoked_at, auto_renew, grace_until, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(original_tx) DO UPDATE SET last_tx = excluded.last_tx, user = COALESCE(apple_tx.user, excluded.user), app_token = COALESCE(apple_tx.app_token, excluded.app_token), product_id = excluded.product_id,
      environment = excluded.environment, expires_at = excluded.expires_at, revoked_at = excluded.revoked_at, auto_renew = COALESCE(excluded.auto_renew, apple_tx.auto_renew), grace_until = excluded.grace_until, updated_at = excluded.updated_at`)
      .run(t.original_tx, t.last_tx, t.user, t.app_token, t.product_id, t.environment, t.expires_at, t.revoked_at, t.auto_renew ?? null, t.grace_until ?? null, this.now());
    this.db.prepare("INSERT OR IGNORE INTO apple_tx_seen (tx, original_tx) VALUES (?,?)").run(t.last_tx, t.original_tx);
  }
  patch(orig: string, f: Partial<Pick<AppleTx, "expires_at" | "revoked_at" | "auto_renew" | "grace_until">>) {
    for (const [k, v] of Object.entries(f)) this.db.prepare(`UPDATE apple_tx SET ${k} = ?, updated_at = ? WHERE original_tx = ?`).run(v as number | null, this.now(), orig);
  }
  notificationSeen(uuid: string) { const r = this.db.prepare("INSERT OR IGNORE INTO apple_notifications (uuid, created_at) VALUES (?,?)").run(uuid, this.now()); return Number(r.changes) === 0; }
  active(t: AppleTx, now = this.now()) { return !t.revoked_at && (t.expires_at === null || t.expires_at > now || (t.grace_until !== null && t.grace_until > now)); }
  /** Best active Apple entitlement for a user. */
  pro(user: string): { pro: boolean; expires_at: number | null; environment: string | null } {
    const rows = this.db.prepare("SELECT * FROM apple_tx WHERE user = ?").all(user) as unknown as AppleTx[];
    const act = rows.filter((r) => this.active(r)); if (!act.length) return { pro: false, expires_at: null, environment: null };
    const life = act.find((r) => r.expires_at === null); const best = life ?? act.sort((a, b) => (b.expires_at ?? 0) - (a.expires_at ?? 0))[0];
    return { pro: true, expires_at: best.expires_at, environment: best.environment };
  }
  moveUser(from: string, to: string) { this.db.prepare("UPDATE apple_tx SET user = ? WHERE user = ?").run(to, from); this.db.prepare("UPDATE apple_tokens SET user = ? WHERE user = ?").run(to, from); }
  /** Account deletion: purchases detach but stay claimable by app_account_token / Restore. */
  detach(user: string) { this.db.prepare("UPDATE apple_tx SET user = NULL WHERE user = ?").run(user); this.db.prepare("DELETE FROM apple_tokens WHERE user = ?").run(user); }
}
