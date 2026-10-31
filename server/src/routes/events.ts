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
import { billingPlanOf, type BillingRecorder } from "../persistence/billing.ts";
import type { BillingEvent } from "../persistence/funnel.ts";
import { currentSession } from "./agent.ts";

const GID = "gbk_gid"; const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Native scan telemetry (#166): the iOS app posts scan_started / scan_completed / scan_failed
// diagnostics in the same batch shape as impressions (metadata only — source, durations,
// per-stage timings, model backend, staff/system/token counts, notes produced, failure reason
// codes; never image data or user content). Like the billing bridge below, these rows are not
// impressions: the route forwards them to the injected recorder (server-side structured log)
// and counts them as accepted.
export interface ScanRecorder { record(event: string, fields: Record<string, string | number>): void }
const SCAN_EVENTS = new Set(["scan_started", "scan_completed", "scan_failed"]);
const SCAN_STRING_FIELDS: Record<string, number> = { source: 32, stages: 512, backend: 128, reason: 64 };
const SCAN_NUMBER_FIELDS = ["pages", "image_w", "image_h", "duration_ms", "staff_count", "system_count", "raw_tokens", "filtered_tokens", "note_count", "midi_bytes", "warnings"] as const;
export function sanitizeScanEvent(e: Record<string, unknown>): { event: string; fields: Record<string, string | number> } | null {
  if (typeof e.event !== "string" || !SCAN_EVENTS.has(e.event)) return null;
  const fields: Record<string, string | number> = {};
  for (const [k, cap] of Object.entries(SCAN_STRING_FIELDS)) if (typeof e[k] === "string") fields[k] = (e[k] as string).slice(0, cap);
  for (const k of SCAN_NUMBER_FIELDS) { const n = Number(e[k]); if (Number.isFinite(n)) fields[k] = Math.min(1e9, Math.max(0, Math.round(n))); }
  return { event: e.event, fields };
}

export function eventRoutes(app: FastifyInstance, cfg: Config, sessions: SessionStore, shares: ShareStore, events: EventStore, admins: string[], billing?: BillingRecorder, scan?: ScanRecorder) {
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
    let bridged = 0;
    for (const e of list as Record<string, unknown>[]) {
      if (!e || typeof e !== "object") continue;
      // #166 bridge: native scan telemetry events (see sanitizeScanEvent) are diagnostics,
      // not impressions — forward them to the scan recorder (server-side structured log).
      if (scan) {
        const s = sanitizeScanEvent(e);
        if (s) { scan.record(s.event, s.fields); bridged++; continue; }
      }
      // #118 bridge: the iOS app posts its paywall/StoreKit funnel events (#119) to this endpoint in the
      // same batch shape as impressions. A row carrying a billing event name is not an impression —
      // forward it to the billing recorder instead of dropping it for lacking a song slug.
      // iap_purchase_start counts as the funnel's checkout_start; iap_purchase_result is deliberately
      // NOT forwarded (purchase truth comes from ASSN, never from the client).
      if (billing && typeof e.event === "string" && e.event !== "iap_purchase_result") {
        const name = e.event === "iap_purchase_start" ? "checkout_start" : e.event;
        if (name === "paywall_view" || name === "paywall_dismiss" || name === "plan_select" || name === "checkout_start" || name === "restore") {
          billing.record(name as BillingEvent, {
            account: s?.user ?? null,
            surface: client === "ios" ? "ios" : "studio", platform: client,
            plan: typeof e.plan === "string" ? billingPlanOf(e.plan) : undefined,
            reason: typeof e.reason === "string" ? e.reason : undefined,
            result: typeof e.result === "string" ? e.result : undefined,
            provider: name === "restore" && client === "ios" ? "apple" : undefined,
          });
          bridged++;
          continue;
        }
      }
      const r = typeof e.song === "string" ? shares.bySlug(e.song) : null; if (!r || !r.public) continue;
      const dwell = Math.round(num(e.dwell_ms, 0, 3_600_000));
      rows.push({ actor, session, share_id: r.id, dwell_ms: dwell, listen_ratio: num(e.listen_ratio, 0, 50), completed: !!e.completed, fast_skip: e.fast_skip === undefined ? dwell < 2000 : !!e.fast_skip,
        replay: !!e.replay, actions: (Array.isArray(e.actions) ? e.actions : []).map(String).filter((a) => (ACTIONS as readonly string[]).includes(a)).slice(0, MAX_ACTIONS),
        position: Math.round(num(e.position, 0, 100000)), feed: typeof e.feed === "string" ? e.feed.slice(0, 32) : "for_you",
        model_version: typeof e.model_version === "string" ? e.model_version.slice(0, 32) : "unknown", client, ts: Math.round(num(e.ts, 0, 9e15)),
        scroll_v: e.scroll_v === undefined || e.scroll_v === null || !Number.isFinite(Number(e.scroll_v)) ? null : Math.round(num(e.scroll_v, 0, MAX_SCROLL_V)) });
    }
    events.insert(rows);
    return { ok: true, accepted: rows.length + bridged };
  });
  app.get("/api/admin/metrics", async (req, reply) => {
    const s = currentSession(req, sessions); if (!s || !admins.includes(s.user)) return reply.code(s ? 403 : 401).send({ code: s ? "FORBIDDEN" : "UNAUTHENTICATED", message: "admin only" });
    const days = Math.min(90, Math.max(1, Number((req.query as { days?: string }).days) || 7));
    return { days, ...events.metrics(Date.now() - days * 86_400_000) };
  });
}
