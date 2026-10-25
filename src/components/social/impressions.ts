// Feed impression logger (docs/social/ranking.md): one event per card the user settled on, batched and sent with
// navigator.sendBeacon (fetch keepalive fallback) to POST /api/events. Flushes every 10 events, every 20 s, and
// when the page is hidden.
import { apiBase } from "../../agent/bridge-client.ts";

export type Action = "rate" | "comment" | "remix" | "open_studio" | "share";
interface Ev { song: string; dwell_ms: number; listen_ratio: number; completed: boolean; fast_skip: boolean; replay: boolean; actions: Action[]; position: number; feed: string; model_version: string; ts: number }
interface Open { song: string; position: number; feed: string; model_version: string; t0: number; actions: Set<Action>; el: HTMLAudioElement | null; listened: number; lastT: number | null; replay: boolean; dur: number }

const session = (() => { try { let s = sessionStorage.getItem("gbk.feedSession"); if (!s) { s = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join(""); sessionStorage.setItem("gbk.feedSession", s); } return s; } catch { return "nosession0"; } })();
let queue: Ev[] = []; let cur: Open | null = null; let timer: ReturnType<typeof setInterval> | null = null;
export const sentLog: Ev[] = []; // test hook (window.__gbkImpressions)

function flush() {
  if (!queue.length) return; const body = JSON.stringify({ session, client: "web", events: queue }); sentLog.push(...queue); queue = [];
  const url = `${apiBase()}/events`; const blob = new Blob([body], { type: "application/json" });
  if (!(navigator.sendBeacon && navigator.sendBeacon(url, blob))) void fetch(url, { method: "POST", body, headers: { "content-type": "application/json" }, credentials: "same-origin", keepalive: true }).catch(() => undefined);
}
function sample() { const o = cur; if (!o?.el) return; const t = o.el.currentTime; if (Number.isFinite(o.el.duration) && o.el.duration > 0) o.dur = o.el.duration; if (o.lastT !== null) { const d = t - o.lastT; if (d > 0 && d < 2) o.listened += d; else if (d < -0.5) o.replay = true; } o.lastT = t; }
/** Close the open impression (if any) and queue it. */
export function endImpression() {
  const o = cur; if (!o) return; sample(); cur = null;
  const dwell = Math.round(performance.now() - o.t0); const ratio = o.dur ? o.listened / o.dur : 0;
  queue.push({ song: o.song, dwell_ms: dwell, listen_ratio: Math.round(ratio * 1000) / 1000, completed: ratio >= 0.9 || o.replay, fast_skip: dwell < 2000, replay: o.replay, actions: [...o.actions], position: o.position, feed: o.feed, model_version: o.model_version, ts: Date.now() });
  if (queue.length >= 10) flush();
}
export function startImpression(song: string, position: number, feed: string, model_version: string) {
  if (cur?.song === song) return; endImpression();
  cur = { song, position, feed, model_version, t0: performance.now(), actions: new Set(), el: null, listened: 0, lastT: null, replay: false, dur: 0 };
  if (!timer) { timer = setInterval(() => { sample(); flush(); }, 20_000); setInterval(sample, 250); document.addEventListener("visibilitychange", () => { if (document.hidden) { endImpression(); flush(); } }); addEventListener("pagehide", () => { endImpression(); flush(); }); }
}
/** Attach the audio element that plays the open impression's song. */
export function attachAudio(song: string, el: HTMLAudioElement | null) { if (cur && cur.song === song && cur.el !== el) { sample(); cur.el = el; cur.lastT = el ? el.currentTime : null; } }
export function markAction(song: string, a: Action) { if (cur?.song === song) cur.actions.add(a); else queue.push({ song, dwell_ms: 0, listen_ratio: 0, completed: false, fast_skip: false, replay: false, actions: [a], position: -1, feed: "detail", model_version: "none", ts: Date.now() }); }
export { flush as flushImpressions };
if (typeof window !== "undefined") (window as unknown as { __gbkImpressions: unknown }).__gbkImpressions = { sentLog, flush, end: endImpression };
