# Launch analytics (#72 Phase 6)

Aggregate, server-side only. `FunnelStore` (`server/src/persistence/funnel.ts`, `analytics.sqlite`) keeps one row per
(UTC day, event, source) with a count. No IPs, account ids, cookies, prompts, composition content, URLs, or tokens.
No third-party analytics. **None of these numbers count people**: there are no identifiers, so there are no unique users.

## Events

| Event | Source values | Where it's counted | Notes |
| --- | --- | --- | --- |
| page_view_landing | web | `POST /api/funnel` beacon from the SPA | browser-only signal |
| page_view_chatgpt / page_view_legal / page_view_gallery | none | server, on page GET | nginx doesn't cache these pages, so every view reaches the server; browser caches (max-age 300) can hide repeat views |
| install_cta_click | none | `GET /chatgpt/install` (302 to `CHATGPT_PLUGIN_URL`) | the CTA exists only when the URL is set |
| install_link_unavailable | none | `/chatgpt` view or `/chatgpt/install` hit while `CHATGPT_PLUGIN_URL` is unset | measures demand before a listing URL exists |
| mcp_connect | guest / account | MCP `initialize` | |
| first_tool_call | guest / account / "" | first successful tool call of an MCP session | once per session, never per call |
| create, edit, render_requested, claim, publish, delete | guest / account | successful first execution of the tool (idempotent replays aren't counted) | |
| browser_render_completed | widget / studio-tab (server event); studio (beacon) | render job finished by a browser executor | |
| server_render_completed | server | render job finished by the headless server renderer | split from browser renders, so there's no double counting |
| render_failed | none | render job failed (any executor) | |
| midi_download / wav_download | guest / account | artifact GET (first byte range only) | |

## Not observable

- Whether ChatGPT showed or chose GBK for a prompt (discovery inside ChatGPT). Only calls that reach the server are visible.
- Installs or uninstalls in ChatGPT, and portal review state.
- Playback inside the ChatGPT widget, and downloads that happen fully in the browser (in-player WAV blob).
- Individual users, retention, or cohorts (by design: no identifiers).

## Query

- API (admin session): `GET /api/admin/funnel?days=30` returns totals, bySource, byDay, and ratios (`createPerConnect`,
  `firstToolCallPerConnect`, `renderPerCreate`, `serverRenderPerRequest`, `renderFailurePerRequest`, `installClickPerChatgptView`, ...).
- Operator report on the server: `cd /var/www/gbk-composer/current && sudo -u www-data node --disable-warning=ExperimentalWarning deploy/funnel.mjs --days 30 --daily`
  prints totals by source, ratios of counts, and a daily table.

## Validation

`server/test/funnel.test.ts` and `server/test/funnel-launch.test.ts` check: only allow-listed events and sources;
the table has no identifying columns; first_tool_call is counted once per session; server vs browser render
completion are counted separately; install click vs unavailable; gallery views; admin-only read.

## Limits

These are daily UTC totals. Ratios are ratios of counts (for example, one person could connect three times).
Bots that hit pages or MCP are counted too.
