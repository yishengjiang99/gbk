// GET /api/admin/telemetry?days=30: one read-only owner snapshot (feed metrics, funnel, billing + recent billing log,
// recent client errors, open reports) for the photo.grepawk.com admin, fetched server-to-server. Auth: an admin session
// (COMPOSER_ADMIN_USERS) or header x-gbk-admin-read = GBK_ADMIN_READ_TOKEN (constant-time). GET only: the token grants
// no other route. Each section fails alone ({ error }) so one broken store never blanks the rest.
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import type { SessionStore } from "../security/authentication.ts";
import type { EventStore } from "../persistence/events.ts";
import type { FunnelStore } from "../persistence/funnel.ts";
import type { BillingLog } from "../persistence/billing.ts";
import type { ClientErrorStore } from "../persistence/client-errors.ts";
import type { SocialStore } from "../persistence/social.ts";
import { currentSession } from "./agent.ts";

const tokenOk = (want: string, given: unknown) => {
  if (!want || typeof given !== "string" || given.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(want));
};
const safe = <T>(f: () => T): T | { error: string } => { try { return f(); } catch (e) { return { error: (e as Error).message || "failed" }; } };

export function adminReadRoutes(app: FastifyInstance, cfg: Config, sessions: SessionStore,
  d: { events: EventStore; funnel: FunnelStore; billingLog: BillingLog; clientErrors: ClientErrorStore; social: SocialStore }) {
  const authed = (req: FastifyRequest) => {
    if (tokenOk(cfg.adminReadToken ?? "", req.headers["x-gbk-admin-read"])) return 200;
    const s = currentSession(req, sessions); return !s ? 401 : cfg.adminUsers.includes(s.user) ? 200 : 403;
  };
  app.get("/api/admin/telemetry", async (req, reply) => {
    const code = authed(req);
    if (code !== 200) return reply.code(code).send({ code: code === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", message: "admin only" });
    reply.header("cache-control", "no-store");
    const days = Math.min(90, Math.max(1, Number((req.query as { days?: string }).days) || 30)), now = Date.now();
    return {
      generatedAt: new Date(now).toISOString(), days,
      metrics: safe(() => ({ days: Math.min(days, 7), ...d.events.metrics(now - Math.min(days, 7) * 86_400_000) })),
      funnel: safe(() => d.funnel.summary(days)),
      billing: safe(() => d.funnel.billingSummary(days)),
      billingLog: safe(() => d.billingLog.recent(25)),
      clientErrors: safe(() => ({ total: d.clientErrors.count(), errors: d.clientErrors.list({ limit: 25 }).map((r) => ({ id: r.id, createdAt: new Date(r.created_at).toISOString(), kind: r.kind, message: r.message, url: r.url, release: r.release, count: r.count, user: r.user_id })) })),
      reports: safe(() => d.social.reports({ status: "open", limit: 25 }).rows.map((x) => ({ id: x.id, kind: x.kind, target: x.target_id, reason: x.reason, created_at: x.created_at }))),
    };
  });
}
