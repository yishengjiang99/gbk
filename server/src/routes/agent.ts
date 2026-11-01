// Session routes: GET /api/session (issues the CSRF cookie; lists sign-in providers + the account's limits),
// POST /api/login (legacy access code, kept so migrated invite users keep working), POST /api/logout.
// Google / GitHub sign-in lives in ./signin.ts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { authProviders, type Config } from "../config.ts";
import { reviewerLoginEnabled } from "./reviewer.ts";
import type { AccountStore } from "../persistence/accounts.ts";
import type { AccountLimits, UsageLedger } from "../agent/limits.ts";
import { COOKIE, CSRF_COOKIE, cookie, parseCookies, type Session, type SessionStore } from "../security/authentication.ts";
import { csrfOk, originAllowed } from "../security/authorization.ts";
import type { RateLimiter } from "../security/rate-limit.ts";

/** Bearer token (native clients; value = the session token) or the web session cookie. */
const bearerOf = (req: FastifyRequest) => { const h = req.headers.authorization; return typeof h === "string" && /^Bearer\s+\S+$/i.test(h) ? h.replace(/^Bearer\s+/i, "").trim() : null; };
export function currentSession(req: FastifyRequest, sessions: SessionStore): Session | null { const b = bearerOf(req); return b ? sessions.fromCookie(b) : sessions.fromCookie(parseCookies(req.headers.cookie)[COOKIE]); }
/** For state-changing requests: same-origin Origin header + double-submit CSRF token. */
export function guardWrite(cfg: Config, req: FastifyRequest, reply: FastifyReply, s?: Session | null): boolean {
  // Bearer auth carries no ambient credential, so Origin/CSRF checks do not apply (cookie must be absent).
  if (s && bearerOf(req) && !parseCookies(req.headers.cookie)[COOKIE]) return true;
  if (!originAllowed(cfg, req.headers.origin)) { void reply.code(403).send({ code: "BAD_ORIGIN", message: "cross-origin request rejected" }); return false; }
  if (!csrfOk(req.headers["x-gbk-csrf"], parseCookies(req.headers.cookie)[CSRF_COOKIE], s?.csrf)) { void reply.code(403).send({ code: "CSRF", message: "missing or invalid CSRF token; reload the page" }); return false; }
  return true;
}

export function agentRoutes(app: FastifyInstance, cfg: Config, sessions: SessionStore, loginLimiter: RateLimiter, accounts?: AccountStore, limits?: AccountLimits, ledger?: UsageLedger) {
  app.get("/api/session", async (req, reply) => {
    const s = currentSession(req, sessions);
    const csrf = s?.csrf ?? parseCookies(req.headers.cookie)[CSRF_COOKIE] ?? randomBytes(18).toString("base64url");
    // Sliding login: re-issue the session cookie so its Max-Age follows the server-side expiry.
    const cookies = [cookie(CSRF_COOKIE, csrf, cfg, { httpOnly: false })];
    if (s) cookies.push(cookie(COOKIE, sessions.cookieValue(s), cfg, { maxAge: sessions.maxAgeSec(s) }));
    reply.header("set-cookie", cookies);
    reply.header("cache-control", "no-store");
    const acct = s && accounts ? accounts.get(s.user) : null;
    if (s && limits) await limits.refresh(s.user);
    const lim = s && limits ? limits.for(s.user) : null;
    // Paid entitlement only (Apple IAP or Stripe, matched by verified account email). Unlike limits.pro this is
    // false for admins without a purchase, so the web header/settings badge means "paying customer".
    const proSource = s && limits ? limits.proSource(s.user) : null;
    return { authenticated: !!s, user: s?.user ?? null, name: acct?.name ?? s?.user ?? null, provider: acct?.provider ?? null, csrf, enabled: cfg.enabled, pro: !!proSource, pro_source: proSource,
      studio_song_card: process.env.STUDIO_SONG_CARD !== "0", // off switch: STUDIO_SONG_CARD=0 restores the old chat (no inline song card)
      providers: authProviders(cfg), loginAvailable: cfg.security.accessCodes.length > 0, reviewerLogin: reviewerLoginEnabled(cfg), apple: !!cfg.signin2?.appleServicesId, sms: !!(cfg.signin2?.twilio && cfg.signin2?.turnstileSecret),
      limits: lim ? { pro: lim.pro, newAccount: lim.newAccount, dailyTokens: lim.dailyTokens, dailyRenders: lim.dailyRenders, usedTokensToday: ledger?.snapshot(s!.user).dayTokens ?? null } : null };
  });
  app.post("/api/login", async (req, reply) => {
    if (!guardWrite(cfg, req, reply)) return;
    const ip = req.ip;
    if (!loginLimiter.take(`login:${ip}`)) return reply.code(429).send({ code: "RATE_LIMITED", message: "too many login attempts; wait a minute" });
    const user = sessions.checkCode((req.body as { code?: unknown } | null)?.code);
    if (!user) { req.log.warn({ evt: "login_failed", ip }); return reply.code(401).send({ code: "BAD_CODE", message: "invalid access code" }); }
    if (accounts) { accounts.ensureLegacy(user); accounts.touchLogin(user); }
    const s = sessions.create(user);
    reply.header("set-cookie", [cookie(COOKIE, sessions.cookieValue(s), cfg, { maxAge: sessions.maxAgeSec(s) }), cookie(CSRF_COOKIE, s.csrf, cfg, { httpOnly: false })]);
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
