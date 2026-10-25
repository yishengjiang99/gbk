# GBK Composer ChatGPT launch: final report (2026-10-24)

## Recommendation: **Ready for publication after owner approval**, once the owner uploads the replacement ZIP

Engineering is done for everything the bot can verify. Prod passes the 47-check smoke run, the paid discovery
eval scored 34/34 (a proxy model, not ChatGPT), and the gallery is live. What's left is owner-only: upload the
replacement package (the uploaded `ea1b53c` build lacks the #94 listing metadata and the #99 history-free review
cases), run the review cases in real ChatGPT, then decide on submission. No real-ChatGPT validation has been
claimed: all evidence comes from MCP harnesses, Playwright browsers, Codex, or a proxy model.

## Requirements matrix

| Phase | Status | Evidence |
| --- | --- | --- |
| 1 Reconcile | Complete | #96, `gap-audit.md`, `launch-consistency.test.ts` |
| 2 Acceptance | Complete (automated); ChatGPT parts **unverified** (owner) | #99, `chatgpt-acceptance.md`, harness 41/41 on prod, iPhone WebKit player check |
| 3 Discovery/review | Complete | #99: history-free review cases; eval 34/34, 0% false positives, 27/27 valid args (spend about $2.38 total) |
| 4 Gallery | Complete, with a documented engine gap | #105 + 1171aeb, `gallery.md`. The fugue's voices enter together (stated on the page); the loop seam is unverified |
| 5 Website | Complete | /chatgpt featured demos + gallery, Explore/footer/Studio/song-page links, README section; axe WCAG A/AA: 0 violations on /chatgpt, /chatgpt/gallery, /privacy, /support; canonical/OG/sitemap |
| 6 Analytics | Complete | 6 new aggregate counters, `/chatgpt/install` click redirect, `deploy/funnel.mjs --daily` with ratios, `analytics.md` (including what can't be observed) |
| 7 Docs | Complete | `docs/launch/`: installation, acceptance, gallery, analytics, review-checklist, release-checklist, announcements (drafts, unpublished) |
| 8 CI + smoke | Complete; composer e2e **report-only** | `test.yml` launch-checks job (manifest, deploy package, leak scan, launch tests); `npm run smoke:prod`. 3 Studio e2e specs fail on main already (not launch work) |
| 9 Portal delta | Complete | Uploaded = `ea1b53c` (confirmed by owner). Replacement ZIP built from `d329875`; nothing after it touches the package |

## Uploaded package vs final
Only `plugin.json` (#94 listing: category Entertainment, short description "Compose music, export WAV/MIDI",
purpose paragraph, delete negative case; #99 review cases and starter prompt) and `README.md` (#96 docs) differ.
The candidate ZIP is `gbk-composer-d329875.zip`, built on the bot's machine; the owner uploads it.

## Owner portal checklist
- [ ] Upload the replacement ZIP (or apply the same `plugin.json` edits in the portal form).
- [ ] Check category = Entertainment and the short description; check the 5 positive and 3 negative review cases.
- [ ] Run the review cases in clean ChatGPT conversations (`manual-eval-worksheet.md`).
- [ ] Once the listing URL exists, set `CHATGPT_PLUGIN_URL` in `/etc/gbk-composer.env` to turn on the Install button.
- [ ] Decide on submission and announcements (drafts in `announcements.md`; not posted).

## Incidents
- 2026-10-24 about 20:33 PT: a manual nginx config swap dropped TLS for about a minute. It was restored from backup. The fix (da5b20c)
  keeps the TLS lines in `deploy/nginx.conf` and installs nginx only through `install-nginx.sh` (refuses TLS-less configs, runs `nginx -t`, probes HTTPS, rolls back).
