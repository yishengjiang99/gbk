// Traffic classification for analytics hygiene (telemetry audit, Nov 2026). Two kinds of requests must not
// count as product usage:
//  - known crawlers / link-preview fetchers, identified by user agent (BOT_UA_RE);
//  - our own CI / UI-test traffic, which opts out explicitly with the `X-GBK-Test: 1` header (the contract
//    with the iOS UI tests and any other automated client hitting prod), or the `gbk_test=1` cookie (set by the
//    iOS UI-test web view, so page loads, sendBeacon and WebSocket upgrades carry it too).
// A request-scoped AsyncLocalStorage carries the verdict so the aggregate sinks (FunnelStore, BillingRecorder)
// can drop excluded traffic without every call site threading the request through.
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingHttpHeaders } from "node:http";

export const TEST_TRAFFIC_HEADER = "x-gbk-test";
export const TEST_TRAFFIC_COOKIE = "gbk_test";
const TEST_COOKIE_RE = /(?:^|;)\s*gbk_test=(?:1|true)\s*(?:;|$)/i;

/** Crawlers and link-preview bots. Explicit names (no bare "bot" substring: real phone UAs such as "CUBOT"
 *  contain it), plus the `+http://…` contact-URL convention real browsers never use. */
export const BOT_UA_RE = new RegExp([
  "googlebot", "google-inspectiontool", "googleother", "adsbot-google", "mediapartners-google", "apis-google", "feedfetcher-google", "storebot-google",
  "bingbot", "bingpreview", "msnbot", "adidxbot", "slurp", "duckduckbot", "baiduspider", "yandex(?:bot|images|mobilebot)", "sogou", "exabot", "seznambot", "petalbot", "applebot",
  "facebookexternalhit", "facebookcatalog", "facebookbot", "meta-externalagent", "meta-externalfetcher", "meta-webindexer",
  "twitterbot", "linkedinbot", "slackbot", "slack-imgproxy", "discordbot", "telegrambot", "whatsapp", "pinterestbot", "redditbot", "skypeuripreview", "embedly", "iframely", "vkshare",
  "ahrefs(?:bot|siteaudit)", "semrushbot", "mj12bot", "dotbot", "rogerbot", "blexbot", "dataforseobot", "serpstatbot", "barkrowler", "screaming frog", "seokicks", "megaindex",
  "bytespider", "gptbot", "chatgpt-user", "oai-searchbot", "claudebot", "claude-web", "anthropic-ai", "perplexitybot", "ccbot", "amazonbot", "cohere-ai", "diffbot", "youbot", "imagesiftbot", "timpibot",
  "ia_archiver", "archive\\.org_bot", "uptimerobot", "pingdom", "statuscake", "site24x7", "crawler", "spider", "\\+https?://",
].join("|"), "i");

export const isBotUserAgent = (ua: unknown): boolean => typeof ua === "string" && ua.length > 0 && BOT_UA_RE.test(ua);
export const isTestTraffic = (headers: IncomingHttpHeaders): boolean => {
  const v = headers[TEST_TRAFFIC_HEADER]; const s = (Array.isArray(v) ? v[0] : v)?.trim().toLowerCase();
  if (s === "1" || s === "true") return true;
  const c = headers.cookie; return typeof c === "string" && TEST_COOKIE_RE.test(c);
};

export interface TrafficClass { bot: boolean; test: boolean }
/** Server-to-server webhooks (Apple ASSN, the Stripe hop) are money truth: never drop them by user agent
 *  (Stripe's own UA carries a "+https://" contact URL). */
const WEBHOOK_PATHS = ["/api/iap/apple/notifications", "/api/billing/stripe-events"];
export const classifyTraffic = (headers: IncomingHttpHeaders, url = ""): TrafficClass => ({
  bot: !WEBHOOK_PATHS.some((p) => url === p || url.startsWith(`${p}?`)) && isBotUserAgent(headers["user-agent"]),
  test: isTestTraffic(headers),
});

const store = new AsyncLocalStorage<TrafficClass>();
/** Run `fn` with this request's traffic class in scope (wired as the first onRequest hook in app.ts). */
export const withTraffic = <T>(c: TrafficClass, fn: () => T): T => store.run(c, fn);
/** True inside a request from a crawler or carrying X-GBK-Test: aggregate analytics must skip it.
 *  Outside a request (webhooks are requests too, but never set the header; timers, CLIs) it is false. */
export const analyticsExcluded = (): boolean => { const c = store.getStore(); return !!c && (c.bot || c.test); };
export const currentTraffic = (): TrafficClass | undefined => store.getStore();
/** Same verdict computed straight from a request, for hooks that may run outside the ALS scope (onResponse). */
export const isExcludedRequest = (headers: IncomingHttpHeaders, url = ""): boolean => { const c = classifyTraffic(headers, url); return c.bot || c.test; };
