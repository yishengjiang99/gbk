// Funnel analytics endpoints. POST /api/funnel: anonymous aggregate beacon for events only a browser sees
// (site landing view; audio finished rendering in the in-chat player or a Studio tab). Accepts nothing but an
// allow-listed event + source, stores only a daily count, and never logs or stores the IP (the per-IP limiter
// is in memory). GET /api/admin/funnel: owner-only summary (COMPOSER_ADMIN_USERS).
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import type { SessionStore } from "../security/authentication.ts";
import { RateLimiter } from "../security/rate-limit.ts";
import type { FunnelSource, FunnelStore } from "../persistence/funnel.ts";
import { currentSession } from "./agent.ts";

const BEACON: Record<string, FunnelSource[]> = { page_view_landing: ["web"], browser_render_completed: ["widget", "studio"] };

export function funnelRoutes(app: FastifyInstance, cfg: Config, sessions: SessionStore, funnel: FunnelStore) {
  const limiter = new RateLimiter(30);
  app.route({ method: ["POST", "OPTIONS"], url: "/api/funnel", bodyLimit: 512, handler: async (req, reply) => {
    // The ChatGPT widget runs in a sandboxed origin; the beacon carries no credentials, so any origin is fine.
    reply.header("access-control-allow-origin", "*").header("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") return reply.code(204).send();
    if (!limiter.take(req.ip)) return reply.code(429).send({ code: "RATE_LIMITED", message: "slow down" });
    const b = (req.body ?? {}) as { event?: unknown; source?: unknown };
    const allowed = typeof b.event === "string" ? BEACON[b.event] : undefined;
    if (!allowed || !allowed.includes(b.source as FunnelSource)) return reply.code(400).send({ code: "BAD_REQUEST", message: "unknown event" });
    funnel.bump(b.event as "page_view_landing", b.source as FunnelSource);
    return reply.code(204).send();
  } });
  app.get("/api/admin/funnel", async (req, reply) => {
    const s = currentSession(req, sessions);
    if (!s) return reply.code(401).send({ code: "UNAUTHENTICATED", message: "log in" });
    if (!cfg.adminUsers.includes(s.user)) return reply.code(403).send({ code: "FORBIDDEN", message: "admin only" });
    const days = Math.min(365, Math.max(1, Number((req.query as { days?: string }).days) || 30));
    return funnel.summary(days);
  });
}
