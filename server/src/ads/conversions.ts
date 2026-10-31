// Server-side ad conversions (#130): X Conversions API + Reddit Conversions API v3, fired from the finalcut
// billing hop (POST /api/billing/stripe-events) for `purchase` and `trial_start`. The browser pixels on
// /pricing/thanks send the same conversion id, so each platform dedupes browser + server into one event.
//
// Off unless configured. Each platform sends only when the master switch is on AND all of its own env is set:
//   COMPOSE_ADS_ENABLED (default 1; 0 = nothing anywhere)
//   X:      COMPOSE_X_PIXEL_ID + COMPOSE_X_EVENT_ID_PURCHASE / COMPOSE_X_EVENT_ID_START_TRIAL (per event)
//           + X_ADS_CONSUMER_KEY, X_ADS_CONSUMER_SECRET, X_ADS_ACCESS_TOKEN, X_ADS_ACCESS_TOKEN_SECRET (OAuth 1.0a)
//   Reddit: COMPOSE_REDDIT_PIXEL_ID + REDDIT_CAPI_TOKEN (Bearer conversion access token)
// With any of it missing there is no request at all (no network, no warning spam: one `ads_capi_off` line at boot).
//
// Privacy: the only identifiers sent are the ad click id (twclid / rdt_cid) and a SHA-256 hash of the
// normalized email (the raw email never leaves this process, is never stored and never logged), plus the
// plan value and the random conversion id. Nothing is sent when the buyer's browser had GPC/DNT on
// (`ads_opt_out=1`, set by public/attribution.js) or when there is neither a click id nor an email.
// Secrets and identifiers never appear in logs: failures log `[ads]` with platform, event and HTTP status only.
import { createHash, createHmac, randomBytes } from "node:crypto";

export type AdsEvent = "purchase" | "trial_start";
export interface AdsConversion {
  event: AdsEvent;
  /** The browser pixels' conversion id (public/attribution.js event_id), for browser+server dedupe. */
  conversionId: string;
  valueCents?: number | null; currency?: string;
  twclid?: string; rdtCid?: string;
  /** Raw email (hashed here) or an already-hashed lowercase SHA-256 hex. */
  email?: string; emailSha256?: string;
  optOut?: boolean;
  at?: number;
}
export interface AdsConfig {
  enabled: boolean;
  x: { pixelId: string; eventPurchase: string; eventTrial: string; consumerKey: string; consumerSecret: string; token: string; tokenSecret: string } | null;
  reddit: { pixelId: string; token: string } | null;
}

const on = (v: string | undefined, dflt: boolean) => (v === undefined || v.trim() === "" ? dflt : !["0", "false", "off", "no"].includes(v.trim().toLowerCase()));
const id = (v: string | undefined) => (/^[A-Za-z0-9_-]{1,64}$/.test((v ?? "").trim()) ? v!.trim() : "");
const secret = (v: string | undefined) => { const s = (v ?? "").trim(); return s.length >= 8 && s.length <= 4096 && !/\s/.test(s) ? s : ""; };

export function adsConfig(env: Record<string, string | undefined> = process.env): AdsConfig {
  const enabled = on(env.COMPOSE_ADS_ENABLED, true);
  const xPixel = id(env.COMPOSE_X_PIXEL_ID), xp = id(env.COMPOSE_X_EVENT_ID_PURCHASE), xt = id(env.COMPOSE_X_EVENT_ID_START_TRIAL);
  const ck = secret(env.X_ADS_CONSUMER_KEY), cs = secret(env.X_ADS_CONSUMER_SECRET), at = secret(env.X_ADS_ACCESS_TOKEN), ats = secret(env.X_ADS_ACCESS_TOKEN_SECRET);
  const rPixel = id(env.COMPOSE_REDDIT_PIXEL_ID), rTok = secret(env.REDDIT_CAPI_TOKEN);
  return {
    enabled,
    x: enabled && xPixel && (xp || xt) && ck && cs && at && ats ? { pixelId: xPixel, eventPurchase: xp, eventTrial: xt, consumerKey: ck, consumerSecret: cs, token: at, tokenSecret: ats } : null,
    reddit: enabled && rPixel && rTok ? { pixelId: rPixel, token: rTok } : null,
  };
}

/** Normalized (trim + lowercase) email -> SHA-256 hex, as both platforms expect. Already-hashed input passes through. */
export function hashEmail(email: string | undefined, sha?: string): string | undefined {
  if (sha && /^[a-f0-9]{64}$/i.test(sha.trim())) return sha.trim().toLowerCase();
  const e = (email ?? "").trim().toLowerCase();
  if (!e || e.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return undefined;
  return createHash("sha256").update(e).digest("hex");
}
/** X event ids are shown as `tw-<pixel>-<event>`; the API wants the trailing event part. */
export const xEventId = (v: string) => { const m = /^tw-[A-Za-z0-9]+-([A-Za-z0-9]+)$/.exec(v); return m ? m[1] : v; };
const clickId = (v: string | undefined) => { const s = (v ?? "").trim(); return /^[A-Za-z0-9._-]{1,200}$/.test(s) ? s : undefined; };

// ---- OAuth 1.0a (HMAC-SHA1) for the X Ads API -----------------------------------------------------------
const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export function oauth1Header(method: string, url: string, k: { consumerKey: string; consumerSecret: string; token: string; tokenSecret: string }, nonce = randomBytes(16).toString("hex"), ts = Math.floor(Date.now() / 1000)): string {
  const u = new URL(url);
  const params: [string, string][] = [["oauth_consumer_key", k.consumerKey], ["oauth_nonce", nonce], ["oauth_signature_method", "HMAC-SHA1"], ["oauth_timestamp", String(ts)], ["oauth_token", k.token], ["oauth_version", "1.0"]];
  const all = [...params, ...[...u.searchParams]].map(([a, b]) => [pct(a), pct(b)] as const).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  const base = [method.toUpperCase(), pct(`${u.origin}${u.pathname}`), pct(all.map(([a, b]) => `${a}=${b}`).join("&"))].join("&");
  const sig = createHmac("sha1", `${pct(k.consumerSecret)}&${pct(k.tokenSecret)}`).update(base).digest("base64");
  return "OAuth " + [...params, ["oauth_signature", sig]].map(([a, b]) => `${pct(a)}="${pct(b)}"`).join(", ");
}

export const X_API = "https://ads-api.x.com/12/measurement/conversions";
export const REDDIT_API = "https://ads-api.reddit.com/api/v3/pixels";

export class AdsConversions {
  constructor(private cfg: AdsConfig, private o: { fetch?: typeof fetch; log?: (o: object) => void; timeoutMs?: number } = {}) {}
  get active() { return !!(this.cfg.x || this.cfg.reddit); }
  /** Which platforms would send (for the boot log; no ids or secrets). */
  status() { return { enabled: this.cfg.enabled, x: !!this.cfg.x, reddit: !!this.cfg.reddit }; }

  /** Build the requests for one conversion (pure; exported for tests). Empty when nothing should be sent. */
  requests(c: AdsConversion): { platform: "x" | "reddit"; url: string; headers: Record<string, string>; body: string }[] {
    if (!this.cfg.enabled || c.optOut) return [];
    if (c.event !== "purchase" && c.event !== "trial_start") return [];
    const conversionId = (c.conversionId ?? "").trim();
    if (!/^[A-Za-z0-9._:-]{4,100}$/.test(conversionId)) return [];
    const email = hashEmail(c.email, c.emailSha256), tw = clickId(c.twclid), rdt = clickId(c.rdtCid);
    const at = c.at ?? Date.now();
    const value = c.event === "purchase" && typeof c.valueCents === "number" && c.valueCents > 0 ? Math.round(c.valueCents) / 100 : 0;
    const currency = /^[A-Z]{3}$/.test(c.currency ?? "") ? c.currency! : "USD";
    const out: ReturnType<AdsConversions["requests"]> = [];
    const x = this.cfg.x;
    const xEv = x ? (c.event === "purchase" ? x.eventPurchase : x.eventTrial) : "";
    if (x && xEv && (tw || email)) {
      const url = `${X_API}/${encodeURIComponent(x.pixelId)}`;
      const identifiers = [...(tw ? [{ twclid: tw }] : []), ...(email ? [{ hashed_email: email }] : [])];
      const body = JSON.stringify({ conversions: [{ conversion_time: new Date(at).toISOString(), event_id: xEventId(xEv), identifiers, conversion_id: conversionId, value: value.toFixed(2), price_currency: currency, number_items: 1 }] });
      out.push({ platform: "x", url, headers: { authorization: oauth1Header("POST", url, x), "content-type": "application/json" }, body });
    }
    const r = this.cfg.reddit;
    if (r && (rdt || email)) {
      const type = c.event === "purchase" ? { tracking_type: "PURCHASE" } : { tracking_type: "CUSTOM", custom_event_name: "StartTrial" };
      const metadata = { conversion_id: conversionId, ...(c.event === "purchase" ? { value, currency, item_count: 1 } : {}) };
      const body = JSON.stringify({ data: { events: [{ event_at: at, action_source: "WEBSITE", type, ...(rdt ? { click_id: rdt } : {}), metadata, ...(email ? { user: { email } } : {}) }] } });
      out.push({ platform: "reddit", url: `${REDDIT_API}/${encodeURIComponent(r.pixelId)}/conversion_events`, headers: { authorization: `Bearer ${r.token}`, "content-type": "application/json" }, body });
    }
    return out;
  }

  /** Fire-and-forget send. Never throws; never logs ids, emails, hashes or tokens. */
  async send(c: AdsConversion): Promise<{ platform: string; ok: boolean; status: number }[]> {
    const reqs = this.requests(c);
    return Promise.all(reqs.map(async (q) => {
      try {
        const res = await (this.o.fetch ?? fetch)(q.url, { method: "POST", headers: q.headers, body: q.body, signal: AbortSignal.timeout(this.o.timeoutMs ?? 5000) });
        if (!res.ok) this.o.log?.({ evt: "ads_capi_failed", msg: `[ads] ${q.platform} CAPI ${c.event} HTTP ${res.status}` });
        return { platform: q.platform, ok: res.ok, status: res.status };
      } catch (e) {
        this.o.log?.({ evt: "ads_capi_failed", msg: `[ads] ${q.platform} CAPI ${c.event} ${(e as Error).name}` });
        return { platform: q.platform, ok: false, status: 0 };
      }
    }));
  }
}
