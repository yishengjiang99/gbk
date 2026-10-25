// POST /api/events: batched feed impressions from web (navigator.sendBeacon) and iOS. Contract: docs/social-api.md.
// Actor = signed-in user id, else an anonymous `gbk_gid` cookie (set here), else an `x-gbk-install` header (iOS guests).
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import type { SessionStore } from "../security/authentication.ts";
import { parseCookies } from "../security/authentication.ts";
import { originAllowed } from "../security/authorization.ts";
import { RateLimiter } from "../security/rate-limit.ts";
import type { ShareStore } from "../persistence/shares.ts";
import { ACTIONS, MAX_ACTIONS, MAX_SCROLL_V, type EventStore, type Impression } from "../persistence/events.ts";
import { currentSession } from "./agent.ts";

const GID = "gbk_gid"; const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export function eventRoutes(app: FastifyInstance, cfg: Config, sessions: SessionStore, shares: ShareStore, events: EventStore, admins: string[]) {
  const lim = new RateLimiter(30); const ipLim = new RateLimiter(120);
  app.post("/api/events", { bodyLimit: 65536 }, async (req, reply) => {
    const s = currentSession(req, sessions); const bearer = /^Bearer /i.test(String(req.headers.authorization ?? ""));
    // Browsers always send Origin on POST; native apps (no Origin) are allowed and identify with x-gbk-install.
    if (!bearer && req.headers.origin !== undefined && !originAllowed(cfg, req.headers.origin)) return reply.code(403).send({ code: "BAD_ORIGIN", message: "cross-origin request rejected" });
    let actor = s?.user ?? null;
    if (!actor) {
      const c = parseCookies(req.headers.cookie)[GID]; const h = String(req.headers["x-gbk-install"] ?? "");
      if (c && ID_RE.test(c)) actor = `gid:${c}`; else if (ID_RE.test(h)) actor = `inst:${h}`;
      else { const g = randomBytes(16).toString("base64url"); actor = `gid:${g}`; reply.header("set-cookie", `${GID}=${g}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${cfg.publicOrigin.startsWith("https") ? "; Secure" : ""}`); }
    }
    if (!lim.take(actor) || !ipLim.take(req.ip)) return reply.code(429).send({ code: "RATE_LIMITED", message: "slow down" });
    const b = (req.body ?? {}) as { events?: unknown; session?: unknown; client?: unknown };
    const list = Array.isArray(b.events) ? b.events.slice(0, 50) : [];
    const session = typeof b.session === "string" && ID_RE.test(b.session) ? b.session : "none";
    const client = b.client === "ios" ? "ios" : "web";
    const num = (v: unknown, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo; };
    const rows: Impression[] = [];
    for (const e of list as Record<string, unknown>[]) {
      if (!e || typeof e !== "object") continue;
      const r = typeof e.song === "string" ? shares.bySlug(e.song) : null; if (!r || !r.public) continue;
      const dwell = Math.round(num(e.dwell_ms, 0, 3_600_000));
      rows.push({ actor, session, share_id: r.id, dwell_ms: dwell, listen_ratio: num(e.listen_ratio, 0, 50), completed: !!e.completed, fast_skip: e.fast_skip === undefined ? dwell < 2000 : !!e.fast_skip,
        replay: !!e.replay, actions: (Array.isArray(e.actions) ? e.actions : []).map(String).filter((a) => (ACTIONS as readonly string[]).includes(a)).slice(0, MAX_ACTIONS),
        position: Math.round(num(e.position, 0, 100000)), feed: typeof e.feed === "string" ? e.feed.slice(0, 32) : "for_you",
        model_version: typeof e.model_version === "string" ? e.model_version.slice(0, 32) : "unknown", client, ts: Math.round(num(e.ts, 0, 9e15)),
        scroll_v: e.scroll_v === undefined || e.scroll_v === null || !Number.isFinite(Number(e.scroll_v)) ? null : Math.round(num(e.scroll_v, 0, MAX_SCROLL_V)) });
    }
    events.insert(rows);
    return { ok: true, accepted: rows.length };
  });
  app.get("/api/admin/metrics", async (req, reply) => {
    const s = currentSession(req, sessions); if (!s || !admins.includes(s.user)) return reply.code(s ? 403 : 401).send({ code: s ? "FORBIDDEN" : "UNAUTHENTICATED", message: "admin only" });
    const days = Math.min(90, Math.max(1, Number((req.query as { days?: string }).days) || 7));
    return { days, ...events.metrics(Date.now() - days * 86_400_000) };
  });
}
