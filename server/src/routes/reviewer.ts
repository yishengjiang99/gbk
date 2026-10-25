// Reviewer sign-in for OpenAI app review: exactly one username/password account ("openai-reviewer").
//   GET  /signin/reviewer?return=/path  -> small server-rendered form (works inside the MCP OAuth flow)
//   POST /api/auth/reviewer             -> verify (scrypt hash, constant time), start a GBK session, 303 to return
// Off switch: REVIEWER_LOGIN_ENABLED=1 plus REVIEWER_PASSWORD_HASH must both be set; otherwise both routes 404.
// Hash format: scrypt$<saltB64url>$<hashB64url> (N=16384,r=8,p=1, 32-byte key). The password never reaches logs.
import type { FastifyInstance } from "fastify";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.ts";
import type { AccountStore } from "../persistence/accounts.ts";
import { COOKIE, CSRF_COOKIE, cookie, parseCookies, type SessionStore, REVIEWER_SESSION_TTL_MS } from "../security/authentication.ts";
import { originAllowed } from "../security/authorization.ts";
import { RateLimiter } from "../security/rate-limit.ts";
import { safeReturn } from "./signin.ts";

export const REVIEWER_USER = "openai-reviewer";
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function hashReviewerPassword(pw: string, salt = randomBytes(16)): string {
  return `scrypt$${salt.toString("base64url")}$${scryptSync(pw, salt, 32).toString("base64url")}`;
}
export function verifyReviewerPassword(stored: string, pw: string): boolean {
  const [alg, s, h] = stored.split("$");
  if (alg !== "scrypt" || !s || !h) return false;
  const want = Buffer.from(h, "base64url");
  const got = scryptSync(pw, Buffer.from(s, "base64url"), want.length || 32);
  return want.length === got.length && timingSafeEqual(want, got);
}
const sameText = (a: string, b: string) => { const x = Buffer.from(a.padEnd(64).slice(0, 64)), y = Buffer.from(b.padEnd(64).slice(0, 64)); return timingSafeEqual(x, y) && a === b; };

export const reviewerLoginEnabled = (cfg: Config) => cfg.auth.reviewer.enabled && !!cfg.auth.reviewer.passwordHash;

export function reviewerRoutes(app: FastifyInstance, cfg: Config, sessions: SessionStore, accounts: AccountStore, limiter = new RateLimiter(5, 15 * 60_000)) {
  const form = (ret: string, csrf: string, error = "") => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Reviewer sign-in · GBK Composer</title><body style="font-family:system-ui;max-width:26rem;margin:3rem auto;padding:0 1rem;background:#fffdf7;color:#1f2330">
<h1 style="color:#3a2e9e">Reviewer sign-in</h1><p>For app-review accounts only. Everyone else signs in with Google.</p>
${error ? `<p role="alert" data-testid="reviewer-error" style="color:#b00020">${esc(error)}</p>` : ""}
<form method="POST" action="/api/auth/reviewer" data-testid="reviewer-form">
<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="return" value="${esc(ret)}">
<p><label>Username<br><input name="username" autocomplete="username" required style="width:100%;padding:.5rem"></label></p>
<p><label>Password<br><input name="password" type="password" autocomplete="current-password" required style="width:100%;padding:.5rem"></label></p>
<p><button type="submit" style="padding:.6rem 1.2rem;background:#3a2e9e;color:#fff;border:0;border-radius:8px">Sign in</button></p></form></body></html>`;
  const csrfFor = (cookies: Record<string, string>) => cookies[CSRF_COOKIE] ?? randomBytes(18).toString("base64url");

  if (!app.hasContentTypeParser("application/x-www-form-urlencoded")) app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    try { done(null, Object.fromEntries(new URLSearchParams(body as string))); } catch (e) { done(e as Error); }
  });
  app.get("/signin/reviewer", async (req, reply) => {
    if (!reviewerLoginEnabled(cfg)) return reply.code(404).send({ code: "NOT_FOUND" });
    const csrf = csrfFor(parseCookies(req.headers.cookie));
    reply.header("set-cookie", cookie(CSRF_COOKIE, csrf, cfg, { httpOnly: false })).header("cache-control", "no-store");
    return reply.type("text/html; charset=utf-8").send(form(safeReturn((req.query as { return?: string }).return), csrf));
  });

  app.post("/api/auth/reviewer", async (req, reply) => {
    if (!reviewerLoginEnabled(cfg)) return reply.code(404).send({ code: "NOT_FOUND" });
    if (!originAllowed(cfg, req.headers.origin)) return reply.code(403).send({ code: "BAD_ORIGIN" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 256) : "");
    const ret = safeReturn(b.return); const cookies = parseCookies(req.headers.cookie);
    const csrf = str(b.csrf);
    if (!csrf || !cookies[CSRF_COOKIE] || !sameText(csrf, cookies[CSRF_COOKIE])) return reply.code(403).type("text/html; charset=utf-8").send(form(ret, csrfFor(cookies), "Session expired. Please try again."));
    if (!limiter.take(`reviewer:${req.ip}`)) { req.log.warn({ evt: "reviewer_login_limited", ip: req.ip }); return reply.code(429).type("text/html; charset=utf-8").send(form(ret, csrf, "Too many attempts. Wait 15 minutes.")); }
    const okUser = sameText(str(b.username), REVIEWER_USER);
    const okPw = verifyReviewerPassword(cfg.auth.reviewer.passwordHash, str(b.password));
    if (!okUser || !okPw) { req.log.warn({ evt: "reviewer_login_failed", ip: req.ip }); return reply.code(401).type("text/html; charset=utf-8").send(form(ret, csrf, "Wrong username or password.")); }
    accounts.ensureLegacy(REVIEWER_USER, Date.now()); accounts.touchLogin(REVIEWER_USER);
    const s = sessions.create(REVIEWER_USER, REVIEWER_SESSION_TTL_MS);
    reply.header("set-cookie", [cookie(COOKIE, sessions.cookieValue(s), cfg, { maxAge: sessions.maxAgeSec(s) }), cookie(CSRF_COOKIE, s.csrf, cfg, { httpOnly: false })]);
    req.log.info({ evt: "login", via: "reviewer", user: REVIEWER_USER });
    return reply.code(303).header("location", ret).send();
  });
}
