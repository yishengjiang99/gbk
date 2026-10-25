// Native iOS endpoints (docs/social-api.md "Auth & session", "Notifications & push"):
// Apple / Google ID-token exchange -> bearer access + rotating refresh, logout, web-view one-time code,
// DELETE /api/me, APNs device registration, apple-app-site-association.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, createHmac } from "node:crypto";
import type { Config } from "../config.ts";
import { COOKIE, CSRF_COOKIE, cookie, type SessionStore } from "../security/authentication.ts";
import { isGuestAccount, type AccountStore } from "../persistence/accounts.ts";
import { badText } from "../persistence/social.ts";
import type { NativeStore } from "../persistence/native.ts";
import type { ShareStore } from "../persistence/shares.ts";
import type { SocialStore } from "../persistence/social.ts";
import { RateLimiter } from "../security/rate-limit.ts";
import { verifyIdToken, IdTokenError } from "../security/id-token.ts";
import { currentSession, guardWrite } from "./agent.ts";
import { safeReturn } from "./signin.ts";
import { isGuest } from "../mcp/guest.ts";

export const ACCESS_TTL_MS = 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, APNS_TOKEN = /^[0-9a-f]{64,200}$/i;
export const GUEST_NAME = /^[A-Z][a-z]{1,11}[A-Z][a-z]{1,11}$/, GUEST_DEVICE = /^[A-Za-z0-9_-]{16,128}$/;
const bearer = (req: FastifyRequest) => { const a = req.headers.authorization; return typeof a === "string" && /^Bearer\s+\S+$/i.test(a) ? a.replace(/^Bearer\s+/i, "").trim() : null; };

export function nativeRoutes(app: FastifyInstance, cfg: Config, d: { sessions: SessionStore; accounts: AccountStore; native: NativeStore; shares: ShareStore; social: SocialStore; iap?: import("../persistence/iap.ts").IapStore; me: (user: string) => object; fetch?: typeof fetch }) {
  const { sessions, accounts, native } = d;
  const authLimiter = new RateLimiter(cfg.security.loginPerMinute), codeLimiter = new RateLimiter(20), pushLimiter = new RateLimiter(30);
  const limited = (reply: FastifyReply, l: RateLimiter, key: string) => { if (l.take(key)) return false; void reply.code(429).header("retry-after", String(l.retryAfterSec(key))).send({ code: "RATE_LIMITED", message: "slow down" }); return true; };
  const pair = (user: string) => {
    const s = sessions.create(user, ACCESS_TTL_MS);
    return { access_token: sessions.cookieValue(s), token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: native.issueRefresh(user, s.id), me: d.me(user) };
  };
  const exchange = async (req: FastifyRequest, reply: FastifyReply, provider: "apple" | "google", verifyFn: () => Promise<{ sub: string; name: string; email: string | null }>) => {
    if (limited(reply, authLimiter, `native:${req.ip}`)) return;
    let who; try { who = await verifyFn(); } catch (e) {
      req.log.warn({ evt: "native_signin_failed", provider, err: e instanceof IdTokenError ? e.message : "verify error" });
      return reply.code(401).send({ code: "INVALID_TOKEN", message: "could not verify the sign-in token" });
    }
    // Guest upgrade (docs/social-api.md): a valid guest bearer is linked in place, or merged into an existing account.
    const gs = bearer(req) ? currentSession(req, sessions) : null; const guest = gs && isGuestAccount(gs.user) && accounts.get(gs.user) ? gs.user : null;
    if (guest) {
      const existing = accounts.byProvider(provider, who.sub);
      if (!existing) { accounts.link(guest, provider, who.sub, who.name, who.email); native.revokeUser(guest); req.log.info({ evt: "login", via: `${provider}-native`, user: guest, upgraded: "linked" }); return { ...pair(guest), upgraded: "linked" }; }
      d.social.mergeUser(guest, existing.id); native.movePush(guest, existing.id); d.iap?.moveUser(guest, existing.id); native.purgeUser(guest); sessions.destroy(gs!.id); accounts.delete(guest);
      accounts.upsertOAuth(provider, who.sub, who.name, who.email);
      req.log.info({ evt: "login", via: `${provider}-native`, user: existing.id, upgraded: "merged" }); return { ...pair(existing.id), upgraded: "merged" };
    }
    const { account, created } = accounts.upsertOAuth(provider, who.sub, who.name, who.email);
    req.log.info({ evt: "login", via: `${provider}-native`, user: account.id, created });
    return pair(account.id);
  };

  // ---- Guest accounts (iOS): two-word username, idempotent per device, 409 on handle collision ----
  const guestNew = new RateLimiter(5, 3_600_000), guestAll = new RateLimiter(20, 3_600_000);
  const err = (reply: FastifyReply, status: number, code: string, message: string, error: string) => reply.code(status).send({ code, message, error, statusCode: status });
  app.post("/api/auth/anonymous", async (req, reply) => {
    if (!guestAll.take(req.ip)) return reply.code(429).header("retry-after", String(guestAll.retryAfterSec(req.ip))).send({ code: "RATE_LIMITED", message: "slow down", error: "Too Many Requests", statusCode: 429 });
    const b = (req.body ?? {}) as { deviceId?: unknown; username?: unknown };
    if (typeof b.deviceId !== "string" || !GUEST_DEVICE.test(b.deviceId)) return err(reply, 422, "INVALID_DEVICE", "deviceId must be 16-128 of A-Z a-z 0-9 - _", "Unprocessable Entity");
    const pid = createHmac("sha256", cfg.security.sessionSecret).update(`gbk-guest-device:${b.deviceId}`).digest("hex").slice(0, 32);
    const known = accounts.byProvider("guest", pid);
    if (known) { req.log.info({ evt: "login", via: "guest", user: known.id, created: false }); const p = pair(known.id); return { ...p, token: p.access_token, refreshToken: p.refresh_token, user: p.me }; }
    if (typeof b.username !== "string" || !GUEST_NAME.test(b.username) || b.username.length < 4 || b.username.length > 20 || badText(b.username) || badText(b.username.replace(/([a-z])([A-Z])/g, "$1 $2"))) return err(reply, 422, "INVALID_USERNAME", "username must be two capitalized words, letters only, 4-20 characters", "Unprocessable Entity");
    const handle = b.username.toLowerCase();
    if (d.social.byHandle(handle)) return err(reply, 409, "HANDLE_TAKEN", "that username is taken; pick another", "Conflict");
    if (!guestNew.take(req.ip)) return reply.code(429).header("retry-after", String(guestNew.retryAfterSec(req.ip))).send({ code: "RATE_LIMITED", message: "too many new guests; try later", error: "Too Many Requests", statusCode: 429 });
    const { account } = accounts.upsertOAuth("guest", pid, b.username, null);
    if (!d.social.createProfileExact(account.id, handle, b.username)) { accounts.delete(account.id); return err(reply, 409, "HANDLE_TAKEN", "that username is taken; pick another", "Conflict"); }
    req.log.info({ evt: "login", via: "guest", user: account.id, created: true });
    const p = pair(account.id); return { ...p, token: p.access_token, refreshToken: p.refresh_token, user: p.me };
  });

  app.post("/api/auth/apple", async (req, reply) => {
    if (!cfg.native.appleBundleId) return reply.code(503).send({ code: "APPLE_UNAVAILABLE", message: "Sign in with Apple is not configured yet" });
    const b = (req.body ?? {}) as { identityToken?: unknown; nonce?: unknown; displayName?: unknown };
    if (typeof b.nonce !== "string" || !b.nonce || b.nonce.length > 200) return reply.code(400).send({ code: "INVALID_ARGUMENT", message: "nonce required" });
    return exchange(req, reply, "apple", async () => {
      const c = await verifyIdToken(b.identityToken, { jwksUrl: "https://appleid.apple.com/auth/keys", issuers: ["https://appleid.apple.com"], audiences: [cfg.native.appleBundleId], fetch: d.fetch });
      const want = createHash("sha256").update(b.nonce as string).digest("hex");
      if (c.nonce !== want && c.nonce !== b.nonce) throw new IdTokenError("nonce mismatch");
      const verified = c.email_verified === true || c.email_verified === "true";
      const name = typeof b.displayName === "string" && b.displayName.trim() ? b.displayName.trim().slice(0, 40) : (verified && c.email && !String(c.email).endsWith("privaterelay.appleid.com") ? String(c.email).split("@")[0] : "Apple user");
      return { sub: c.sub, name, email: verified && typeof c.email === "string" ? c.email : null };
    });
  });
  app.post("/api/auth/google/native", async (req, reply) => {
    const auds = [...cfg.native.googleClientIds, ...(cfg.auth.google ? [cfg.auth.google.clientId] : [])];
    if (!auds.length) return reply.code(503).send({ code: "GOOGLE_UNAVAILABLE", message: "Google sign-in is not configured" });
    const b = (req.body ?? {}) as { idToken?: unknown };
    return exchange(req, reply, "google", async () => {
      const c = await verifyIdToken(b.idToken, { jwksUrl: "https://www.googleapis.com/oauth2/v3/certs", issuers: ["https://accounts.google.com", "accounts.google.com"], audiences: auds, fetch: d.fetch });
      const verified = c.email_verified === true || c.email_verified === "true";
      return { sub: c.sub, name: typeof c.name === "string" && c.name ? c.name : "Google user", email: verified && typeof c.email === "string" ? c.email : null };
    });
  });
  app.post("/api/auth/refresh", async (req, reply) => {
    if (limited(reply, authLimiter, `refresh:${req.ip}`)) return;
    const r = native.consumeRefresh((req.body as { refresh_token?: unknown } | null)?.refresh_token);
    if (!r || r === "reused") return reply.code(401).send({ code: "INVALID_REFRESH", message: "sign in again" });
    if (!accounts.get(r.user)) return reply.code(401).send({ code: "INVALID_REFRESH", message: "sign in again" });
    sessions.destroy(r.sessionId); return pair(r.user);
  });
  app.post("/api/auth/logout", async (req, reply) => {
    const s = currentSession(req, sessions); if (!s) return { ok: true };
    if (!guardWrite(cfg, req, reply, s)) return;
    native.revokeSession(s.id); const rt = (req.body as { refresh_token?: unknown } | null)?.refresh_token; if (typeof rt === "string") native.revokeRefresh(rt);
    sessions.destroy(s.id);
    if (!bearer(req)) reply.header("set-cookie", cookie(COOKIE, "", cfg, { maxAge: 0 }));
    return { ok: true };
  });
  // Web-view handoff: the app (bearer) gets a 60 s single-use code; the WKWebView opens /redeem and gets a cookie session.
  app.post("/api/auth/web-code", async (req, reply) => {
    const s = currentSession(req, sessions); if (!s || !bearer(req) || isGuest(s.user)) return reply.code(401).send({ code: "UNAUTHENTICATED", message: "bearer token required" });
    if (limited(reply, codeLimiter, s.user)) return;
    return { code: native.issueCode(s.user), expires_in: 60 };
  });
  app.get("/api/auth/web-code/redeem", async (req, reply) => {
    const q = req.query as { code?: string; return?: string };
    if (limited(reply, codeLimiter, `redeem:${req.ip}`)) return;
    const user = native.redeemCode(q.code); const ret = safeReturn(q.return);
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    if (!user || !accounts.get(user)) return reply.redirect(`${ret}${ret.includes("?") ? "&" : "?"}signin=expired`, 302);
    const s = sessions.create(user);
    reply.header("set-cookie", [cookie(COOKIE, sessions.cookieValue(s), cfg, { maxAge: sessions.maxAgeSec(s) }).replace("SameSite=Strict", "SameSite=Lax"), cookie(CSRF_COOKIE, s.csrf, cfg, { httpOnly: false })]);
    req.log.info({ evt: "login", via: "web-code", user });
    return reply.redirect(ret, 302);
  });

  app.delete("/api/me", async (req, reply) => {
    const s = currentSession(req, sessions);
    if (!s || isGuest(s.user)) return reply.code(401).send({ code: "UNAUTHENTICATED", message: "sign in first" });
    if (!guardWrite(cfg, req, reply, s)) return;
    const u = s.user;
    d.shares.deleteOwner(u); d.social.purgeUser(u); d.iap?.detach(u); native.purgeUser(u); sessions.destroyUser(u); accounts.delete(u);
    req.log.info({ evt: "account_deleted", user: u });
    if (!bearer(req)) reply.header("set-cookie", cookie(COOKIE, "", cfg, { maxAge: 0 }));
    return { ok: true };
  });

  app.post("/api/push/register", async (req, reply) => {
    const s = currentSession(req, sessions);
    if (!s || isGuest(s.user)) return reply.code(401).send({ code: "UNAUTHENTICATED", message: "sign in first" });
    if (!guardWrite(cfg, req, reply, s)) return; if (limited(reply, pushLimiter, s.user)) return;
    const b = (req.body ?? {}) as { installId?: unknown; token?: unknown; environment?: unknown };
    if (typeof b.installId !== "string" || !UUID.test(b.installId)) return reply.code(400).send({ code: "INVALID_ARGUMENT", message: "installId (UUID) is required" });
    if (typeof b.token !== "string" || !APNS_TOKEN.test(b.token)) return reply.code(400).send({ code: "INVALID_ARGUMENT", message: "token must be the hex APNs device token" });
    if (b.environment !== "sandbox" && b.environment !== "production") return reply.code(400).send({ code: "INVALID_ARGUMENT", message: "environment must be sandbox or production" });
    native.registerPush({ install_id: b.installId.toLowerCase(), user_id: s.user, token: b.token.toLowerCase(), environment: b.environment });
    return { ok: true };
  });
  app.post("/api/push/unregister", async (req, reply) => {
    const s = currentSession(req, sessions);
    if (!s) return reply.code(401).send({ code: "UNAUTHENTICATED", message: "sign in first" });
    if (!guardWrite(cfg, req, reply, s)) return;
    const id = (req.body as { installId?: unknown } | null)?.installId;
    if (typeof id !== "string" || !UUID.test(id)) return reply.code(400).send({ code: "INVALID_ARGUMENT", message: "installId (UUID) is required" });
    return { ok: true, removed: native.unregisterPush(id.toLowerCase(), s.user) };
  });

  app.get("/.well-known/apple-app-site-association", async (_req, reply) => {
    if (!cfg.native.iosAppIds.length) return reply.code(404).send({ code: "NOT_FOUND", message: "no iOS app configured" });
    reply.header("content-type", "application/json").header("cache-control", "public, max-age=3600");
    return { applinks: { details: [{ appIDs: cfg.native.iosAppIds, components: [{ "/": "/s/*" }, { "/": "/u/*" }, { "/": "/t/*" }, { "/": "/feed" }, { "/": "/explore" }] }] }, webcredentials: { apps: cfg.native.iosAppIds } };
  });
  return { pair };
}
