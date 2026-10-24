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
- **Autonomous rendering.** Render jobs run in worker threads executing `renderProjectOffline`
  (Sf2SynthEngine + bundled GeneralUser-GS SoundFont) — the exact code path the browser uses,
  proven in Node by `test/audio-render.test.ts`. No Chromium, no tab. Jobs are durable:
  queued/running/completed/failed/cancelled, with per-job timeout, cancellation, per-user
  quotas, and crash semantics (a job left `running` by a dead process is failed explicitly as
  `WORKER_INTERRUPTED`; a job left `queued` resumes from its stored revision snapshot and
  config, or fails as `JOB_ORPHANED` if its composition vanished; artifacts are published
  atomically — all payloads validated + SHA-256 re-checked before any row is inserted).
- **Artifacts.** WAV/MIDI bytes live on disk under `<dataDir>/mcp-artifacts/`, metadata +
  provenance (renderer version, source revision, SoundFont, normalized params, SHA-256) in
  SQLite. Downloads use short-lived signed URLs (`MCP_ARTIFACT_URL_TTL_SEC`, default 15 min)
  via `GET /api/mcp/artifacts/:id` with Range streaming; the endpoint also accepts a Bearer
  token or the website session and re-checks ownership at access time. Completed
  `gbk_render_composition` / `gbk_get_render_status` responses carry the signed URLs directly
  in their artifact entries — call `gbk_get_artifacts` when you need fresh ones after expiry.
  Large audio is never inlined into MCP responses.
- **MCP Apps UI.** `gbk_show_composition_ui` renders `ui://gbk/composer.html`
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

## Authentication

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

1. Build as usual (`npm run build:compose` also builds `server/dist/index.mjs` and
   `server/dist/render-worker.mjs` via `build:server`).
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
`gbk_get_capabilities` anonymously, complete the OAuth flow, then run the demonstration
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
`mcp.json` points Codex at the same `https://compose.grepawk.com/mcp` endpoint with OAuth.
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
  `_meta.ui.resourceUri` and fetch `ui://gbk/composer.html` via `resources/read` in the
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
