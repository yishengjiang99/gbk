// Server-managed sessions behind an HttpOnly, SameSite=Strict, HMAC-signed cookie. Sessions are durable: rows live in
// SQLite (sessions.sqlite under the data dir) so restarts/deploys keep everyone signed in. Only a SHA-256 hash of the
// session id is stored, never the raw id. Lifetime is a sliding window (30 days by default, 7 for the reviewer)
// renewed on use; lastSeen writes are throttled. Login = OAuth, reviewer, or an invite/access code from
// COMPOSER_ACCESS_CODES (comma separated; optional "name:code" form names the user).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.ts";

export interface Session { id: string; user: string; csrf: string; createdAt: number; lastSeen: number; ttlMs: number }
export const COOKIE = "gbk_cs";
export const CSRF_COOKIE = "gbk_csrf";
export const SESSION_TTL_MS = 30 * 86400_000;
export const REVIEWER_SESSION_TTL_MS = 7 * 86400_000;
/** lastSeen is persisted at most this often per session (sliding expiry granularity). */
export const TOUCH_INTERVAL_MS = 5 * 60_000;

const hashId = (id: string) => createHash("sha256").update(id).digest("hex");
interface Row { id_hash: string; user: string; csrf: string; created_at: number; last_seen: number; ttl_ms: number }

export class SessionStore {
  private db: DatabaseSync;
  constructor(private cfg: Config, private now: () => number = Date.now, file = ":memory:") {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS web_sessions (id_hash TEXT PRIMARY KEY, user TEXT NOT NULL, csrf TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, ttl_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS web_sessions_expiry ON web_sessions(last_seen);`);
  }
  close() { try { this.db.close(); } catch { /* already closed */ } }
  private sign(id: string) { return createHmac("sha256", this.cfg.security.sessionSecret).update(id).digest("base64url"); }
  cookieValue(s: Session) { return `${s.id}.${this.sign(s.id)}`; }
  /** Cookie Max-Age (seconds) matching the session's remaining sliding lifetime. */
  maxAgeSec(s: Session) { return Math.max(0, Math.floor((s.lastSeen + s.ttlMs - this.now()) / 1000)); }
  /** Returns the user name for a valid code, else null. Constant-time compare per code. */
  checkCode(code: unknown): string | null {
    if (typeof code !== "string" || !code || code.length > 200) return null;
    for (const entry of this.cfg.security.accessCodes) {
      const i = entry.indexOf(":"); const user = i > 0 ? entry.slice(0, i) : "user"; const secret = i > 0 ? entry.slice(i + 1) : entry;
      const a = Buffer.from(createHmac("sha256", "k").update(secret).digest()), b = Buffer.from(createHmac("sha256", "k").update(code).digest());
      if (timingSafeEqual(a, b)) return user.replace(/[^\w.-]/g, "").slice(0, 40) || "user";
    }
    return null;
  }
  create(user: string, ttlMs = SESSION_TTL_MS): Session {
    const t = this.now();
    const s: Session = { id: randomBytes(18).toString("base64url"), user, csrf: randomBytes(18).toString("base64url"), createdAt: t, lastSeen: t, ttlMs };
    this.db.prepare("INSERT INTO web_sessions (id_hash, user, csrf, created_at, last_seen, ttl_ms) VALUES (?, ?, ?, ?, ?, ?)").run(hashId(s.id), user, s.csrf, t, t, ttlMs);
    return s;
  }
  private load(id: string): Session | null {
    const r = this.db.prepare("SELECT * FROM web_sessions WHERE id_hash = ?").get(hashId(id)) as Row | undefined;
    if (!r) return null;
    const s: Session = { id, user: r.user, csrf: r.csrf, createdAt: r.created_at, lastSeen: r.last_seen, ttlMs: r.ttl_ms };
    if (this.now() - s.lastSeen > s.ttlMs) { this.destroy(id); return null; }
    return s;
  }
  /** Validates the signed cookie and slides the expiry (persisted at most every TOUCH_INTERVAL_MS). */
  fromCookie(raw: string | undefined): Session | null {
    if (!raw) return null;
    const [id, sig] = raw.split(".");
    if (!id || !sig) return null;
    const exp = Buffer.from(this.sign(id)), got = Buffer.from(sig);
    if (exp.length !== got.length || !timingSafeEqual(exp, got)) return null;
    const s = this.load(id);
    if (s) this.touch(s);
    return s;
  }
  touch(s: Session) {
    const t = this.now();
    if (t - s.lastSeen < TOUCH_INTERVAL_MS) return;
    s.lastSeen = t;
    this.db.prepare("UPDATE web_sessions SET last_seen = ? WHERE id_hash = ?").run(t, hashId(s.id));
  }
  destroy(id: string) { this.db.prepare("DELETE FROM web_sessions WHERE id_hash = ?").run(hashId(id)); }
  isLive(id: string) { return !!this.load(id); }
  sweep() { return Number(this.db.prepare("DELETE FROM web_sessions WHERE last_seen + ttl_ms < ?").run(this.now()).changes); }
}

export function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
export function cookie(name: string, value: string, cfg: Config, opts: { httpOnly?: boolean; maxAge?: number } = {}) {
  return [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Strict", ...(opts.httpOnly !== false ? ["HttpOnly"] : []), ...(cfg.security.cookieSecure ? ["Secure"] : []), ...(opts.maxAge !== undefined ? [`Max-Age=${opts.maxAge}`] : [])].join("; ");
}
