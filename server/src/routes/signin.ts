// "Sign in with GitHub / Google" (OAuth 2.0 authorization-code flow against the provider, server-side only).
//   GET /api/auth/:provider?return=/path   -> redirect to the provider with a signed, single-use state
//   GET /api/auth/:provider/callback        -> exchange the code, find-or-create the account, start a GBK session
// A provider is live only when its client id + secret are configured; otherwise its routes 404 and the UI hides it.
// The callback answers with a tiny same-origin page that navigates on, so the SameSite=Strict session cookie is
// sent on the next request (a cross-site redirect chain would drop it).
import { randomBytes, createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Config } from "../config.ts";
import { COOKIE, CSRF_COOKIE, cookie, parseCookies, type SessionStore } from "../security/authentication.ts";
import type { AccountStore } from "../persistence/accounts.ts";
import type { RateLimiter } from "../security/rate-limit.ts";

const STATE_COOKIE = "gbk_oauth_state";
type ProviderName = "github" | "google";
interface Identity { id: string; name: string; email: string | null }
export type FetchLike = typeof fetch;

/** Only same-origin absolute paths may be used as a post-login destination (no open redirects). */
export const safeReturn = (r: unknown) => (typeof r === "string" && r.startsWith("/") && !r.startsWith("//") && !r.startsWith("/\\") && r.length <= 2000 ? r : "/studio");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function signinRoutes(app: FastifyInstance, cfg: Config, sessions: SessionStore, accounts: AccountStore, limiter: RateLimiter, http: FetchLike = fetch) {
  const redirectUri = (p: ProviderName) => `${cfg.publicOrigin}/api/auth/${p}/callback`;
  const creds = (p: string) => (p === "github" ? cfg.auth.github : p === "google" ? cfg.auth.google : null);
  const stateCookie = (v: string, maxAge: number) => cookie(STATE_COOKIE, v, cfg, { maxAge }).replace("SameSite=Strict", "SameSite=Lax");

  app.get("/api/auth/:provider", async (req, reply) => {
    const p = (req.params as { provider: string }).provider; const c = creds(p);
    if (!c) return reply.code(404).send({ code: "PROVIDER_UNAVAILABLE", message: `sign-in with ${p} is not configured` });
    if (!limiter.take(`signin:${req.ip}`)) return reply.code(429).send({ code: "RATE_LIMITED", message: "too many sign-in attempts; wait a minute" });
    const state = randomBytes(24).toString("base64url"); const verifier = randomBytes(32).toString("base64url");
    const ret = safeReturn((req.query as { return?: string }).return);
    reply.header("set-cookie", stateCookie(Buffer.from(JSON.stringify({ state, verifier, ret, p })).toString("base64url"), 600));
    const u = p === "github" ? new URL("https://github.com/login/oauth/authorize") : new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", c.clientId); u.searchParams.set("redirect_uri", redirectUri(p as ProviderName)); u.searchParams.set("state", state);
    if (p === "github") { u.searchParams.set("scope", "read:user"); u.searchParams.set("allow_signup", "true"); }
    else { u.searchParams.set("response_type", "code"); u.searchParams.set("scope", "openid email profile"); u.searchParams.set("prompt", "select_account");
      u.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url")); u.searchParams.set("code_challenge_method", "S256"); }
    return reply.redirect(u.toString());
  });

  const page = (reply: FastifyReply, status: number, title: string, body: string, to?: string) =>
    reply.code(status).type("text/html").header("cache-control", "no-store").header("referrer-policy", "no-referrer").send(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>${to ? `<meta http-equiv="refresh" content="0;url=${esc(to)}">` : ""}
<body style="font-family:system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem;background:#fff;color:#222"><h1>${esc(title)}</h1>${body}</body>`);

  app.get("/api/auth/:provider/callback", async (req, reply) => {
    const p = (req.params as { provider: string }).provider; const c = creds(p);
    if (!c) return reply.code(404).send({ code: "PROVIDER_UNAVAILABLE", message: `sign-in with ${p} is not configured` });
    const q = req.query as { code?: string; state?: string; error?: string };
    let saved: { state: string; verifier: string; ret: string; p: string } | null = null;
    try { saved = JSON.parse(Buffer.from(parseCookies(req.headers.cookie)[STATE_COOKIE] ?? "", "base64url").toString()); } catch { saved = null; }
    reply.header("set-cookie", stateCookie("", 0)); // single use
    const retry = `<p><a href="/api/auth/${esc(p)}">Try again</a> · <a href="/">Home</a></p>`;
    if (q.error) return page(reply, 400, "Sign-in cancelled", `<p>The provider returned: ${esc(String(q.error).slice(0, 100))}.</p>${retry}`);
    if (!saved || saved.p !== p || !q.state || saved.state !== q.state || !q.code) return page(reply, 400, "Sign-in failed", "<p>The sign-in request expired or did not match. Please start again.</p>" + retry);
    let who: Identity;
    try { who = p === "github" ? await github(c, q.code, redirectUri("github")) : await google(c, q.code, redirectUri("google"), saved.verifier); }
    catch (e) { req.log.warn({ evt: "signin_failed", provider: p, err: (e as Error).message }); return page(reply, 502, "Sign-in failed", "<p>We could not verify your account with the provider.</p>" + retry); }
    const { account, created } = accounts.upsertOAuth(p as ProviderName, who.id, who.name, who.email);
    const s = sessions.create(account.id);
    reply.header("set-cookie", [stateCookie("", 0), cookie(COOKIE, sessions.cookieValue(s), cfg, { maxAge: sessions.maxAgeSec(s) }), cookie(CSRF_COOKIE, s.csrf, cfg, { httpOnly: false })]);
    req.log.info({ evt: "login", via: p, user: account.id, created });
    return page(reply, 200, "Signed in", `<p>Signed in as ${esc(account.name)}. <a href="${esc(saved.ret)}">Continue</a></p>`, saved.ret);
  });

  async function github(c: { clientId: string; clientSecret: string }, code: string, redirect: string): Promise<Identity> {
    const t = await http("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: redirect }), signal: AbortSignal.timeout(10_000) });
    const tok = (await t.json()) as { access_token?: string; error?: string };
    if (!tok.access_token) throw new Error(`token: ${tok.error ?? t.status}`);
    const u = await http("https://api.github.com/user", { headers: { authorization: `Bearer ${tok.access_token}`, accept: "application/vnd.github+json", "user-agent": "gbk-composer" }, signal: AbortSignal.timeout(10_000) });
    const j = (await u.json()) as { id?: number; login?: string; name?: string | null; email?: string | null };
    if (!u.ok || typeof j.id !== "number") throw new Error(`user: ${u.status}`);
    return { id: String(j.id), name: j.login ?? j.name ?? `github ${j.id}`, email: j.email ?? null };
  }
  async function google(c: { clientId: string; clientSecret: string }, code: string, redirect: string, verifier: string): Promise<Identity> {
    const t = await http("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier }).toString(), signal: AbortSignal.timeout(10_000) });
    const tok = (await t.json()) as { access_token?: string; error?: string };
    if (!tok.access_token) throw new Error(`token: ${tok.error ?? t.status}`);
    const u = await http("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(10_000) });
    const j = (await u.json()) as { sub?: string; name?: string; email?: string; email_verified?: boolean };
    if (!u.ok || !j.sub) throw new Error(`userinfo: ${u.status}`);
    return { id: j.sub, name: j.name || (j.email ?? "").split("@")[0] || "Google user", email: j.email_verified ? (j.email ?? null) : null };
  }
}
