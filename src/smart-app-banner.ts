// Keeps the iOS Smart App Banner's app-argument on the current URL across SPA navigation, so "OPEN" deep-links
// the app to the page the user is on. Safari may read the tag only at load (server-rendered / inline script in index.html).
export const withAppArgument = (content: string, href: string) =>
  /app-argument=/.test(content) ? content.replace(/app-argument=.*$/, `app-argument=${href.replace(/,/g, "%2C")}`) : `${content}, app-argument=${href.replace(/,/g, "%2C")}`;

export function syncSmartAppBanner(doc: Document = document, loc: Location = location) {
  const m = doc.querySelector('meta[name="apple-itunes-app"]'); if (!m) return;
  const c = m.getAttribute("content") ?? ""; if (c) m.setAttribute("content", withAppArgument(c, loc.href));
}

export function installSmartAppBanner() {
  if (typeof history === "undefined" || typeof document === "undefined") return;
  for (const k of ["pushState", "replaceState"] as const) {
    const orig = history[k];
    history[k] = function (this: History, ...a: Parameters<History["pushState"]>) { const r = orig.apply(this, a); syncSmartAppBanner(); return r; };
  }
  addEventListener("popstate", () => syncSmartAppBanner());
  syncSmartAppBanner();
}
