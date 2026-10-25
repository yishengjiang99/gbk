// Native-client auth state: rotating refresh tokens, one-time web-view codes, APNs device tokens.
// Only SHA-256 hashes of refresh tokens and codes are stored.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const h = (s: string) => createHash("sha256").update(s).digest("hex");
export const REFRESH_TTL_MS = 90 * 86400_000, CODE_TTL_MS = 60_000;
export interface PushDevice { install_id: string; user_id: string; token: string; environment: "sandbox" | "production"; updated_at: number }

export class NativeStore {
  private db: DatabaseSync;
  constructor(file: string, private now: () => number = Date.now) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS refresh_tokens (hash TEXT PRIMARY KEY, user TEXT NOT NULL, session_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
      CREATE INDEX IF NOT EXISTS refresh_user ON refresh_tokens(user);
      CREATE TABLE IF NOT EXISTS web_codes (hash TEXT PRIMARY KEY, user TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS push_devices (install_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT NOT NULL, environment TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS push_user ON push_devices(user_id);`);
  }
  close() { try { this.db.close(); } catch { /* closed */ } }
  issueRefresh(user: string, sessionId: string): string {
    const t = `rt_${randomBytes(32).toString("base64url")}`; const n = this.now();
    this.db.prepare("INSERT INTO refresh_tokens VALUES (?,?,?,?,?,NULL)").run(h(t), user, sessionId, n, n + REFRESH_TTL_MS); return t;
  }
  /** Single use. Re-use of a spent token revokes every refresh token of that user (theft signal). */
  consumeRefresh(t: unknown): { user: string; sessionId: string } | "reused" | null {
    if (typeof t !== "string" || t.length > 200) return null;
    const r = this.db.prepare("SELECT * FROM refresh_tokens WHERE hash = ?").get(h(t)) as { user: string; session_id: string; expires_at: number; used_at: number | null } | undefined;
    if (!r) return null;
    if (r.used_at) { this.revokeUser(r.user); return "reused"; }
    if (r.expires_at < this.now()) return null;
    this.db.prepare("UPDATE refresh_tokens SET used_at = ? WHERE hash = ?").run(this.now(), h(t)); return { user: r.user, sessionId: r.session_id };
  }
  revokeRefresh(t: string) { this.db.prepare("DELETE FROM refresh_tokens WHERE hash = ?").run(h(t)); }
  revokeSession(sessionId: string) { this.db.prepare("DELETE FROM refresh_tokens WHERE session_id = ?").run(sessionId); }
  revokeUser(user: string) { this.db.prepare("DELETE FROM refresh_tokens WHERE user = ?").run(user); }
  issueCode(user: string): string { const c = randomBytes(24).toString("base64url"); this.db.prepare("INSERT INTO web_codes VALUES (?,?,?)").run(h(c), user, this.now() + CODE_TTL_MS); this.db.prepare("DELETE FROM web_codes WHERE expires_at < ?").run(this.now()); return c; }
  redeemCode(c: unknown): string | null {
    if (typeof c !== "string" || c.length > 100) return null;
    const r = this.db.prepare("DELETE FROM web_codes WHERE hash = ? RETURNING user, expires_at").get(h(c)) as { user: string; expires_at: number } | undefined;
    return r && r.expires_at >= this.now() ? r.user : null;
  }
  registerPush(d: Omit<PushDevice, "updated_at">) {
    this.db.prepare("DELETE FROM push_devices WHERE token = ? AND install_id <> ?").run(d.token, d.install_id);
    this.db.prepare("INSERT INTO push_devices VALUES (?,?,?,?,?) ON CONFLICT(install_id) DO UPDATE SET user_id = excluded.user_id, token = excluded.token, environment = excluded.environment, updated_at = excluded.updated_at").run(d.install_id, d.user_id, d.token, d.environment, this.now());
  }
  unregisterPush(installId: string, user: string) { return Number(this.db.prepare("DELETE FROM push_devices WHERE install_id = ? AND user_id = ?").run(installId, user).changes); }
  dropToken(token: string) { this.db.prepare("DELETE FROM push_devices WHERE token = ?").run(token); }
  devices(user: string): PushDevice[] { return this.db.prepare("SELECT * FROM push_devices WHERE user_id = ?").all(user) as unknown as PushDevice[]; }
  purgeUser(user: string) { this.revokeUser(user); this.db.prepare("DELETE FROM web_codes WHERE user = ?").run(user); this.db.prepare("DELETE FROM push_devices WHERE user_id = ?").run(user); }
}
