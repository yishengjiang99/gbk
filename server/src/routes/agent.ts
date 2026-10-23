// Session routes: GET /api/session (issues the CSRF cookie), POST /api/login (access code), POST /api/logout.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import type { Config } from "../config.ts";
import { COOKIE, CSRF_COOKIE, cookie, parseCookies, type Session, type SessionStore } from "../security/authentication.ts";
import { csrfOk, originAllowed } from "../security/authorization.ts";
import type { RateLimiter } from "../security/rate-limit.ts";

export function currentSession(req: FastifyRequest, sessions: SessionStore): Session | null { return sessions.fromCookie(parseCookies(req.headers.cookie)[COOKIE]); }
/** For state-changing requests: same-origin Origin header + double-submit CSRF token. */
export function guardWrite(cfg: Config, req: FastifyRequest, reply: FastifyReply, s?: Session | null): boolean {
  if (!originAllowed(cfg, req.headers.origin)) { void reply.code(403).send({ code: "BAD_ORIGIN", message: "cross-origin request rejected" }); return false; }
  if (!csrfOk(req.headers["x-gbk-csrf"], parseCookies(req.headers.cookie)[CSRF_COOKIE], s?.csrf)) { void reply.code(403).send({ code: "CSRF", message: "missing or invalid CSRF token; reload the page" }); return false; }
  return true;
}

export function agentRoutes(app: FastifyInstance, cfg: Config, sessions: SessionStore, loginLimiter: RateLimiter) {
  app.get("/api/session", async (req, reply) => {
    const s = currentSession(req, sessions);
    const csrf = s?.csrf ?? parseCookies(req.headers.cookie)[CSRF_COOKIE] ?? randomBytes(18).toString("base64url");
    reply.header("set-cookie", cookie(CSRF_COOKIE, csrf, cfg, { httpOnly: false }));
    reply.header("cache-control", "no-store");
    return { authenticated: !!s, user: s?.user ?? null, csrf, enabled: cfg.enabled, loginAvailable: cfg.security.accessCodes.length > 0 };
  });
  app.post("/api/login", async (req, reply) => {
    if (!guardWrite(cfg, req, reply)) return;
    const ip = req.ip;
    if (!loginLimiter.take(`login:${ip}`)) return reply.code(429).send({ code: "RATE_LIMITED", message: "too many login attempts; wait a minute" });
    const user = sessions.checkCode((req.body as { code?: unknown } | null)?.code);
    if (!user) { req.log.warn({ evt: "login_failed", ip }); return reply.code(401).send({ code: "BAD_CODE", message: "invalid access code" }); }
    const s = sessions.create(user);
    reply.header("set-cookie", [cookie(COOKIE, sessions.cookieValue(s), cfg, { maxAge: 30 * 86400 }), cookie(CSRF_COOKIE, s.csrf, cfg, { httpOnly: false })]);
    req.log.info({ evt: "login", user });
    return { ok: true, user, csrf: s.csrf };
  });
  app.post("/api/logout", async (req, reply) => {
    const s = currentSession(req, sessions);
    if (!guardWrite(cfg, req, reply, s)) return;
    if (s) sessions.destroy(s.id);
    reply.header("set-cookie", cookie(COOKIE, "", cfg, { maxAge: 0 }));
    return { ok: true };
  });
}
