// Apple in-app purchases (docs/social-api.md "In-app purchases — Apple"): POST /api/iap/apple and the
// App Store Server Notifications v2 webhook. All grant the same `pro` entitlement.
import type { FastifyInstance, FastifyReply } from "fastify";
import type { X509Certificate } from "node:crypto";
import type { Config } from "../config.ts";
import type { SessionStore } from "../security/authentication.ts";
import type { IapStore } from "../persistence/iap.ts";
import { RateLimiter } from "../security/rate-limit.ts";
import { currentSession } from "./agent.ts";
import { verifyAppleJws, JwsError } from "../iap/apple-jws.ts";

export const iapProducts = (bundle: string) => ({ [`${bundle}.pro_monthly`]: "sub", [`${bundle}.pro_yearly`]: "sub", [`${bundle}.lifetime`]: "life" }) as Record<string, "sub" | "life">;
interface Tx { transactionId?: string; originalTransactionId?: string; bundleId?: string; productId?: string; expiresDate?: number; revocationDate?: number; environment?: string; appAccountToken?: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function iapRoutes(app: FastifyInstance, cfg: Config, d: { sessions: SessionStore; iap: IapStore; roots: X509Certificate[]; now?: () => number }) {
  const now = d.now ?? Date.now; const { iap } = d; const bundle = cfg.iap.bundleId; const products = iapProducts(bundle);
  const ipL = new RateLimiter(30), userL = new RateLimiter(10), hookL = new RateLimiter(300);
  const bad = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ code, message, error: status === 409 ? "Conflict" : status === 429 ? "Too Many Requests" : "Bad Request", statusCode: status });
  const envOk = (e: unknown) => e === "Production" || (cfg.iap.allowSandbox && (e === "Sandbox" || e === "Xcode"));
  const answer = (orig: string) => { const t = iap.get(orig)!; const on = iap.active(t, now()); return { entitlements: on ? ["pro"] : [], expires_at: t.expires_at, product_id: t.product_id, environment: t.environment }; };

  app.post("/api/iap/apple", { bodyLimit: 131072 }, async (req, reply) => {
    if (!ipL.take(req.ip)) return bad(reply, 429, "RATE_LIMITED", "slow down");
    const s = currentSession(req, d.sessions); if (s && !userL.take(s.user)) return bad(reply, 429, "RATE_LIMITED", "slow down");
    const b = (req.body ?? {}) as { signed_transaction?: unknown; app_account_token?: unknown };
    const token = typeof b.app_account_token === "string" && UUID.test(b.app_account_token) ? b.app_account_token.toLowerCase() : null;
    let tx: Tx; try { tx = verifyAppleJws<Tx>(b.signed_transaction, { roots: d.roots, now: now() }); } catch (e) { req.log.warn({ evt: "iap_invalid", err: e instanceof JwsError ? e.message : "verify error" }); return bad(reply, 400, "INVALID_JWS", "could not verify the transaction"); }
    if (tx.bundleId !== bundle) return bad(reply, 400, "WRONG_BUNDLE", "transaction is for another app");
    if (!tx.productId || !products[tx.productId]) return bad(reply, 400, "UNKNOWN_PRODUCT", "unknown product");
    if (!envOk(tx.environment)) return bad(reply, 400, "SANDBOX_NOT_ALLOWED", "sandbox purchases are not accepted here");
    if (tx.appAccountToken && token && tx.appAccountToken.toLowerCase() !== token) return bad(reply, 400, "TOKEN_MISMATCH", "app_account_token does not match the transaction");
    const orig = String(tx.originalTransactionId ?? tx.transactionId ?? ""), txid = String(tx.transactionId ?? orig); if (!orig) return bad(reply, 400, "INVALID_JWS", "transaction id missing");
    const appToken = (tx.appAccountToken ?? token)?.toLowerCase() ?? null;
    // ownership: bearer > account linked to the token > pending (claimed later)
    const prior = iap.get(orig); const tokenUser = appToken ? iap.tokenOwner(appToken) : null;
    const user = s?.user ?? tokenUser ?? prior?.user ?? null;
    if (user && ((prior?.user && prior.user !== user) || (tokenUser && tokenUser !== user))) return bad(reply, 409, "IAP_OWNED_BY_OTHER", "this purchase belongs to another account");
    if (prior && iap.seenTx(txid) && (!user || prior.user === user)) return answer(orig); // idempotent repost
    iap.upsert({ original_tx: orig, last_tx: txid, user, app_token: appToken, product_id: tx.productId, environment: String(tx.environment), expires_at: products[tx.productId] === "life" ? null : Number(tx.expiresDate ?? 0) || null, revoked_at: tx.revocationDate ? Number(tx.revocationDate) : null });
    if (user && appToken) iap.bindToken(appToken, user);
    req.log.info({ evt: "iap_apple", user, product: tx.productId, env: tx.environment });
    return answer(orig);
  });

  app.post("/api/iap/apple/notifications", { bodyLimit: 262144 }, async (req, reply) => {
    if (!hookL.take(req.ip)) return bad(reply, 429, "RATE_LIMITED", "slow down");
    type N = { notificationType?: string; subtype?: string; notificationUUID?: string; data?: { bundleId?: string; environment?: string; signedTransactionInfo?: string; signedRenewalInfo?: string } };
    let n: N, tx: Tx | null = null, ren: { autoRenewStatus?: number; gracePeriodExpiresDate?: number } | null = null;
    try {
      n = verifyAppleJws<N>((req.body as { signedPayload?: unknown } | null)?.signedPayload, { roots: d.roots, now: now() });
      if (n.data?.signedTransactionInfo) tx = verifyAppleJws<Tx>(n.data.signedTransactionInfo, { roots: d.roots, now: now() });
      if (n.data?.signedRenewalInfo) ren = verifyAppleJws(n.data.signedRenewalInfo, { roots: d.roots, now: now() });
    } catch (e) { req.log.warn({ evt: "iap_notify_invalid", err: e instanceof JwsError ? e.message : "verify error" }); return bad(reply, 400, "INVALID_JWS", "could not verify the notification"); }
    if (n.data?.bundleId && n.data.bundleId !== bundle) return bad(reply, 400, "WRONG_BUNDLE", "notification is for another app");
    if (!n.notificationUUID || iap.notificationSeen(n.notificationUUID)) return { ok: true };
    if (!envOk(n.data?.environment ?? tx?.environment)) { req.log.info({ evt: "iap_notify_ignored_env", env: n.data?.environment }); return { ok: true }; }
    const type = n.notificationType ?? "";
    if (tx?.originalTransactionId && tx.productId && products[tx.productId]) {
      const orig = String(tx.originalTransactionId); const prior = iap.get(orig); const appToken = tx.appAccountToken?.toLowerCase() ?? null;
      const user = prior?.user ?? (appToken ? iap.tokenOwner(appToken) : null);
      const exp = products[tx.productId] === "life" ? null : Number(tx.expiresDate ?? 0) || null;
      const t = now();
      const base = { original_tx: orig, last_tx: String(tx.transactionId ?? orig), user, app_token: appToken, product_id: tx.productId, environment: String(tx.environment ?? n.data?.environment), expires_at: exp, revoked_at: prior?.revoked_at ?? null,
        auto_renew: ren?.autoRenewStatus === undefined ? null : Number(ren.autoRenewStatus), grace_until: prior?.grace_until ?? null };
      if (["SUBSCRIBED", "DID_RENEW", "OFFER_REDEEMED"].includes(type)) iap.upsert({ ...base, revoked_at: null, grace_until: null });
      else if (type === "DID_FAIL_TO_RENEW") iap.upsert({ ...base, grace_until: n.subtype === "GRACE_PERIOD" && ren?.gracePeriodExpiresDate ? Number(ren.gracePeriodExpiresDate) : base.grace_until });
      else if (type === "GRACE_PERIOD_EXPIRED" || type === "EXPIRED") iap.upsert({ ...base, expires_at: Math.min(exp ?? t, t), grace_until: null });
      else if (type === "REFUND" || type === "REVOKE") iap.upsert({ ...base, revoked_at: Number(tx.revocationDate ?? t) });
      else if (type === "DID_CHANGE_RENEWAL_STATUS" || type === "DID_CHANGE_RENEWAL_PREF") { if (prior) iap.patch(orig, { auto_renew: base.auto_renew }); }
    }
    req.log.info({ evt: "iap_notify", type, subtype: n.subtype ?? null });
    return { ok: true };
  });
}
