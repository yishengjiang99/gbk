// Paywall contract (plan approved 2026-11-16: "Approve the paywall plan, drop the landing paywall", "Export is Pro
// only"). One 402 body shape for every paywalled action, shared by the web Studio and the iOS app; documented in
// docs/social-api.md ("Paywall"). Free with no limit: composing, playback, saving, sharing to Social and the
// daily Studio AI budget. Pro only: exporting/downloading a song (audio or MIDI).
//
//   POST /api/paywall/check  { "action": "export", "kind": "midi" | "wav" }   -> 200 { ok: true, pro: true } | 402
//                            { "action": "ai" }                               -> 200 | 402 ai_budget  | 401 signed out
//                            { "action": "render" }                           -> 200 | 402 render_limit | 401 signed out
//
// The browser builds MIDI/WAV files locally, so the Studio asks this endpoint before it produces a download; the
// server-held download (GET /api/mcp/artifacts/:id?download=1) answers the same 402 itself.
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Config } from "../config.ts";
import type { SessionStore } from "../security/authentication.ts";
import { RateLimiter } from "../security/rate-limit.ts";
import { currentSession } from "./agent.ts";
import type { PaywallReason } from "../persistence/usage.ts";

/** Hard-block error codes, one per hard reason. `third_song` is never a 402 (it is a dismissible popup). */
export const PAYWALL_CODES = { export: "PRO_REQUIRED", ai_budget: "AI_BUDGET_EXHAUSTED", render_limit: "RENDER_LIMIT_REACHED" } as const;
export type HardPaywallReason = keyof typeof PAYWALL_CODES;
export const PAYWALL_DEFAULT_PLAN = "pro_yearly";
export const PAYWALL_TRIAL_DAYS = 7;
const MESSAGES: Record<HardPaywallReason, string> = {
  export: "Exporting songs (audio or MIDI) is a GBK Pro feature. Start the 7-day free trial to export.",
  ai_budget: "Today's free AI budget is used up. Pro multiplies the daily AI budget by 10.",
  render_limit: "Today's free render limit is reached. Pro gets 120 renders an hour, up to 10 minutes each.",
};

export interface PaywallBody {
  code: (typeof PAYWALL_CODES)[HardPaywallReason]; reason: HardPaywallReason; message: string; signed_in: boolean;
  paywall: { reason: PaywallReason; hard: true; default_plan: string; trial_days: number; pricing_url: string };
}

/** The 402 body. Stable contract: add fields, never rename or remove them. */
export function paywallBody(origin: string, reason: HardPaywallReason, signedIn: boolean): PaywallBody {
  return { code: PAYWALL_CODES[reason], reason, message: MESSAGES[reason], signed_in: signedIn,
    paywall: { reason, hard: true, default_plan: PAYWALL_DEFAULT_PLAN, trial_days: PAYWALL_TRIAL_DAYS,
      pricing_url: `${origin}/pricing?plan=${PAYWALL_DEFAULT_PLAN}&reason=${reason}` } };
}
export function sendPaywall(reply: FastifyReply, origin: string, reason: HardPaywallReason, signedIn: boolean) {
  return reply.code(402).header("cache-control", "no-store").send(paywallBody(origin, reason, signedIn));
}

export function paywallRoutes(app: FastifyInstance, cfg: Config, sessions: SessionStore, d: {
  pro: (user: string) => boolean; refresh?: (user: string) => Promise<unknown>;
  aiLimit: (user: string) => boolean; renderLimit: (user: string) => boolean;
}) {
  const lim = new RateLimiter(120);
  app.post("/api/paywall/check", { bodyLimit: 2048 }, async (req, reply) => {
    const s = currentSession(req, sessions);
    if (!lim.take(s?.user ?? `ip:${req.ip}`)) return reply.code(429).send({ code: "RATE_LIMITED", message: "slow down" });
    const b = (req.body ?? {}) as { action?: unknown; kind?: unknown };
    const action = b.action;
    if (action !== "export" && action !== "ai" && action !== "render") return reply.code(422).send({ code: "INVALID_ARGUMENT", message: "action is export, ai or render" });
    if (action === "export" && b.kind !== undefined && b.kind !== "midi" && b.kind !== "wav") return reply.code(422).send({ code: "INVALID_ARGUMENT", message: "kind is midi or wav" });
    reply.header("cache-control", "no-store");
    if (s) { try { await d.refresh?.(s.user); } catch { /* entitlement cache stays as is */ } }
    const pro = !!s && d.pro(s.user);
    if (action === "export") return pro ? { ok: true, pro: true } : sendPaywall(reply, cfg.publicOrigin, "export", !!s);
    if (!s) return reply.code(401).send({ code: "UNAUTHENTICATED", message: "sign in first" });
    if (pro) return { ok: true, pro: true };
    if (action === "ai" && d.aiLimit(s.user)) return sendPaywall(reply, cfg.publicOrigin, "ai_budget", true);
    if (action === "render" && d.renderLimit(s.user)) return sendPaywall(reply, cfg.publicOrigin, "render_limit", true);
    return { ok: true, pro: false };
  });
}
