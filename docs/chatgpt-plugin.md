# GBK Composer as a ChatGPT / Codex plugin

GBK Composer is exposed to ChatGPT and Codex as a **remote MCP server** plus a portable
**Agent Plugin** package. A user can compose, edit, visualize and render structured music
entirely inside ChatGPT — no GBK browser tab, no user gesture, no audio device — and still
open the same composition in GBK Studio afterwards.

| Piece | Where |
|---|---|
| MCP endpoint | `https://compose.grepawk.com/mcp` (Streamable HTTP, official `@modelcontextprotocol/sdk`) |
| OAuth discovery | `https://compose.grepawk.com/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` |
| Plugin package | `plugins/gbk-composer/` (this repo) + repo marketplace `.agents/plugins/marketplace.json` |
| Server code | `server/src/mcp/` (store, auth, OAuth, service, render workers, MCP Apps UI, routes) |
| Tests | `server/test/mcp-*.test.ts` (`npm run test:mcp`) |
| Submission packet | `docs/chatgpt-plugin-submission.md` |

## How it works

- **ChatGPT supplies the musical reasoning.** GBK supplies deterministic operations: the same
  canonical `gbk_*` tool registry, `WorkstationController`, project model and SF2 offline
  renderer the browser workstation uses — reused, not duplicated. The website's internal LLM
  agent is *not* invoked by MCP calls, so ChatGPT users never consume the site's LLM budget.
- **Durable state.** Compositions live in SQLite (`mcp.sqlite` in `COMPOSER_DATA_DIR`) with a
  full revision snapshot per edit. Edits require `expectedRevision`; conflicts return
  `STALE_REVISION` with the current revision. Mutating calls accept `idempotencyKey`.
- **Headless server rendering (default with no Studio tab).** When no Studio tab is connected, or
  the client passes `headless: true`, `gbk_render_composition` renders on the server: a worker-thread
  pool (`server/src/mcp/server-render.ts` -> `render-worker.ts`, bundled as
  `server/dist/render-worker.mjs`) runs `renderProjectOffline` with the app's own SF2 engine on a
  Node OfflineEnv (`src/audio/node-offline-env.ts`), so the event loop never blocks. Output: WAV
  (44.1 kHz stereo PCM16, loudness-normalized by default) and an SMF type 1 MIDI file (always),
  published through the same SHA-256 / header / validation checks, returned as signed URLs (never
  bytes). The call waits up to `waitSeconds` (default 50). Limits (env, default): `SERVER_RENDER_GUEST_MAX_SECONDS`
  180, `SERVER_RENDER_ACCOUNT_MAX_SECONDS` 300 (including tail), `SERVER_RENDER_CONCURRENCY` 1 worker,
  `SERVER_RENDER_MAX_QUEUE` 8, one queued/running server render per owner (guest project or account),
  `SERVER_RENDER_GUEST_PER_HOUR` 6 per guest project, `SERVER_RENDER_ACCOUNT_PER_HOUR` 30,
  `SERVER_RENDER_GUEST_PER_CLIENT_PER_DAY` 30 per network (salted IP hash), plus the existing daily
  render caps; `SERVER_RENDER_TIMEOUT_MS` 180000 (worker terminated and replaced),
  `SERVER_RENDER_WORKER_HEAP_MB` 768. Off switch: `SERVER_RENDER=0` (then guests get the MIDI +
  `browser_render` handoff and accounts `studio_required`). Covered by `server/test/mcp-server-render.test.ts`.
- **Rendering in the Studio tab.** For a signed-in user with a connected Studio tab,
  `gbk_render_composition` pins the revision snapshot, creates a durable job and hands it over the existing browser
  WebSocket bridge to the user's connected, signed-in GBK Studio tab (`gbk_mcp_render_job`).
  The tab runs `renderProjectOffline` (the Studio's own SF2 engine), uploads the WAV in chunks
  with a per-job capability token, and the server verifies SHA-256, the WAV header and the
  renderer's validation before publishing WAV + MIDI artifacts. With no tab connected it renders on
  the server (above); only with `SERVER_RENDER=0` does it return `status: "studio_required"`.
- **Rendering in the in-chat player (no Studio tab).** The player (`gbk_show_composition_ui`) has a
  Render button. It calls the app-only tool `gbk_widget_render_start` (job + capability token),
  loads `/api/mcp/widget/gbk-widget-render.js` (built by `scripts/build-widget.mjs` from
  `src/widget/widget-render.ts`), and renders the pinned snapshot with the same
  `renderProjectOffline` -> `offline-context.ts` OfflineAudioContext + `sf2-processor` AudioWorklet
  path (worklet module from `/api/mcp/widget/sf2-processor.js`, falling back to a blob: copy;
  SoundFont from `/api/mcp/widget/soundfont.sf2`). Progress %, Stop, 15 min timeout plus the
  renderer's stall/timeout watchdogs. Playback uses an AudioContext buffer (no blob: media URL),
  the WAV is uploaded in chunks to the same validated endpoint, and `gbk_widget_render_finish`
  publishes WAV + MIDI artifacts (executor `widget`), so Download WAV/MIDI become signed links.
  These asset/upload endpoints send `Access-Control-Allow-Origin: *` (no credentials; the token is
  the authority). The resource declares our origin in `_meta.ui.csp` and `openai/widgetCSP`.
  Check it against a mimicked host sandbox with
  `node --import tsx/esm test/e2e/widget-sandbox.check.ts` (Chromium + WebKit, strict CSP). Jobs are durable (running/completed/failed/cancelled) with a per-job timeout,
  cancellation, per-account daily render limits, and explicit failure when the tab disconnects
  or the server restarts mid-render. Artifacts are published atomically (all payloads validated +
  SHA-256 re-checked before any row is inserted); render and status results carry signed download URLs.
- **Artifacts.** WAV/MIDI bytes live on disk under `<dataDir>/mcp-artifacts/`, metadata +
  provenance (renderer version, source revision, SoundFont, normalized params, SHA-256) in
  SQLite. Downloads use short-lived signed URLs (`MCP_ARTIFACT_URL_TTL_SEC`, default 15 min)
  via `GET /api/mcp/artifacts/:id` with Range streaming; the endpoint also accepts a Bearer
  token or the website session and re-checks ownership at access time. Completed
  `gbk_render_composition` / `gbk_get_render_status` responses carry the signed URLs directly
  in their artifact entries — call `gbk_get_artifacts` when you need fresh ones after expiry.
  Large audio is never inlined into MCP responses.
- **MCP Apps UI.** `gbk_show_composition_ui` renders `ui://gbk/composer-v2.html`
  (`text/html;profile=mcp-app`): audio player with seek, tick-accurate piano roll fed by the
  authoritative project, section markers, CC11 lanes, track list, WAV/MIDI downloads and an
  Open-in-Studio link. Tools remain fully usable in hosts without UI support.

## Public MCP tools

`gbk_get_capabilities` (public, read-only) · `gbk_create_composition` · `gbk_get_composition` ·
`gbk_list_compositions` · `gbk_edit_composition` · `gbk_render_composition` ·
`gbk_get_render_status` · `gbk_cancel_render` · `gbk_get_artifacts` · `gbk_open_workstation` ·
`gbk_publish_composition` (explicit publish only) · `gbk_show_composition_ui`.

Scopes: `gbk:compositions.read`, `gbk:compositions.write`, `gbk:renders.create`,
`gbk:artifacts.read`, `gbk:shares.publish`.

## Account-free access (default)

`plugins/gbk-composer/mcp.json` declares `auth.type: "none"`. Without credentials,
`gbk_create_composition` creates a guest project and returns `compositionId`, a private
`accessToken` (edit) and a `readAccessToken`. Every follow-up tool (`gbk_get_composition`,
`gbk_edit_composition`, `gbk_render_composition`, `gbk_get_render_status`, `gbk_cancel_render`,
`gbk_get_artifacts`, `gbk_open_workstation`, `gbk_publish_composition`, `gbk_show_composition_ui`,
`gbk_list_compositions`) accepts `accessToken`. Implementation: `server/src/mcp/guest.ts`.

- Capabilities are HMACs (domain-separated, keyed by `SESSION_SECRET`) over the composition id and
  its unique guest owner. They survive restarts; rotating `SESSION_SECRET` invalidates them all.
- The id alone grants nothing (`NOT_FOUND`); another project's token or a tampered token too. Read
  capabilities cannot edit, render or publish (`INSUFFICIENT_SCOPE`). Anonymous list is empty.
- Studio links (`/s/<slug>#access=<readAccessToken>`) carry only the read capability, in the fragment;
  the page sends it as `x-gbk-project-token` (redacted from logs). Publish URLs carry none.
- Guest renders run on the server (headless, above). With `SERVER_RENDER=0` a guest
  `gbk_render_composition` exports the MIDI only and returns `status: "browser_render"` with `browserRender` = { `widgetTool`, `studioUrl`,
  `snapshotUrl` (`GET /api/mcp/guest/snapshot`, header `x-gbk-project-token`), `readAccessToken` } so
  the in-chat player or a Studio tab renders WAV locally. `server/test/mcp-guest.test.ts` asserts the
  main thread never constructs an audio context; synthesis modules are imported only by the render worker.
- Limits (env, defaults): `MCP_GUEST_MAX_SECONDS` 180, `MCP_GUEST_MAX_BARS` 64, `MCP_GUEST_MAX_EVENTS`
  20000, `MCP_GUEST_MAX_REVISIONS` 100, `MCP_GUEST_RENDERS_PER_DAY` 20 per project, durable global
  rolling-24h `MCP_GUEST_CREATES_PER_DAY` 200 and `MCP_GUEST_MUTATIONS_PER_DAY` 2000,
  `MCP_GUEST_MAX_COMPOSITIONS` 2000, `MCP_GUEST_MAX_STORAGE_BYTES` 256 MiB, anonymous calls
  `MCP_GUEST_CALLS_PER_MINUTE` 60 per IP, at most 2000 live MCP sessions, artifact bytes deleted after
  `MCP_ARTIFACT_RETENTION_DAYS` (hourly sweep; expired URLs return 410).
- Off switch: `MCP_GUEST=0` restores OAuth-only access (401 + `WWW-Authenticate` challenge).
- A lost key cannot be recovered. `gbk_delete_composition` (edit key) deletes a guest project with
  its revisions, jobs, files and Studio snapshot; support deletes by composition id on request.
- Claim: a signed-in (OAuth / session) client calls `gbk_claim_composition` with the edit key to move
  the project into the account (library + recovery); the old keys stop working.
- DoS bounds: per-client create cap `MCP_GUEST_CREATES_PER_CLIENT_PER_DAY` (default 20, keyed by a salted
  hash of the IP, checked before the global budget so one client cannot drain it), 60 anonymous calls
  per IP per minute (429), global create/edit budgets, 2000-session cap (429), storage cap
  (`QUOTA_EXCEEDED` before anything is written). Guest server renders share the bounded render
  queue with one in flight per project and the per-network daily cap above. Covered by
  `server/test/mcp-guest.test.ts`.

## Funnel analytics

Server-side, aggregate only (`server/src/persistence/funnel.ts`, `analytics.sqlite`): one row per UTC day, event and coarse
source with a count, and nothing else (no IP, account id, cookie, prompt, content, id or token; no third-party scripts).

| Event | Counted when | Source |
| --- | --- | --- |
| `page_view_chatgpt`, `page_view_legal` | `/chatgpt`, `/privacy`, `/terms` or `/support` is served | — |
| `page_view_landing` | the site root loads (browser beacon) | `web` |
| `mcp_connect` | a new MCP session initializes | `guest` / `account` |
| `create`, `edit`, `render_requested`, `claim`, `publish`, `delete` | the tool succeeds (idempotent replays and `studio_required` are not counted) | `guest` / `account` |
| `browser_render_completed` | a verified WAV upload completes an MCP render (in-chat player via `gbk_widget_render_finish`, or a connected Studio tab), or Studio's WAV export beacon fires | `widget` / `studio-tab` / `studio` |
| `midi_download`, `wav_download` | an artifact is fetched in full or from byte 0 | `guest` / `account` |

The browser beacon is `POST /api/funnel {event, source}`. It accepts only `page_view_landing/web` and
`browser_render_completed/studio`, is limited to 30 per minute per IP in memory, and keeps the IP nowhere.

Read the data:
- Admin JSON: `GET /api/admin/funnel?days=30` while signed in as a `COMPOSER_ADMIN_USERS` account. It returns totals,
  bySource, byDay and conversion ratios.
- CLI on the server: `cd /var/www/gbk-composer/current && sudo -u www-data node --disable-warning=ExperimentalWarning deploy/funnel.mjs --days 30` (add `--json` for raw rows).

## Optional account authentication

OAuth 2.1 per the MCP authorization spec, with this server as its own authorization server:

- Authorization code + PKCE (`S256` only); `resource` is echoed into the token audience and
  verified on every request, together with issuer, expiry and scopes.
- **Dynamic Client Registration** (`POST /oauth/register`, public clients) and **CIMD**:
  an `https://` `client_id` document URL is accepted when its host is allowlisted
  (`MCP_OAUTH_CIMD_HOSTS`, default `chatgpt.com`) and its `redirect_uris` validate. Arbitrary
  hosts are never fetched (SSRF guard). ChatGPT's exact redirect URI is whatever its
  management page shows — register/allowlist that URI; nothing is hardcoded here.
- **Account linking:** `/oauth/authorize` requires a GBK website session
  (Sign in with Google / GitHub, the same accounts as the studio). The GBK user from that session becomes the token subject; consent
  lists the requested scopes. There is no separate MCP account.
- Refresh tokens rotate; reusing a rotated refresh token revokes the whole token family.
  Revocation: `POST /oauth/revoke`. Access tokens are stored **hashed** (SHA-256).
- The website session cookie is also accepted on `/mcp` (same-origin tooling/Studio).
- **Local test auth** (`MCP_TEST_AUTH=1`): `Authorization: Bearer test:<user>` or the
  `x-gbk-test-user` header grants all scopes for that named test user. The server **refuses
  to boot** with `NODE_ENV=production` + `MCP_TEST_AUTH=1`.

## Deploy

The MCP surface ships inside the existing release (no new service, no Docker):

1. Build as usual (`npm run build:compose` and `npm run build:server`, which builds
   `server/dist/index.mjs`).
2. Add the `MCP_*` variables from `deploy/compose.env.example` to `/etc/gbk-composer.env`.
   Leave `MCP_TEST_AUTH` unset/`0` in production.
3. Install the updated `deploy/nginx.conf` (adds the `/mcp` streaming location and the
   `/.well-known/` + `/oauth/` proxy blocks) and reload nginx.
4. `bash deploy/remote-install.sh /tmp/rel.tgz <release-id>` as usual (health check +
   auto-rollback included).
5. Validate (below). Rollback is the existing `deploy/ops.sh rollback`.

Writable storage: only `COMPOSER_DATA_DIR` (`mcp.sqlite`, `mcp-artifacts/`). Readiness:
`GET /api/mcp/status` reports executor mode (`worker`), queue depth, call/error/auth-failure
counters and artifact totals. Logs are structured (`evt: mcp_*`, `oauth_*`) and never contain
tokens, codes or artifact bytes.

## Validate the endpoint

```bash
curl https://compose.grepawk.com/.well-known/oauth-protected-resource
curl https://compose.grepawk.com/api/mcp/status
npx @modelcontextprotocol/inspector@latest   # connect to https://compose.grepawk.com/mcp
```

With the Inspector: run Initialize, check `tools/list` (12 tools), call
`gbk_get_capabilities` anonymously, create a guest composition (no sign-in) or complete the OAuth flow, then run the demonstration
prompts below. Locally, `MCP_TEST_AUTH=1 npm run dev:server`-style runs accept
`x-gbk-test-user: alice` instead of OAuth.

## Connect from ChatGPT (account owner steps)

1. Deploy (above) and confirm the validation checks pass.
2. In ChatGPT: **Plugins → Add custom MCP server**, URL `https://compose.grepawk.com/mcp`.
   Accept the risk warning, choose **Create as a plugin**; note the technical id
   (`plugin_asdk_app…`) if you later add an `.app.json` mapping.
3. First tool use starts OAuth: sign in to GBK with Google or GitHub, review the scopes on the
   consent page, approve. The redirect URI shown by ChatGPT's management page must be the
   one registered — DCR handles this automatically for ChatGPT-created clients.
4. Try: “@GBK Compose a 32-bar four-voice Baroque fugue in D minor at 108 BPM with organ
   instrumentation and expressive CC11 dynamics. Render WAV and MIDI.” Then: “Add stretto
   in the final eight bars, increase the bass presence, and rerender.” Then: “Show me the
   piano roll and let me download both files.”

## Connect from Codex

Add the repo marketplace or install `plugins/gbk-composer/` directly; the plugin's
`mcp.json` points Codex at the same `https://compose.grepawk.com/mcp` endpoint with no authentication (OAuth optional).
The bundled skills (`compose-music`, `edit-music`, `render-music`) teach the workflow:
capabilities first, durable create, inspect, targeted revision-safe edits, render, verify
artifacts before claiming success.

## Troubleshooting

- **401 on tools/call, no OAuth prompt** — the client didn't get the challenge: check
  `WWW-Authenticate` on a manual `POST /mcp` and that `/.well-known/oauth-protected-resource`
  returns this origin's issuer. A mismatched `COMPOSER_PUBLIC_ORIGIN` breaks audience checks.
- **`invalid_grant` at token exchange** — PKCE verifier mismatch, reused/expired code
  (10 min), or `redirect_uri` differing by one character from the authorization request.
- **Token works, then 401 after refresh** — an old refresh token was replayed; the family
  was revoked by design. Re-authorize.
- **`STALE_REVISION`** — someone (or Studio) edited first. Re-read with
  `gbk_get_composition` and retry against the returned revision.
- **Render `WORKER_INTERRUPTED` / timeouts** — the worker died or exceeded
  `MCP_RENDER_TIMEOUT_MS`; no partial artifact exists. Resubmit; check `/api/mcp/status`
  queue depth and `MCP_RENDER_CONCURRENCY`.
- **Artifact URL 401** — signed URLs expire (`MCP_ARTIFACT_URL_TTL_SEC`); fetch fresh ones
  with `gbk_get_artifacts`.
- **UI blank in host** — the host must support MCP Apps; verify `gbk_show_composition_ui`'s
  `_meta.ui.resourceUri` and fetch `ui://gbk/composer-v2.html` via `resources/read` in the
  Inspector. Tools still work without the UI.

## Privacy & retention

Compositions and artifacts are private to the owning GBK account by default and are never
published implicitly; `gbk_publish_composition` (scope `gbk:shares.publish`) is the only
publishing path and is for explicit user requests. Prompts/titles are user content used only
as data — never executed (no shell/JS/filesystem access exists in the MCP surface). Artifact
bytes are retained on disk per `MCP_ARTIFACT_RETENTION_DAYS`; deleting a composition in
Studio/account flows is the deletion path documented in the submission packet.

## Status

Implemented and covered by automated tests (protocol, OAuth, cross-user isolation,
edit-preservation, crash recovery, autonomous render) against the real server + real MCP
protocol. **Not yet done** (needs the account owner): production deployment, adding the
custom MCP server inside a real ChatGPT account, and public directory submission. Nothing
here claims public approval.
