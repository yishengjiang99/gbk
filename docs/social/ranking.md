# For you ranking (v2)

Code: `server/src/ranking/ranker.ts` (candidates, model, re-rank, training), `server/src/ranking/train-worker.ts` (nightly worker), `server/src/ranking/eval.ts` + `scripts/rank-eval.ts` (offline eval), `server/src/persistence/events.ts`, `server/src/routes/events.ts`, clients `src/components/social/impressions.ts` and `ios/GBKComposer/Core/Analytics/ImpressionLogger.swift`. Issue #110.

## Signals (impressions)
- One impression per song the user settled on in the feed, batched to `POST /api/events` (web: `navigator.sendBeacon`, fetch keepalive fallback; iOS: `client: "ios"`). Flush every 10 events, every 20 s, and when the page/app is hidden.
- Each carries `model_version` (of the feed response), `position`, `feed`, `client`, `session` (per tab / per launch), `dwell_ms`, `listen_ratio`, `completed`, `fast_skip` (default dwell < 2 s), `replay`, `actions`, and optional `scroll_v`.
- `actions` (max `MAX_ACTIONS = 8` per event; unknown ones dropped): `rate`, `comment`, `remix`, `open_studio`, `share`, `like` (a rating of 4+ stars, logged in addition to `rate`), `follow` (reserved: no follow feature yet), `profile_tap` (artist name on a feed card).
- `scroll_v`: scroll speed when the user left the card, px/s (web) or pt/s (iOS, iOS 18+), clamped 0–`MAX_SCROLL_V = 20000`, column `impressions.scroll_v`. Stored only; not a model feature yet.
- Action-only rows (an action outside an open impression) are sent with `position: -1`, `feed: "detail"` and stored as -1.
- Not logged: iOS Simulator builds (CI, UI tests, ios-sim-checks), and web tabs opened with `?noimpressions` (kept for the tab; used by ios-sim-checks' prod screenshots).
- Actor: signed-in user id, else the `gbk_gid` cookie, else the `x-gbk-install` header (iOS guests).
- Limits: 50 events per batch, 30 batches/min per actor, 120/min per IP. Origin is checked for cookie posts.
- Retention: 60 days (nightly prune). Deleted with the account (`SocialStore.purgeUser` deletes every impression row of the actor, all columns).

## Serving pipeline (`Ranker.rank`, in-process)
Catalog: public non-`wip` songs, top `CATALOG_MAX = 5000` by score plus every song published in the last 48 h; cached ≤ 30 s and invalidated when the public set changes.

1. **Actor context, point-in-time** (`asOf`): the actor's impressions before `asOf` (≤ 500, 60 d) give
   - `affinity`: 14-day-decayed preference over tags, labels, artist, instrument family;
   - `session`: the same over the current session (unchanged from v1);
   - `seen`: prior impressions of the song;
   - `coeng`: songs positively engaged by other actors who engaged what this actor liked (30 d).
   Plus `popularity` (point-in-time: `log1p(engaged plays by non-owners in the POP_WINDOW_D = 14 days before t)`, divided by the catalog max) and `freshness` (48 h half-life). `FEATURES = [affinity, coeng, popularity, freshness, session, seen]`.
2. **Candidates: named sources with quotas** (`QUOTAS`): `coeng` 200, `affinity` 250, `artists` 150 (artists the actor engaged positively, liked or followed), `trending` 300 (score), `fresh` (all songs < 48 h, always in, never cut by the cap), `cold` 400 (popularity + freshness, only for actors with no history). Union capped at `POOL_MAX = 1000` (fresh first), backfilled by score. `rank()` returns a song → sources map for debugging; it is not logged.
3. **Session dedup.** With `?session=` (iOS), songs this actor already has impressions for in that session are excluded. Web sends no session, so this is a no-op there.
4. **Value.** With a promoted model (`lr-eng-YYYYMMDD`): `P(engaged)`. Otherwise (no promoted row, a legacy row, or non-finite weights) `HEURISTIC · f`, version `heur-2`. The viewer's own songs get −0.5.
5. **Exploration + cold start.** `EPSILON = 0.12` of slots go to a random lower-ranked song. In every block of `COLD_BLOCK = 8` slots one goes to a cold-start song (< 48 h old, < `COLD_K = 50` impressions) if one is left; it uses that block's exploration draw (or, if none came, the block's last slot, repaid from the next draw), so it is not on top of the epsilon budget.
6. **Variety re-rank (greedy).** At most `MAX_AUTHOR_RUN = 2` in a row by one artist (with a feasibility look-ahead), at most `MAX_LABEL_RUN = 3` in a row sharing **any** label, and near-duplicates (same owner and same remix source or same title) at least `NEAR_DUP_GAP = 50` apart, i.e. at most one per page. The near-dup gap is relaxed first if nothing else fits.
7. **Paging.** The cursor `{r:1, p, sd, t}` carries offset, seed and the first page's time `t`. Later pages rank as of `t` (catalog, features, session-seen set), so pages never duplicate or drop songs. Cursors without `t` rank as of now.

Filtered feeds (`label`, `tag`, or a non-`for_you` sort) keep the SQL path and return `model_version` `heur-1` / `<sort>-1`.

## Training (nightly, 03:30 server time)
- Runs in a `worker_thread` (`trainInWorker`; bundle `server/dist/rank-train.mjs`) with its own `DatabaseSync` on the shares file, once per day (last-run date guard). On success the main `Ranker` reloads the promoted model. In-memory databases (tests) train in-process.
- Data: last 30 days, ≤ 20k impressions. Rows (`trainable`): `feed = for_you`, `position ≥ 0`, `dwell_ms > 0`, not the song's owner, and no scripted swipe bursts (a session with ≥ `BURST_MIN = 20` impressions averaging < 5 s apart). Features are **point-in-time**: computed as of the impression's hour (only earlier impressions, both for history and co-engagement) with the impression's own session; cached per (actor, session, hour). Training duration is logged (`rank_train` log event, `ms`).
- Label: `engaged` (`engaged()` / `engagedSql()`): completed, replay, `listen_ratio ≥ 0.25`, `dwell_ms ≥ 10 000` without a fast skip, or any action.
- Model: one logistic regression on `FEATURES`, fit on standardized features with `L2 = 1.0` (bias unpenalized), stored in raw-feature weights (`{ engaged, auc, auc_heur, win }`).
- Minimums: `MIN_TRAIN = 300` training rows, `MIN_TRAIN_LABELS = 100` engaged and not engaged in train, `MIN_HOLDOUT_LABELS = 30` of each in the holdout. Below them nothing is written and `rank_train_skipped` logs the reason and `labels` (`[pos, neg]`).
- **Time holdout:** the last `HOLDOUT_FRAC = 20%` of rows by time, extended to at least `HOLDOUT_MIN_DAYS = 3`.
- **Gate:** holdout AUC (ties at mean rank) of the candidate, heur-2 (`HEURISTIC · f`) and the current model. Promote iff `auc ≥ max(auc_heur, auc_prev) + PROMOTE_MARGIN (0.02)` and the candidate beats heur-2 in `≥ BOOT_WIN = 90%` of `BOOT_N = 1000` seeded resamples of holdout actors. Every fitted candidate is stored; `promoted = 1` marks the one served model (a new winner retires the old one).
- **Demotion:** a current model whose holdout AUC is below heur-2's is set to `promoted = 0`, so the feed falls back to heur-2.
- Log: `rank_train` with `n`, `holdout`, `labels`, `auc`, `auc_heur`, `auc_prev`, `win`, `promoted`, `demoted`, `serving`, `ms`.
- GBDT: not used. Evaluate a GBDT head with `scripts/rank-eval.ts` once there are more than 20k impressions.

## Offline eval
Read-only (opens the DB with `readOnly: true`). Dev: `node --disable-warning=ExperimentalWarning --import tsx/esm scripts/rank-eval.ts …`; prod bundle: `node server/dist/rank-eval.mjs …` from `/var/www/gbk-composer/current`.
- `--preview`: what tonight's `train()` would decide (labels, holdout, `auc`, `auc_heur`, `auc_prev`, `win`, `promote`, `demote`, weights).
- `--from YYYY-MM-DD --to YYYY-MM-DD [--json]` (default last 3 days): the promoted model, the latest candidate and heur-2 on trainable impressions in the range: engaged AUC, NDCG@10 per session (gain = `signal()`), share of < 48 h songs in the top 10.

## Online metrics
`GET /api/admin/metrics?days=7` (admin only): impressions, sessions, actors, avg dwell, watch time per session, completion/skip/action rates, `engaged_rate`, D1 retention, and `by_model` (each with `engaged`, the training label). After a promotion, compare `by_model` `engaged` for `lr-eng-*` vs `heur-2` over 7 days.

## Privacy
The privacy page (`/privacy`, "Listening activity and your feed") lists what is recorded: song, play time, finished/skipped, scroll speed, and actions (rating, liking, commenting, following, sharing, artist profile taps). It is used only to personalize the feed and measure feed quality in aggregate, not sold or shared with advertisers, kept at most 60 days, and deleted with the account.
