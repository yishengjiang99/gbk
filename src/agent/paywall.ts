// Web Studio paywall (plan approved 2026-11-16; no landing paywall). Triggers: export/download is Pro only (hard,
// enforced by the server's POST /api/paywall/check 402), the free AI budget or render limit (hard, from GET /api/me's
// `paywall` block), and starting a 3rd composition (a soft popup shown once; remembered per account on the server
// and in localStorage for guests). This module is the client plumbing: surface suppression (iOS app / ChatGPT
// widget), the export gate, the 3rd-song decision, the engagement event channel (#115/#118 taxonomy), the /pricing
// link carrying the stored attribution ids (#131), and the plan display data (mirrors server/src/routes/pricing.ts).
import { inNativeApp } from "./native-guest.ts";
import { apiBase } from "./bridge-client.ts";
import { social, type MePaywall, type PaywallReason } from "./social-client.ts";

export type { MePaywall, PaywallReason };
export const PAYWALL_SURFACE = "studio";
export const PAYWALL_PLATFORM = "web";

/** Plan ids are the /pricing PLANS ids; prices/notes mirror that page (display only — checkout owns amounts). */
export interface PaywallPlan { id: string; name: string; price: string; per: string; note: string; trial: boolean }
export const PAYWALL_PLANS: PaywallPlan[] = [
  { id: "pro_yearly", name: "Pro yearly", price: "$47.99", per: "/year", note: "7-day free trial, then $4/month billed yearly · save 33% vs monthly", trial: true },
  { id: "pro_monthly", name: "Pro monthly", price: "$5.99", per: "/month", note: "Cancel anytime", trial: true },
  { id: "lifetime", name: "Pro lifetime", price: "$99.99", per: "", note: "One payment, no subscription", trial: false },
];
export const DEFAULT_PLAN = "pro_yearly";

export const PAYWALL_REASONS: readonly PaywallReason[] = ["export", "ai_budget", "render_limit", "third_song"];
export const isHardReason = (r: PaywallReason | null | undefined) => r === "export" || r === "ai_budget" || r === "render_limit";
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

/** Pure: the /pricing URL for a plan, carrying the stored attribution ids so checkout keeps the ad credit, and the
 *  paywall reason (the iOS app's WebView intercepts /pricing and can tag its native paywall with it). */
export function buildPricingHref(plan: string, stored: Record<string, string>, reason?: PaywallReason | null): string {
  const p = new URLSearchParams();
  p.set("plan", plan);
  if (reason) p.set("reason", reason);
  for (const k of ATTRIBUTION_KEYS) if (stored[k]) p.set(k, stored[k]);
  return `/pricing?${p.toString()}`;
}

/** Live: href for the modal CTA in this page (cookies first, sessionStorage mirror second). */
export function pricingHref(plan: string, reason?: PaywallReason | null): string {
  let cookie = ""; let get: (k: string) => string | null = () => null;
  try { cookie = document.cookie; } catch { /* storage blocked */ }
  try { get = (k) => sessionStorage.getItem(k); } catch { /* storage blocked */ }
  return buildPricingHref(plan, readAttribution(cookie, get), reason);
}

// ---- triggers --------------------------------------------------------------------

/** Ask the app shell's PaywallHost to present the paywall for a reason (it applies suppression and Pro checks). */
export function requestPaywall(reason: PaywallReason) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("gbk:paywall", { detail: { reason } }));
}

export type ExportKind = "midi" | "wav";
export type ExportCheck = "allowed" | "blocked" | "error";
/** Pure: classify the POST /api/paywall/check answer. 402 = not Pro; a 2xx JSON answer = Pro; a non-JSON answer means
 *  there is no Composer server (the static GitHub Pages build), where nothing is sold and exports stay open. */
export function classifyExportCheck(status: number, contentType: string | null): ExportCheck {
  if (status === 402) return "blocked";
  const json = (contentType ?? "").includes("json");
  if (!json) return "allowed";
  return status >= 200 && status < 300 ? "allowed" : "error";
}
/** Server-side export gate: export/download of a song (audio or MIDI) is Pro only. Never throws. */
export async function checkExport(kind: ExportKind): Promise<ExportCheck> {
  // Headless runtimes (Node tests, workers) have no page and no user to sell to; the server-held downloads keep
  // their own 402 regardless.
  if (typeof document === "undefined" || typeof location === "undefined") return "allowed";
  try {
    const r = await fetch(`${apiBase()}/paywall/check`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "export", kind }) });
    const verdict = classifyExportCheck(r.status, r.headers.get("content-type"));
    await r.text().catch(() => ""); // drain the body so the connection is released (and devtools/tests see a complete response)
    return verdict;
  } catch { return "error"; }
}
/** Gate an export action: true = go ahead (Pro, or no Composer server). A non-Pro user gets the export paywall
 *  (hard block, nothing is downloaded); a failed check blocks too, with a retry message. */
export async function requireExport(kind: ExportKind): Promise<boolean> {
  const r = await checkExport(kind);
  if (r === "allowed") return true;
  if (r === "blocked") requestPaywall("export");
  else window.alert("Couldn't check your GBK Pro status. Check your connection and try again.");
  return false;
}

/** Guests (and every browser, as a fast path) remember the one-time 3rd-song popup here. */
export const THIRD_SONG_KEY = "gbk.paywall.thirdSong.v1";
export function thirdSongSeenLocally(): boolean { try { return !!localStorage.getItem(THIRD_SONG_KEY); } catch { return false; } }
export function markThirdSongLocally() { try { localStorage.setItem(THIRD_SONG_KEY, String(Date.now())); } catch { /* storage blocked */ } }
/** Pure: show the 3rd-song popup when a free user starts a new song while already having 2+ songs, once ever. */
export function shouldShowThirdSong(o: { pro: boolean; seen: boolean; existingSongs: number }): boolean {
  return !o.pro && !o.seen && o.existingSongs >= 2;
}
/** The user's songs with content: local projects (IndexedDB) plus, when signed in, the server's song list, deduped. */
export async function countExistingSongs(): Promise<number> {
  const ids = new Set<string>(); let extra = 0;
  try {
    const { midiFileStore } = await import("../midi-file-store.ts");
    for (const r of await midiFileStore.listProjects()) {
      const p = r.project as { notes?: unknown[]; meta?: { owner?: string } } | undefined;
      if (p?.notes?.length && r.id) ids.add(r.id);
    }
  } catch { /* storage unavailable */ }
  try {
    const { listShares } = await import("./share-client.ts");
    const list = await listShares(0, 100, true) as { projectId?: string | null; slug?: string }[];
    for (const s of list) { if (s.projectId) ids.add(s.projectId); else extra++; }
  } catch { /* signed out / offline */ }
  return ids.size + extra;
}
/** Called when the user starts a new composition (after the blank project is in place). */
export async function maybeThirdSongPaywall(): Promise<boolean> {
  if (thirdSongSeenLocally()) return false;
  const st = await fetchPaywall().catch(() => null);
  if (st?.paywall.third_song_seen) { markThirdSongLocally(); return false; }
  const show = shouldShowThirdSong({ pro: !!st?.pro, seen: false, existingSongs: await countExistingSongs() });
  if (show) requestPaywall("third_song");
  return show;
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
export async function reportPaywall(event: "paywall_view" | "paywall_dismiss" | "plan_select", reason: PaywallReason | null, plan?: string) {
  const dims = { surface: PAYWALL_SURFACE, platform: PAYWALL_PLATFORM, ...(reason ? { reason } : {}), ...(plan ? { plan } : {}) };
  const r = await social.engagement(event, dims);
  if (r) return r;
  // Signed out (engagement needs an account): the anonymous billing door still logs the event and its reason.
  try { await fetch(`${apiBase()}/billing/events`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ event, ...dims }) }); } catch { /* best effort */ }
  return null;
}

/** Report a client-side Studio WAV/MIDI export (a Pro user's; #115 usage counter + #118 export event). */
export function reportExport() {
  return social.engagement("export", { surface: PAYWALL_SURFACE, platform: PAYWALL_PLATFORM });
}

// ---- publish prompt coordination ----------------------------------------------

/** The Studio's post-run Publish prompt and this paywall both react to a finished run, uncoordinated:
 *  the prompt opens as soon as the song is saved while the paywall is still deciding via /api/me, and the
 *  modal then lands on top of the dialog (seen in the 2026-10-26 production click-through). This gate
 *  serializes them — the paywall wins: a publish offer made while a paywall decision is in flight or a
 *  paywall is visible is held (latest offer wins) and released when the paywall closes; when the decision
 *  ends with no paywall shown, the offer is released at once. With no paywall activity it is a pass-through,
 *  so a publish prompt with no paywall due behaves exactly as before. */
export class PublishPromptGate {
  private deciding = 0;
  private visible = false;
  private queued: (() => void) | null = null;

  offerPublish(open: () => void): void {
    if (this.visible || this.deciding > 0) { this.queued = open; return; }
    open();
  }
  beginDecision(): void { this.deciding++; }
  endDecision(): void { if (this.deciding > 0) this.deciding--; this.flush(); }
  notePaywallShown(): void { this.visible = true; }
  notePaywallClosed(): void { this.visible = false; this.flush(); }
  private flush(): void {
    if (this.visible || this.deciding > 0) return;
    const open = this.queued; this.queued = null;
    open?.();
  }
}

export const publishPromptGate = new PublishPromptGate();
