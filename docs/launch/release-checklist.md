# Release checklist (build, deploy, rollback, smoke)

Owner policy as of 2026-10-24: launch work goes straight to main after local tests (no PRs).

1. **Test locally:** `npm ci && npm run typecheck && npm test && npm run test:server && npm run build:server && npm run check:launch`.
2. **Rebase:** `git fetch && git rebase origin/main`. If main moved, re-run the tests.
3. **Push:** `git push origin HEAD:main`. CI (`.github/workflows/test.yml`) runs tests and launch checks; composer e2e is report-only.
4. **Deploy:** `DEPLOY_HOST=root@64.23.239.208 deploy/deploy.sh` builds, ships a release, switches `current`, and restarts
   `gbk-composer`. Nginx is installed only through `deploy/install-nginx.sh` (it refuses a config without TLS, runs `nginx -t`, probes HTTPS, and rolls back).
5. **Verify:** `npm run smoke:prod`; check that HTTPS returns 200 on `/`, `/studio`, `/chatgpt`, and `/chatgpt/gallery`; confirm `/studio` has zero vertical scroll (desktop and phone).
6. **Rollback:** `deploy/ops.sh rollback` (switches `current` back to the previous release and restarts). For nginx, the backup is `/etc/nginx/sites-available/compose.grepawk.com.bak.<timestamp>`.
7. **Package:** if anything under `plugins/gbk-composer/` changed, record it in `portal-package-delta.md` and build a ZIP for the owner. Never upload it yourself.
8. **Paid eval (manual only, never in CI):** see `docs/plugin-discovery-eval.md` (runs on the server, about $0.75 per run).
