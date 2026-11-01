// Tiny path router relative to the Vite base ("/" on compose.grepawk.com, "/gbk/" on GitHub Pages).
export function base(): string { try { return (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"; } catch { return "/"; } }
export const appUrl = (path = "") => `${base()}${path.replace(/^\//, "")}`;
export type SocialRoute = { view: "feed"; sort?: string; label?: string; tag?: string; focus?: string } | { view: "profile"; handle: string | null } | { view: "inbox" } | { view: "admin" };
export type Route = SocialRoute | { view: "studio" } | { view: "jam"; roomId: string | null } | { view: "share"; slug: string; fork: boolean };
export function parseRoute(pathname = location.pathname, search = location.search): Route {
  const b = base(); let rel = pathname.startsWith(b) ? pathname.slice(b.length) : pathname.replace(/^\//, "");
  rel = rel.replace(/\/$/, "");
  // Legacy/alias share forms (/song/<slug>, /share/<slug>, /?s=<slug>) open the same song card as /s/<slug>.
  const legacy = /^(?:song|share)\/([a-z0-9][a-z0-9-]{3,127})$/.exec(rel)?.[1] ?? (rel === "" ? new URLSearchParams(search).get("s") : null);
  if (legacy && /^[a-z0-9][a-z0-9-]{3,127}$/.test(legacy)) { const q = new URLSearchParams(search); q.delete("s"); rel = `s/${legacy}`; search = q.toString() ? `?${q}` : ""; try { history.replaceState(history.state, "", appUrl(rel) + search); } catch { /* non-browser */ } }
  const m = /^s\/([a-z0-9][a-z0-9-]{3,127})$/.exec(rel);
  // A share link lands on the song's feed card (playing once audio unlocks), not in the
  // Studio. The editor opens only on an explicit studio route: ?edit=1 (the card's "open", read-only) or ?fork=1 (Remix).
  if (m) { const q = new URLSearchParams(search); const fork = q.get("fork") === "1"; return fork || q.get("edit") === "1" ? { view: "share", slug: m[1], fork } : { view: "feed", focus: m[1] }; }
  const jam = /^jam(?:\/([A-Za-z0-9]{6,40}))?$/.exec(rel); if (jam) return { view: "jam", roomId: jam[1] ?? null };
  if (rel === "studio" || new URLSearchParams(search).has("player")) return { view: "studio" };
  const q = new URLSearchParams(search);
  // ?pin=<slug>: one-shot pin after Publish (the new song first, then normal ranking). URL only, never stored.
  if (rel === "" || rel === "explore" || rel === "feed") { const pin = q.get("pin"); return { view: "feed", sort: q.get("sort") ?? undefined, label: q.get("label") ?? undefined, ...(pin && /^[a-z0-9][a-z0-9-]{3,127}$/.test(pin) ? { focus: pin } : {}) }; }
  const t = /^t\/([a-z0-9-]{2,24})$/.exec(rel); if (t) return { view: "feed", tag: t[1] };
  const u = /^u\/([a-z0-9_]{3,20})$/.exec(rel); if (u) return { view: "profile", handle: u[1] };
  if (rel === "me") return { view: "profile", handle: null };
  if (rel === "inbox" || rel.startsWith("inbox/")) return { view: "inbox" };
  if (rel === "admin/reports") return { view: "admin" };
  return { view: "studio" };
}
export function navigate(path: string) { history.pushState(null, "", appUrl(path)); window.dispatchEvent(new PopStateEvent("popstate")); }
