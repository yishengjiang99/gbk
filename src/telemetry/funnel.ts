// Aggregate funnel beacon (see server/src/routes/funnel.ts): sends only an allow-listed event name and a coarse
// source. No ids, no URLs, no project content. Best effort; never throws and never blocks the UI.
import { apiBase } from "../agent/bridge-client.ts";

export function funnelBeacon(event: "page_view_landing" | "browser_render_completed", source: "web" | "studio" | "widget") {
  try {
    if (typeof fetch === "undefined" || typeof location === "undefined" || !/^https?:$/.test(location.protocol)) return;
    void fetch(`${apiBase()}/funnel`, { method: "POST", keepalive: true, credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ event, source }) }).catch(() => undefined);
  } catch { /* analytics never break the app */ }
}
