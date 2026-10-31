// Billing funnel telemetry endpoints (#118). Three doors, one recorder (persistence/billing.ts):
//
// 1) POST /api/billing/events — client-emitted events from the web Studio/paywall (#116) and the iOS
//    app (#119). Only funnel-step events a client can truthfully report; money events (purchase, trial,
//    renewal, cancel, refund) are NOT accepted here — they must come from a server source (ASSN/Stripe),
//    never from the device that benefits from them. Session optional: signed-in events also land in the
//    per-account support log; anonymous ones are aggregate-only.
//    Body: { event, surface?, platform?, plan?, reason?, result? } or { events: [ ...same, max 20 ] }.
//
// 2) POST /api/billing/stripe-events — the finalcut hop. The Stripe webhook for compose checkout lives
//    in the finalcut service (it owns POST /api/compose/checkout); this is the receiving end. Contract
//    for the finalcut side: after handling a Stripe event, POST one JSON object per event with header
//    `x-gbk-billing-token: <COMPOSE_BILLING_WEBHOOK_TOKEN>` (same value in both services' env):
//      { "event": "checkout_start" | "purchase" | "trial_start" | "trial_convert" | "renewal" |
//                 "cancel" | "refund",
//        "account": "<gbk account id>",              // required for the support log; omit = aggregate only
//        "plan": "pro_monthly" | "pro_yearly" | "lifetime",
//        "value_cents": 4799,                         // purchase/renewal/refund amount, when known
//        "surface": "pricing", "platform": "web",     // optional, defaults pricing/web
//        "detail": "stripe event id" }                // optional, free-form, truncated
//    Ad attribution fields (#130, optional; only used for purchase/trial_start when X/Reddit CAPI is configured):
//      "event_id": "gc-…" (the Buy form's event_id = browser pixel conversion id), "twclid", "rdt_cid",
//      "email" (hashed with SHA-256 here, never stored or logged) or "email_sha256", "currency": "USD",
//      "ads_opt_out": "1" (the buyer's browser sent GPC/DNT -> nothing is sent to X or Reddit).
//    Mapping on the finalcut side: checkout.session created by /api/compose/checkout -> checkout_start;
//    checkout.session.completed / invoice.paid (first) -> purchase (or trial_start when the subscription
//    starts in trial); invoice.paid (later cycles) -> renewal (trial_convert for the first paid invoice
//    after a trial); customer.subscription.deleted / payment failure final -> cancel; charge.refunded ->
//    refund. Endpoint answers 404 until COMPOSE_BILLING_WEBHOOK_TOKEN is set.
//
// 3) GET /api/admin/billing?days=30 — the report: totals + paywall_view -> checkout_start -> purchase
//    overall and by surface/platform (COMPOSER_ADMIN_USERS, same gate as /api/admin/funnel).
//    GET /api/admin/billing-log?account=<id>&limit=100 — one account's billing events, for support.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "../config.ts";
import type { SessionStore } from "../security/authentication.ts";
import { originAllowed } from "../security/authorization.ts";
import { RateLimiter } from "../security/rate-limit.ts";
import type { FunnelStore, BillingEvent } from "../persistence/funnel.ts";
import type { BillingLog, BillingRecorder, BillingDims } from "../persistence/billing.ts";
import { currentSession } from "./agent.ts";
import type { AdsConversions } from "../ads/conversions.ts";

const CLIENT_EVENTS: readonly string[] = ["paywall_view", "paywall_dismiss", "plan_select", "checkout_start", "restore"];
const STRIPE_EVENTS: readonly string[] = ["checkout_start", "purchase", "trial_start", "trial_convert", "renewal", "cancel", "refund"];

const dimsOf = (e: Record<string, unknown>): BillingDims => ({
  surface: typeof e.surface === "string" ? e.surface : undefined,
  platform: typeof e.platform === "string" ? e.platform : undefined,
  plan: typeof e.plan === "string" ? e.plan : undefined,
  reason: typeof e.reason === "string" ? e.reason : undefined,
  result: typeof e.result === "string" ? e.result : undefined,
  detail: typeof e.detail === "string" ? e.detail : undefined,
  valueCents: typeof e.value_cents === "number" ? e.value_cents : null,
});
const listOf = (body: unknown): Record<string, unknown>[] => {
  const b = (body ?? {}) as { event?: unknown; events?: unknown };
  const raw = Array.isArray(b.events) ? b.events : b.event ? [b] : [];
  return raw.filter((e): e is Record<string, unknown> => !!e && typeof e === "object").slice(0, 20);
};

export function billingRoutes(app: FastifyInstance, cfg: Config, sessions: SessionStore,
  d: { funnel: FunnelStore; billing: BillingRecorder; log: BillingLog; ads?: AdsConversions }) {
  const lim = new RateLimiter(30), ipLim = new RateLimiter(120), hookLim = new RateLimiter(300);
  const admin = (req: FastifyRequest, reply: FastifyReply) => {
    const s = currentSession(req, sessions);
    if (!s) { void reply.code(401).send({ code: "UNAUTHENTICATED", message: "log in" }); return null; }
    if (!cfg.adminUsers.includes(s.user)) { void reply.code(403).send({ code: "FORBIDDEN", message: "admin only" }); return null; }
    return s;
  };

  app.post("/api/billing/events", { bodyLimit: 16384 }, async (req, reply) => {
    const s = currentSession(req, sessions); const bearer = /^Bearer /i.test(String(req.headers.authorization ?? ""));
    if (!bearer && req.headers.origin !== undefined && !originAllowed(cfg, req.headers.origin)) return reply.code(403).send({ code: "BAD_ORIGIN", message: "cross-origin request rejected" });
    const actor = s?.user ?? `ip:${req.ip}`;
    if (!lim.take(actor) || !ipLim.take(req.ip)) return reply.code(429).send({ code: "RATE_LIMITED", message: "slow down" });
    let accepted = 0;
    for (const e of listOf(req.body)) {
      if (typeof e.event !== "string" || !CLIENT_EVENTS.includes(e.event)) continue;
      d.billing.record(e.event as BillingEvent, { ...dimsOf(e), account: s?.user ?? null, provider: e.event === "restore" ? (typeof e.provider === "string" ? e.provider : undefined) : undefined });
      accepted++;
    }
    return { ok: true, accepted };
  });

  app.post("/api/billing/stripe-events", { bodyLimit: 16384 }, async (req, reply) => {
    const token = cfg.billing.webhookToken;
    if (!token) return reply.code(404).send({ code: "NOT_FOUND", message: "billing hop not configured" });
    const given = String(req.headers["x-gbk-billing-token"] ?? "");
    if (given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) return reply.code(401).send({ code: "UNAUTHENTICATED", message: "bad token" });
    if (!hookLim.take(req.ip)) return reply.code(429).send({ code: "RATE_LIMITED", message: "slow down" });
    let accepted = 0;
    for (const e of listOf(req.body)) {
      if (typeof e.event !== "string" || !STRIPE_EVENTS.includes(e.event)) continue;
      d.billing.record(e.event as BillingEvent, { ...dimsOf(e),
        account: typeof e.account === "string" ? e.account : null,
        provider: "stripe", surface: typeof e.surface === "string" ? e.surface : "pricing", platform: typeof e.platform === "string" ? e.platform : "web" });
      // #130: server-side ad conversion (X + Reddit CAPI). No-op unless configured; never awaited by the hop.
      if (d.ads?.active && (e.event === "purchase" || e.event === "trial_start")) {
        const str = (k: string) => (typeof e[k] === "string" ? (e[k] as string) : undefined);
        void d.ads.send({ event: e.event, conversionId: str("event_id") ?? "", valueCents: typeof e.value_cents === "number" ? e.value_cents : null, currency: str("currency")?.toUpperCase(),
          twclid: str("twclid"), rdtCid: str("rdt_cid"), email: str("email"), emailSha256: str("email_sha256"), optOut: e.ads_opt_out === "1" || e.ads_opt_out === true || e.ads_opt_out === 1 });
      }
      accepted++;
    }
    return { ok: true, accepted };
  });

  app.get("/api/admin/billing", async (req, reply) => {
    if (!admin(req, reply)) return;
    const days = Math.min(365, Math.max(1, Number((req.query as { days?: string }).days) || 30));
    return d.funnel.billingSummary(days);
  });
  app.get("/api/admin/billing-log", async (req, reply) => {
    if (!admin(req, reply)) return;
    const q = req.query as { account?: string; limit?: string };
    if (!q.account) return reply.code(400).send({ code: "BAD_REQUEST", message: "account is required" });
    return { account: q.account, events: d.log.forAccount(q.account, Number(q.limit) || 100) };
  });
}
