# GBK Composer (compose.grepawk.com)

The Composer is a server-hosted LLM agent loop. The browser is the tool executor: the server's model calls the canonical
`gbk_*` tools (`buildAllTools` / `runTool`), each call is sent over a WebSocket (`/api/agent/ws`) to the open tab, the tab
runs it against its local project, and the result is sent back. Synthesis and rendering stay in the browser, and the server never holds audio
unless someone explicitly clicks **Share**.

- Server: `server/src` (Fastify 5 + ws, Node 22 `node:sqlite`). Bundled with `npm run build:server` to `server/dist/index.mjs`.
- Frontend: `npm run build:compose` (base `/`). GitHub Pages keeps using `GBK_BASE_PATH=/gbk/` (deploy workflow). The Composer UI appears
  only if `/api/config` answers with JSON, so on Pages it stays hidden.
- Routes: `/` Explore (shared songs), `/studio` workstation, `/s/<slug>` shared song (read-only new local project, **Fork** = editable copy).
- Safety: tool catalog and policy are server-side (render forced to an artifact, `create_project` never replaces the current project).
  Edits to the user's own projects still need **Accept**. Autonomous commits happen only in agent-created projects. Tool results are wrapped as untrusted data.
- Auth/limits: Google/GitHub sign-in with per-account daily token/render limits (legacy `COMPOSER_ACCESS_CODES` still accepted), HMAC session cookie + CSRF, Origin checks, per-IP/login/message/upload
  rate limits, daily per-user token/cost budgets plus a global cost budget. `COMPOSER_ENABLED=0` is the off switch.

## Deploy (systemd + nginx, no Docker)
Env: `/etc/gbk-composer.env` (root:www-data 0640, see `deploy/compose.env.example`). Data: `/var/lib/gbk-composer` (SQLite shares, conversations).
```
npm run build:compose && npm run build:server
tar czf rel.tgz dist server/dist server/package.json deploy     # upload to server /tmp
bash deploy/remote-install.sh /tmp/rel.tgz <release-id>           # releases/<id>, swap current, restart, health check, auto-rollback
```
nginx vhost: `deploy/nginx.conf` → `/etc/nginx/sites-available/compose.grepawk.com` (back up first, run `nginx -t` before reloading).
TLS (once DNS resolves): `certbot --nginx -d compose.grepawk.com`. Ops: `deploy/ops.sh health|logs|releases|rollback|verify-tls`.

## SoundFonts
Pinned in `soundfonts/catalog.json` (sources, commits, SHA-256s, licenses — see `soundfonts/README.md`). Small fonts
(GeneralUser GS, TimGM6mb) are fetched at build time and ship in `dist/static/` on both Pages and compose. The large
FluidR3 GM bank is compose-only: it lives outside the releases in `/var/www/gbk-composer/soundfonts/`, is served at
`/soundfonts/FluidR3_GM.sf2` (location block in `deploy/nginx.conf` — install/reload nginx after adding it), and
`deploy/deploy.sh` syncs it there (sha256-checked) on each deploy. The runtime manifest lists it only for compose
builds (`GBK_SOUNDFONT_SERVER=1`, set by `npm run build:compose`).

## Tests
- `npm run test:server` (runtime, bridge, security, shares). This needs Node 22.
- `npm run test:e2e:composer`: a real server, a deterministic fake OpenAI-compatible model, and a real headless Chrome (no WebMCP). It composes a fugue, renders and validates
  the WAV, does a follow-up edit, then shares and forks the song and checks Explore.
