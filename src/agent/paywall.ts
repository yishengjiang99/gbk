// Web Studio paywall (#116): the modal is driven entirely by GET /api/me's `paywall` block (#115) — the server
// owns eligibility, reasons and the 24 h dismiss cooldown; this module is the client plumbing: surface
// suppression (iOS app / ChatGPT widget), the engagement event channel (#115/#118 taxonomy), the /pricing link
// carrying the stored attribution ids (#131), and the plan display data (mirrors server/src/routes/pricing.ts).
import { inNativeApp } from "./native-guest.ts";
import { social, type MePaywall, type PaywallReason } from "./social-client.ts";

export type { MePaywall, PaywallReason };
export const PAYWALL_SURFACE = "studio";
export const PAYWALL_PLATFORM = "web";

/** Plan ids are the /pricing PLANS ids; prices/notes mirror that page (display only — checkout owns amounts). */
export interface PaywallPlan { id: string; name: string; price: string; per: string; note: string; trial: boolean }
export const PAYWALL_PLANS: PaywallPlan[] = [
  { id: "pro_yearly", name: "Pro yearly", price: "$47.99", per: "/year", note: "$4/month billed yearly · save 33% vs monthly", trial: true },
  { id: "pro_monthly", name: "Pro monthly", price: "$5.99", per: "/month", note: "Cancel anytime", trial: true },
  { id: "lifetime", name: "Pro lifetime", price: "$99", per: "", note: "One payment, no subscription", trial: false },
];
export const DEFAULT_PLAN = "pro_yearly";

export const isHardReason = (r: PaywallReason | null | undefined) => r === "ai_limit" || r === "render_limit";
/** Agent budget failures (server/src/agent/limits.ts BudgetError codes) are the hard-gate signal. */
export const isBudgetError = (code: string | null | undefined) => !!code && /BUDGET_EXHAUSTED$/.test(code);

/** Budgets reset at 00:00 UTC; label that moment in Pacific time (mirror of resetTimePT in server limits.ts). */
export function resetLabel(now: number = Date.now()): string {
  const next = Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000;
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric" }).format(next).replace(/\s+/g, " ") + " PT";
}

// ---- surface suppression -------------------------------------------------

/** The ChatGPT / MCP Apps host injects window.openai; the Studio must never sell there (native sheet instead). */
export function inChatGptWidget(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { openai?: unknown };
  return typeof w.openai === "object" && w.openai !== null;
}

/** No web paywall inside the iOS app (its WebView intercepts /pricing and opens the native paywall) or ChatGPT. */
export function paywallSuppressed(): boolean {
  if (typeof window === "undefined") return true;
  return inNativeApp() || inChatGptWidget();
}

// ---- attribution (#131) ----------------------------------------------------

/** Keys captured first-touch by public/attribution.js into gbk_* cookies (sessionStorage mirrors them). */
export const ATTRIBUTION_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "twclid", "rdt_cid"] as const;

/** Pure: read the stored attribution ids out of a cookie string + a session-storage getter. */
export function readAttribution(cookie: string, sessionGet: (k: string) => string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ATTRIBUTION_KEYS) {
    const m = cookie.match(new RegExp(`(?:^|; )gbk_${k}=([^;]*)`));
    let v: string | null = null;
    if (m) { try { v = decodeURIComponent(m[1]); } catch { v = m[1]; } }
    if (!v) { try { v = sessionGet(`gbk_${k}`); } catch { v = null; } }
    if (v) out[k] = v.slice(0, 200);
  }
  return out;
}

/** Pure: the /pricing URL for a plan, carrying the stored attribution ids so checkout keeps the ad credit. */
export function buildPricingHref(plan: string, stored: Record<string, string>): string {
  const p = new URLSearchParams();
  p.set("plan", plan);
  for (const k of ATTRIBUTION_KEYS) if (stored[k]) p.set(k, stored[k]);
  return `/pricing?${p.toString()}`;
}

/** Live: href for the modal CTA in this page (cookies first, sessionStorage mirror second). */
export function pricingHref(plan: string): string {
  let cookie = ""; let get: (k: string) => string | null = () => null;
  try { cookie = document.cookie; } catch { /* storage blocked */ }
  try { get = (k) => sessionStorage.getItem(k); } catch { /* storage blocked */ }
  return buildPricingHref(plan, readAttribution(cookie, get));
}

// ---- /api/me + engagement channel ------------------------------------------

/** Fresh paywall state from /api/me. Null when signed out / no session / server unreachable. */
export async function fetchPaywall(): Promise<{ pro: boolean; paywall: MePaywall } | null> {
  const me = await social.me().catch(() => null);
  if (!me?.paywall) return null;
  return { pro: !!me.pro, paywall: me.paywall };
}

/** Fire a billing-taxonomy event through POST /api/me/engagement (#115 channel, #118 names/fields).
 *  Best effort: resolves to the server's fresh {usage, paywall} or null; never throws. */
export function reportPaywall(event: "paywall_view" | "paywall_dismiss" | "plan_select", reason: PaywallReason | null, plan?: string) {
  return social.engagement(event, { surface: PAYWALL_SURFACE, platform: PAYWALL_PLATFORM, ...(reason ? { reason } : {}), ...(plan ? { plan } : {}) });
}

/** Report a client-side Studio WAV/MIDI export (#115 counts these toward the export_after_2 trigger). */
export function reportExport() {
  return social.engagement("export", { surface: PAYWALL_SURFACE, platform: PAYWALL_PLATFORM });
}
