// POST /api/client-errors: anonymous browser error ingest (same-origin only, size-capped, rate-limited per IP and
// per user, scrubbed of credentials). GET /api/admin/client-errors: owner-only read (COMPOSER_ADMIN_USERS).
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import type { SessionStore } from "../security/authentication.ts";
import { RateLimiter } from "../security/rate-limit.ts";
import type { ClientErrorInput, ClientErrorStore } from "../persistence/client-errors.ts";
import { scrub, cleanUrl } from "../../../src/telemetry/error-reporter.ts";
import { currentSession } from "./agent.ts";

export const CLIENT_ERROR_LIMITS = { bodyBytes: 32 * 1024, batch: 10, message: 1000, stack: 6000, url: 500, ua: 300, release: 64, context: 2000, crumbs: 3000 };
const KINDS = new Set(["error", "unhandledrejection", "console", "report"]);
const str = (v: unknown, n: number) => (typeof v === "string" ? scrub(v).slice(0, n) : "");
const json = (v: unknown, n: number, d: string) => { try { const j = scrub(JSON.stringify(v ?? JSON.parse(d))); return j.length > n ? JSON.stringify({ truncated: j.slice(0, n - 40) }) : j; } catch { return d; } };

export function sanitizeClientErrors(body: unknown, user: string | null): ClientErrorInput[] {
  let b = body; if (typeof b === "string") { try { b = JSON.parse(b); } catch { return []; } }
  const list = (b as { errors?: unknown })?.errors; if (!Array.isArray(list)) return [];
  return list.slice(0, CLIENT_ERROR_LIMITS.batch).filter((e) => e && typeof e === "object").map((e: Record<string, unknown>) => ({
    client_ts: Number.isFinite(e.ts) ? Math.trunc(e.ts as number) : null, user_id: user,
    kind: KINDS.has(e.kind as string) ? (e.kind as string) : "report",
    message: str(e.message, CLIENT_ERROR_LIMITS.message) || "(no message)", stack: str(e.stack, CLIENT_ERROR_LIMITS.stack),
    url: typeof e.url === "string" ? cleanUrl(e.url).slice(0, CLIENT_ERROR_LIMITS.url) : "", user_agent: str(e.userAgent, CLIENT_ERROR_LIMITS.ua),
    release: str(e.release, CLIENT_ERROR_LIMITS.release), count: Math.min(10_000, Math.max(1, Math.trunc(Number(e.count) || 1))),
    context: json(e.context && typeof e.context === "object" ? e.context : {}, CLIENT_ERROR_LIMITS.context, "{}"),
    breadcrumbs: json(Array.isArray(e.breadcrumbs) ? e.breadcrumbs.slice(-20).map((c) => String(c).slice(0, 160)) : [], CLIENT_ERROR_LIMITS.crumbs, "[]"),
  }));
}

export function clientErrorRoutes(app: FastifyInstance, cfg: Config, sessions: SessionStore, store: ClientErrorStore, o: { perIpPerMinute?: number; perUserPerMinute?: number } = {}) {
  const ipLimit = new RateLimiter(o.perIpPerMinute ?? 20), userLimit = new RateLimiter(o.perUserPerMinute ?? 20);
  app.post("/api/client-errors", { bodyLimit: CLIENT_ERROR_LIMITS.bodyBytes }, async (req, reply) => {
    // No auth (errors before sign-in matter), but reports must come from our own pages.
    const origin = req.headers.origin;
    if (origin && !cfg.allowedOrigins.includes(origin.replace(/\/$/, ""))) return reply.code(403).send({ code: "BAD_ORIGIN", message: "cross-origin request rejected" });
    if (!origin && req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") return reply.code(403).send({ code: "BAD_ORIGIN", message: "cross-site request rejected" });
    const user = currentSession(req, sessions)?.user ?? null;
    if (!ipLimit.take(req.ip) || (user && !userLimit.take(user))) return reply.code(429).send({ code: "RATE_LIMITED", message: "too many error reports" });
    const rows = sanitizeClientErrors(req.body, user);
    if (!rows.length) return reply.code(400).send({ code: "BAD_REQUEST", message: "expected {errors:[...]}" });
    store.insert(rows);
    return reply.code(202).send({ ok: true, accepted: rows.length });
  });
  app.get("/api/admin/client-errors", async (req, reply) => {
    const s = currentSession(req, sessions);
    if (!s) return reply.code(401).send({ code: "UNAUTHENTICATED", message: "log in" });
    if (!cfg.adminUsers.includes(s.user)) return reply.code(403).send({ code: "FORBIDDEN", message: "admin only" });
    const q = req.query as { limit?: string; since?: string; user?: string; kind?: string; release?: string };
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const sinceMs = q.since ? (/^\d+$/.test(q.since) ? Number(q.since) : Date.parse(q.since)) || undefined : undefined;
    const rows = store.list({ limit, sinceMs, user: q.user, kind: q.kind, release: q.release });
    return { total: store.count(), errors: rows.map((r) => ({ ...r, createdAt: new Date(r.created_at).toISOString(), context: JSON.parse(r.context), breadcrumbs: JSON.parse(r.breadcrumbs) })) };
  });
}
