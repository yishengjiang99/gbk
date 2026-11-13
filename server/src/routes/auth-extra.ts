// Web Sign in with Apple (form_post, id_token verified against Apple JWKS). Turns on when APPLE_SERVICES_ID is set;
// otherwise 503. SMS sign-in is disabled: the old endpoints stay and return 410.
import type { FastifyInstance, FastifyReply } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import type { Config } from "../config.ts";
import { COOKIE, CSRF_COOKIE, cookie, parseCookies, type SessionStore } from "../security/authentication.ts";
import type { AccountStore } from "../persistence/accounts.ts";
import { RateLimiter } from "../security/rate-limit.ts";
import { verifyIdToken } from "../security/id-token.ts";
import { safeReturn } from "./signin.ts";

type FetchLike = typeof fetch;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const STATE = "gbk_apple_state";
export function authExtraRoutes(app: FastifyInstance, cfg: Config, d: { sessions: SessionStore; accounts: AccountStore; pair: (user: string) => object; fetch?: FetchLike }) {
  const http = d.fetch ?? fetch; const { sessions, accounts } = d; const c2 = cfg.signin2;
  const L = { appleIp: new RateLimiter(cfg.security.loginPerMinute) };
  const tooMany = (reply: FastifyReply) => reply.code(429).send({ code: "RATE_LIMITED", message: "too many attempts; try again later" });
  const page = (reply: FastifyReply, status: number, title: string, body: string, to?: string) =>
    reply.code(status).type("text/html").header("cache-control", "no-store").header("referrer-policy", "no-referrer").send(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>${to ? `<meta http-equiv="refresh" content="0;url=${esc(to)}">` : ""}<body style="font-family:system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem"><h1>${esc(title)}</h1>${body}</body>`);
  const webLogin = (reply: FastifyReply, user: string) => { const s = sessions.create(user); reply.header("set-cookie", [cookie(COOKIE, sessions.cookieValue(s), cfg, { maxAge: sessions.maxAgeSec(s) }), cookie(CSRF_COOKIE, s.csrf, cfg, { httpOnly: false })]); return s; };

  // ---- Sign in with Apple (web) ----
  app.get("/api/auth/apple/web", async (req, reply) => {
    if (!c2.appleServicesId) return reply.code(503).send({ code: "APPLE_UNAVAILABLE", message: "Sign in with Apple is not configured yet" });
    if (!L.appleIp.take(req.ip)) return tooMany(reply);
    const state = randomBytes(24).toString("base64url"), nonce = randomBytes(24).toString("base64url"); const ret = safeReturn((req.query as { return?: string }).return);
    // form_post is a cross-site POST, so the state cookie must be SameSite=None; Secure.
    reply.header("set-cookie", `${STATE}=${Buffer.from(JSON.stringify({ state, nonce, ret })).toString("base64url")}; Path=/api/auth/apple; Max-Age=600; HttpOnly; SameSite=None; Secure`);
    const u = new URL("https://appleid.apple.com/auth/authorize");
    for (const [k, v] of Object.entries({ client_id: c2.appleServicesId, redirect_uri: `${cfg.publicOrigin}/api/auth/apple/callback`, response_type: "code id_token", response_mode: "form_post", scope: "name email", state, nonce: sha(nonce) })) u.searchParams.set(k, v);
    return reply.redirect(u.toString(), 302);
  });
  app.post("/api/auth/apple/callback", async (req, reply) => {
    if (!c2.appleServicesId) return reply.code(503).send({ code: "APPLE_UNAVAILABLE", message: "Sign in with Apple is not configured yet" });
    const b = (req.body ?? {}) as { state?: string; id_token?: string; user?: string; error?: string };
    let saved: { state: string; nonce: string; ret: string } | null = null;
    try { saved = JSON.parse(Buffer.from(parseCookies(req.headers.cookie)[STATE] ?? "", "base64url").toString()); } catch { saved = null; }
    reply.header("set-cookie", `${STATE}=; Path=/api/auth/apple; Max-Age=0; HttpOnly; SameSite=None; Secure`);
    const retry = `<p><a href="/api/auth/apple/web">Try again</a></p>`;
    if (b.error) return page(reply, 400, "Sign-in cancelled", retry);
    if (!saved || !b.state || b.state !== saved.state) return page(reply, 400, "Sign-in failed", "<p>The sign-in request expired. Please start again.</p>" + retry);
    try {
      const c = await verifyIdToken(b.id_token, { jwksUrl: "https://appleid.apple.com/auth/keys", issuers: ["https://appleid.apple.com"], audiences: [c2.appleServicesId, ...(cfg.native.appleBundleId ? [cfg.native.appleBundleId] : [])], fetch: http });
      if (c.nonce !== sha(saved.nonce)) throw new Error("nonce");
      let name = "Apple user"; try { const u = JSON.parse(b.user ?? "{}") as { name?: { firstName?: string; lastName?: string } }; const n = [u.name?.firstName, u.name?.lastName].filter(Boolean).join(" ").trim(); if (n) name = n.slice(0, 40); } catch { /* first-login only */ }
      const verified = c.email_verified === true || c.email_verified === "true";
      const { account, created } = accounts.upsertOAuth("apple", c.sub, name, verified && typeof c.email === "string" ? c.email : null);
      webLogin(reply, account.id); req.log.info({ evt: "login", via: "apple-web", user: account.id, created });
      return page(reply, 200, "Signed in", `<p><a href="${esc(saved.ret)}">Continue</a></p>`, saved.ret);
    } catch { req.log.warn({ evt: "signin_failed", provider: "apple" }); return page(reply, 401, "Sign-in failed", "<p>We could not verify your Apple ID.</p>" + retry); }
  });

  // SMS sign-in is disabled. The routes stay so old clients get a clear error; no Twilio or Turnstile calls.
  const smsDisabled = (reply: FastifyReply) => reply.code(410).send({ error: "sms_signin_disabled" });
  app.get("/api/auth/sms/config", async (_req, reply) => smsDisabled(reply));
  app.post("/api/auth/sms/start", async (_req, reply) => smsDisabled(reply));
  app.post("/api/auth/sms/verify", async (_req, reply) => smsDisabled(reply));
}
