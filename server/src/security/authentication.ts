// Server-managed sessions behind an HttpOnly, SameSite=Strict, HMAC-signed cookie. Login = an invite/access code
// from COMPOSER_ACCESS_CODES (comma separated; optional "name:code" form names the user). No code => nobody logs in.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.ts";

export interface Session { id: string; user: string; csrf: string; createdAt: number; lastSeen: number }
export const COOKIE = "gbk_cs";
export const CSRF_COOKIE = "gbk_csrf";

export class SessionStore {
  private sessions = new Map<string, Session>();
  constructor(private cfg: Config, private now: () => number = Date.now) {}
  private sign(id: string) { return createHmac("sha256", this.cfg.security.sessionSecret).update(id).digest("base64url"); }
  cookieValue(s: Session) { return `${s.id}.${this.sign(s.id)}`; }
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
  create(user: string): Session {
    const s: Session = { id: randomBytes(18).toString("base64url"), user, csrf: randomBytes(18).toString("base64url"), createdAt: this.now(), lastSeen: this.now() };
    this.sessions.set(s.id, s); return s;
  }
  fromCookie(raw: string | undefined): Session | null {
    if (!raw) return null;
    const [id, sig] = raw.split(".");
    if (!id || !sig) return null;
    const exp = Buffer.from(this.sign(id)), got = Buffer.from(sig);
    if (exp.length !== got.length || !timingSafeEqual(exp, got)) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (this.now() - s.lastSeen > this.cfg.agent.sessionIdleSeconds * 1000) { this.sessions.delete(id); return null; }
    s.lastSeen = this.now(); return s;
  }
  touch(s: Session) { s.lastSeen = this.now(); }
  destroy(id: string) { this.sessions.delete(id); }
  isLive(id: string) { const s = this.sessions.get(id); return !!s && this.now() - s.lastSeen <= this.cfg.agent.sessionIdleSeconds * 1000; }
  sweep() { for (const [id, s] of this.sessions) if (this.now() - s.lastSeen > this.cfg.agent.sessionIdleSeconds * 1000) this.sessions.delete(id); }
}

export function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
export function cookie(name: string, value: string, cfg: Config, opts: { httpOnly?: boolean; maxAge?: number } = {}) {
  return [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Strict", ...(opts.httpOnly !== false ? ["HttpOnly"] : []), ...(cfg.security.cookieSecure ? ["Secure"] : []), ...(opts.maxAge !== undefined ? [`Max-Age=${opts.maxAge}`] : [])].join("; ");
}
