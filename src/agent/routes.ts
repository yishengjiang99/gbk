// Tiny path router relative to the Vite base ("/" on compose.grepawk.com, "/gbk/" on GitHub Pages).
export function base(): string { try { return (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"; } catch { return "/"; } }
export const appUrl = (path = "") => `${base()}${path.replace(/^\//, "")}`;
export type Route = { view: "explore" } | { view: "studio" } | { view: "share"; slug: string; fork: boolean };
export function parseRoute(pathname = location.pathname, search = location.search): Route {
  const b = base(); let rel = pathname.startsWith(b) ? pathname.slice(b.length) : pathname.replace(/^\//, "");
  rel = rel.replace(/\/$/, "");
  const m = /^s\/([a-z0-9]{4,32})$/.exec(rel);
  if (m) return { view: "share", slug: m[1], fork: new URLSearchParams(search).get("fork") === "1" };
  if (rel === "studio" || new URLSearchParams(search).has("player")) return { view: "studio" };
  return rel === "" || rel === "explore" ? { view: "explore" } : { view: "studio" };
}
export function navigate(path: string) { history.pushState(null, "", appUrl(path)); window.dispatchEvent(new PopStateEvent("popstate")); }
