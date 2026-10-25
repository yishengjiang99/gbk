// Web Sign in with Apple (form_post, id_token verified against Apple JWKS) and SMS sign-in via Twilio Verify with a
// Cloudflare Turnstile check before every send. Each turns on when its env keys exist; otherwise 503. No flags.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
/** E.164 normalize: digits only, leading +; US 10-digit numbers get +1. */
export function e164(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 32) return null;
  const t = raw.trim(); const d = t.replace(/[^\d]/g, "");
  const n = t.startsWith("+") ? `+${d}` : d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : null;
  return n && /^\+[1-9]\d{7,14}$/.test(n) ? n : null;
}

export function authExtraRoutes(app: FastifyInstance, cfg: Config, d: { sessions: SessionStore; accounts: AccountStore; pair: (user: string) => object; fetch?: FetchLike }) {
  const http = d.fetch ?? fetch; const { sessions, accounts } = d; const c2 = cfg.signin2;
  const L = { ip: new RateLimiter(5, 3_600_000), phone15: new RateLimiter(3, 900_000), phoneDay: new RateLimiter(10, 86_400_000), global: new RateLimiter(200, 3_600_000), check: new RateLimiter(5, 900_000), appleIp: new RateLimiter(cfg.security.loginPerMinute) };
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

  // ---- SMS (Twilio Verify) ----
  const smsReady = () => !!(c2.twilio && c2.turnstileSecret);
  const twilio = async (path: string, form: Record<string, string>) => {
    const t = c2.twilio!; const r = await http(`https://verify.twilio.com/v2/Services/${encodeURIComponent(t.verifySid)}/${path}`, { method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Basic ${Buffer.from(`${t.user}:${t.secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    return { ok: r.ok, status: r.status, body: (await r.json().catch(() => ({}))) as { status?: string } };
  };
  app.get("/api/auth/sms/config", async () => ({ enabled: smsReady(), turnstileSiteKey: smsReady() ? c2.turnstileSiteKey : null, countries: c2.smsPrefixes }));
  app.post("/api/auth/sms/start", async (req, reply) => {
    if (!smsReady()) return reply.code(503).send({ code: "SMS_UNAVAILABLE", message: "SMS sign-in is not available yet" });
    const b = (req.body ?? {}) as { phone?: unknown; turnstileToken?: unknown };
    const phone = e164(b.phone); if (!phone) return reply.code(422).send({ code: "INVALID_PHONE", message: "enter a full phone number" });
    if (!c2.smsPrefixes.some((p) => phone.startsWith(p))) return reply.code(422).send({ code: "COUNTRY_NOT_SUPPORTED", message: "SMS sign-in isn't available for this country yet" });
    if (typeof b.turnstileToken !== "string" || !b.turnstileToken || b.turnstileToken.length > 4096) return reply.code(400).send({ code: "CAPTCHA_REQUIRED", message: "complete the captcha" });
    const ts = await http("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ secret: c2.turnstileSecret, response: b.turnstileToken, remoteip: req.ip }).toString() })
      .then((r) => r.json() as Promise<{ success?: boolean }>).catch(() => ({ success: false }));
    if (!ts.success) return reply.code(403).send({ code: "CAPTCHA_FAILED", message: "captcha check failed; try again" });
    if (!L.ip.take(req.ip) || !L.phone15.take(phone) || !L.phoneDay.take(phone) || !L.global.take("all")) return tooMany(reply);
    const r = await twilio("Verifications", { To: phone, Channel: "sms" }).catch(() => null);
    req.log.info({ evt: "sms_start", ok: !!r?.ok, status: r?.status });
    if (!r || (!r.ok && r.status >= 500)) return reply.code(502).send({ code: "SMS_FAILED", message: "could not send the code; try again" });
    return { ok: true }; // generic: same answer for new and known numbers
  });
  app.post("/api/auth/sms/verify", async (req, reply) => {
    if (!smsReady()) return reply.code(503).send({ code: "SMS_UNAVAILABLE", message: "SMS sign-in is not available yet" });
    const b = (req.body ?? {}) as { phone?: unknown; code?: unknown; client?: unknown };
    const phone = e164(b.phone); const code = typeof b.code === "string" ? b.code.trim() : "";
    if (!phone || !/^\d{4,10}$/.test(code)) return reply.code(422).send({ code: "INVALID_CODE", message: "enter the code we sent" });
    if (!L.check.take(phone)) return tooMany(reply);
    const r = await twilio("VerificationCheck", { To: phone, Code: code }).catch(() => null);
    if (!r?.ok || r.body.status !== "approved") return reply.code(401).send({ code: "INVALID_CODE", message: "that code didn't work" });
    const { account, created } = accounts.upsertOAuth("phone", sha(`gbk-phone:${phone}`).slice(0, 32), "Musician", null);
    req.log.info({ evt: "login", via: "sms", user: account.id, created });
    if (b.client === "native") return d.pair(account.id);
    const s = webLogin(reply, account.id); return { ok: true, csrf: s.csrf };
  });
}
