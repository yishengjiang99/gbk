# For you ranking (v2)

Code: `server/src/ranking/ranker.ts` (candidates, model, re-rank, training), `server/src/ranking/train-worker.ts` (nightly worker), `server/src/ranking/eval.ts` + `scripts/rank-eval.ts` (offline eval), `server/src/persistence/events.ts`, `server/src/routes/events.ts`, clients `src/components/social/impressions.ts` and `ios/GBKComposer/Core/Analytics/ImpressionLogger.swift`. Issue #110.

## Signals (impressions)
- One impression per song the user settled on in the feed, batched to `POST /api/events` (web: `navigator.sendBeacon`, fetch keepalive fallback; iOS: `client: "ios"`). Flush every 10 events, every 20 s, and when the page/app is hidden.
- Each carries `model_version` (of the feed response), `position`, `feed`, `client`, `session` (per tab / per launch), `dwell_ms`, `listen_ratio`, `completed`, `fast_skip` (default dwell < 2 s), `replay`, `actions`, and optional `scroll_v`.
- `actions` (max `MAX_ACTIONS = 8` per event; unknown ones dropped): `rate`, `comment`, `remix`, `open_studio`, `share`, `like` (a rating of 4+ stars, logged in addition to `rate`), `follow` (reserved: no follow feature yet), `profile_tap` (artist name on a feed card).
- `scroll_v`: scroll speed when the user left the card, px/s (web) or pt/s (iOS, iOS 18+), clamped 0–`MAX_SCROLL_V = 20000`, column `impressions.scroll_v`. Stored only; not a model feature yet.
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
   Plus `popularity` (score / max) and `freshness` (48 h half-life). `FEATURES = [affinity, coeng, popularity, freshness, session, seen]`.
2. **Candidates: named sources with quotas** (`QUOTAS`): `coeng` 200, `affinity` 250, `artists` 150 (artists the actor engaged positively, liked or followed), `trending` 300 (score), `fresh` (all songs < 48 h, always in, never cut by the cap), `cold` 400 (popularity + freshness, only for actors with no history). Union capped at `POOL_MAX = 1000` (fresh first), backfilled by score. `rank()` returns a song → sources map for debugging; it is not logged.
3. **Session dedup.** With `?session=` (iOS), songs this actor already has impressions for in that session are excluded. Web sends no session, so this is a no-op there.
4. **Value.** Before any model exists: `HEURISTIC · f` (version `heur-2`). With a promoted model (`lr2-YYYYMMDD`): `P(complete) · min(duration_s, 180)/180 − SKIP_LAMBDA · P(fast_skip)`, `SKIP_LAMBDA = 1.0`. Duration comes from `project_json` (last note end through the tempo map), median duration as fallback. The viewer's own songs get −0.5.
5. **Exploration + cold start.** `EPSILON = 0.12` of slots go to a random lower-ranked song. In every block of `COLD_BLOCK = 8` slots one goes to a cold-start song (< 48 h old, < `COLD_K = 50` impressions) if one is left; it uses that block's exploration draw (or, if none came, the block's last slot, repaid from the next draw), so it is not on top of the epsilon budget.
6. **Variety re-rank (greedy).** At most `MAX_AUTHOR_RUN = 2` in a row by one artist (with a feasibility look-ahead), at most `MAX_LABEL_RUN = 3` in a row sharing **any** label, and near-duplicates (same owner and same remix source or same title) at least `NEAR_DUP_GAP = 50` apart, i.e. at most one per page. The near-dup gap is relaxed first if nothing else fits.
7. **Paging.** The cursor `{r:1, p, sd, t}` carries offset, seed and the first page's time `t`. Later pages rank as of `t` (catalog, features, session-seen set), so pages never duplicate or drop songs. Cursors without `t` rank as of now.

Filtered feeds (`label`, `tag`, or a non-`for_you` sort) keep the SQL path and return `model_version` `heur-1` / `<sort>-1`.

## Training (nightly, 03:30 server time)
- Runs in a `worker_thread` (`trainInWorker`; bundle `server/dist/rank-train.mjs`) with its own `DatabaseSync` on the shares file, once per day (last-run date guard). On success the main `Ranker` reloads the promoted model. In-memory databases (tests) train in-process.
- Data: last 30 days, ≤ 20k impressions, at least `MIN_TRAIN = 500`. Features are **point-in-time**: computed as of the impression's hour (only earlier impressions, both for history and co-engagement) with the impression's own session; cached per (actor, session, hour). Training duration is logged (`rank_train` log event, `ms`).
- Labels: complete = `completed` or `replay` or `listen_ratio ≥ 0.9`; fast skip = `fast_skip` (dwell < 2 s).
- Two pointwise logistic-regression heads on the same features: P(complete), P(fast skip).
- **Time-split holdout:** the last `HOLDOUT_DAYS = 3` are held out; the rest trains. `rank_models.auc` stores the holdout AUC of the complete head (the skip head's is in the stored model as `auc_skip`).
- **Promotion gate:** every candidate is stored (`rank_models.promoted` 0/1). It is promoted only if there is no promoted lr2 model yet, or both heads' holdout AUC are ≥ the promoted model's AUC on the same holdout (HEURISTIC and legacy single-head rows count as no model). Startup loads the latest promoted model.
- GBDT: not used. Evaluate a GBDT head with `scripts/rank-eval.ts` once there are more than 20k impressions.

## Offline eval
`node --disable-warning=ExperimentalWarning --import tsx/esm scripts/rank-eval.ts --db /var/lib/gbk-composer/shares.sqlite --from 2026-10-20 --to 2026-10-25 [--json]` (read-only; defaults: last 3 days, `$COMPOSER_DATA_DIR/shares.sqlite`). It compares the promoted model, the latest candidate and HEURISTIC on impressions in the range with point-in-time features:
- AUC per head (P(complete), P(fast skip));
- NDCG@10 per session: each session's shown songs re-ranked by the model's value, gain = `signal()`;
- share of < 48 h songs in the top 10.

## Online metrics
`GET /api/admin/metrics?days=7` (admin only), unchanged: impressions, sessions, actors, avg dwell, watch time per session, completion/skip/action rates, D1 retention, and `by_model`.

## Privacy
The privacy page (`/privacy`, "Listening activity and your feed") lists what is recorded: song, play time, finished/skipped, scroll speed, and actions (rating, liking, commenting, following, sharing, artist profile taps). It is used only to personalize the feed and measure feed quality in aggregate, not sold or shared with advertisers, kept at most 60 days, and deleted with the account.
