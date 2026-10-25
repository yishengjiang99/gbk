# For you ranking

Code: `server/src/ranking/ranker.ts`, `server/src/persistence/events.ts`, `server/src/routes/events.ts`, client `src/components/social/impressions.ts`.

## Signals (impressions)
- The client logs one impression per song shown in the feed. It sends them with `navigator.sendBeacon` (fetch keepalive as fallback) to `POST /api/events`, flushing on pagehide or visibility change and every 20 events.
- Every impression carries the `model_version` of the feed response that produced it, plus `position`, `feed`, `client`, and `session` (a per-tab random id).
- An impression records `dwell_ms`, `listen_ratio`, `completed`, `fast_skip` (default: dwell < 2 s), and `actions` (rate, comment, remix, open_studio).
- Actor: the signed-in user id, else the `gbk_gid` cookie or the `x-gbk-install` header (iOS).
- Limits: 50 events per batch, 30 batches/min per actor, 120/min per IP. Origin is checked for cookie posts.
- Retention: 60 days (nightly prune). Events are deleted with the account (`purgeUser`).

## Pipeline (in-process; song table cached up to 30 s, invalidated when the public set changes)
1. **Candidates.** Every public non-`wip` song, top 1000 by score. Features per song:
   - `affinity`: decayed (14 d) per-actor preference over tags, labels, artist, and instrument family.
   - `coeng`: item-item co-engagement from other actors who engaged with what this actor liked.
   - `popularity`: score / max score.
   - `freshness`: half-life of 48 h.
   - `session`: same as affinity, current session only.
   - `seen`.
   - Cold start (no history) falls back to popularity + freshness.
2. **Value score.** `w·f`. The weights are `HEURISTIC` (version `heur-2`) until a nightly model exists.
3. **Nightly training (03:30 server time).** Pointwise logistic regression over the last 30 days of impressions (≤ 20k).
   - Label: completed or any action counts as positive; a fast skip or short dwell counts as negative.
   - Training needs at least `MIN_TRAIN = 500` impressions. The model is stored in `rank_models` with version `lr-YYYYMMDD` and holdout AUC.
4. **Re-rank.**
   - Epsilon exploration `EPSILON = 0.12`: a slot goes to a random lower-ranked song.
   - Diversity: max `MAX_AUTHOR_RUN = 2` songs by the same artist in a row, and max `MAX_LABEL_RUN = 3` with the same first label.
   - The viewer's own songs are demoted.
5. **Session-aware next item.** Pass `?session=<id>` to `/api/feed`. Fast skips and long dwell within the session steer the next pages right away; there is no need to wait for training.
6. **Paging.** The ranked list is deterministic for a seed. The cursor `{r:1,p,sd}` carries offset and seed, so pages never repeat or drop songs.

Filtered feeds (`label`, `tag`, or a non-`for_you` sort) keep the original SQL path and return `model_version` `heur-1` / `<sort>-1`.

## Metrics
`GET /api/admin/metrics?days=7` (admin only). It returns overall and `by_model` figures:
- impressions, sessions, actors
- avg dwell, avg watch time per session
- completion rate, skip rate, action rate
- D1 retention (actors seen again on a later day)

Compare models by `model_version`.

## Privacy
The privacy page (`/privacy`, section "Listening activity and your feed") says that listening activity personalizes the feed. It is not sold or shared with advertisers, it is kept for 60 days, and it is deleted with the account.
