// Personalized "For you" ranking (docs/social/ranking.md). Small and in-process:
//   1. candidate generation: named sources with quotas (coeng, affinity, artists, trending, fresh < 48 h always in,
//      cold = popularity + freshness for actors with no history); union capped at POOL_MAX.
//   2. pointwise value: P(engaged) from the nightly LR model (lr-eng) once it beats heur-2 on the holdout,
//      otherwise HEURISTIC weights · features (heur-2).
//   3. re-rank: freshness boost, ~12% epsilon exploration, diversity (max 2 in a row per artist, max 3 per label).
//   4. session-aware: impressions from the current session (fast skips / long dwell) steer tags and artists.
import type { DatabaseSync } from "node:sqlite";

export const FEATURES = ["affinity", "coeng", "popularity", "freshness", "session", "seen"] as const;
export type Weights = Record<(typeof FEATURES)[number], number> & { bias: number };
export const HEURISTIC: Weights = { bias: 0, affinity: 1.0, coeng: 0.8, popularity: 0.6, freshness: 0.4, session: 1.2, seen: -0.6 };
/** Learned model (lr-eng): one L2-regularized LR on raw features; value = P(engaged). Gate stats are stored with it. */
export interface Model { engaged: Weights; auc?: number | null; auc_heur?: number | null; win?: number | null; l2?: number }
const sig = (z: number) => 1 / (1 + Math.exp(-z));
/** A stored model is usable only with an `engaged` head whose weights are all finite (else heur-2). */
export function parseModel(json: string): Model | null {
  try { const m = JSON.parse(json) as Partial<Model>; const w = m.engaged; return w && ["bias", ...FEATURES].every((k) => Number.isFinite(w[k as keyof Weights])) ? (m as Model) : null; } catch { return null; }
}
/** Engaged (approved 2026-11-10): completed, replay, >= 25% listened, >= 10 s on the card without a fast skip, or any action. */
export const engaged = (i: { completed: number | boolean; replay?: number | boolean; listen_ratio?: number; dwell_ms: number; fast_skip: number | boolean; actions: string }) =>
  i.completed || i.replay || (i.listen_ratio ?? 0) >= 0.25 || (i.dwell_ms >= 10_000 && !i.fast_skip) || i.actions !== "[]" ? 1 : 0;
/** Graded training target in [0, 1], monotonic in dwell and in listen_ratio (the binary `engaged` stays the eval label):
 *  completion, replay or any action = 1; else max(dwell grade, listen grade). Dwell grade: 0 on a fast skip, else
 *  log(dwell / 2 s) / log(60 s / 2 s) clamped to [0, 1] (3 s 0.12, 5 s 0.27, 10 s 0.47, 30 s 0.80, >= 60 s 1).
 *  Listen grade: listen_ratio / 0.5 clamped (25% 0.5, >= 50% 1). */
export const GRADE_DWELL_MIN_MS = 2000, GRADE_DWELL_CAP_MS = 60_000, GRADE_RATIO_CAP = 0.5;
export function grade(i: { completed: number | boolean; replay?: number | boolean; listen_ratio?: number; dwell_ms: number; fast_skip: number | boolean; actions: string }) {
  if (i.completed || i.replay || i.actions !== "[]") return 1;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const d = i.fast_skip || i.dwell_ms <= GRADE_DWELL_MIN_MS ? 0 : clamp(Math.log(i.dwell_ms / GRADE_DWELL_MIN_MS) / Math.log(GRADE_DWELL_CAP_MS / GRADE_DWELL_MIN_MS));
  return Math.max(d, clamp((i.listen_ratio ?? 0) / GRADE_RATIO_CAP));
}
/** Same rule in SQL; `p` is the table alias prefix, e.g. "i.". */
export const engagedSql = (p = "") => `(${p}completed = 1 OR ${p}replay = 1 OR ${p}listen_ratio >= 0.25 OR (${p}dwell_ms >= 10000 AND ${p}fast_skip = 0) OR ${p}actions <> '[]')`;
/** Popularity feature: engaged impressions by others in the POP_WINDOW_D days before t. */
export const POP_WINDOW_D = 14;
/** Scripted swipe bursts (CI/UI tests): a session with >= BURST_MIN impressions averaging < BURST_GAP_MS apart. */
export const BURST_MIN = 20, BURST_GAP_MS = 5000;
export type Imp = { actor: string; session: string; share_id: string; dwell_ms: number; listen_ratio: number; completed: number; fast_skip: number; replay: number; actions: string; created_at: number; feed: string; position: number; client?: string };
/** iOS Simulator builds (CI, UI tests) logged prod impressions until release 5c9e6ca (2026-11-11 03:09 UTC): every run was a
 *  fresh install with one first-card impression whose dwell is test timing, and they were ~60% of earlier rows. Such
 *  rows (an iOS actor with one impression in the window, before this time) are not trainable. Ages out by 2026-12-11. */
export const CI_IMPRESSIONS_STOPPED = Date.UTC(2026, 10, 11, 3, 10);
/** Training/eval rows: For you only, dwell > 0 (not action-only), no scripted bursts, no pre-fix iOS CI installs. Self-impressions are dropped in dataset(). */
export function trainable(imps: Imp[]): Imp[] {
  const per = new Map<string, number>(); for (const i of imps) per.set(i.actor, (per.get(i.actor) ?? 0) + 1);
  const ci = (i: Imp) => i.client === "ios" && Number(i.created_at) < CI_IMPRESSIONS_STOPPED && per.get(i.actor) === 1;
  const by = new Map<string, Imp[]>(); for (const i of imps) if (!ci(i) && i.feed === "for_you" && i.position >= 0 && i.dwell_ms > 0) (by.get(`${i.actor}\u0001${i.session}`) ?? by.set(`${i.actor}\u0001${i.session}`, []).get(`${i.actor}\u0001${i.session}`)!).push(i);
  const out: Imp[] = [];
  for (const g of by.values()) { const ts = g.map((i) => Number(i.created_at)); if (g.length >= BURST_MIN && Math.max(...ts) - Math.min(...ts) < g.length * BURST_GAP_MS) continue; out.push(...g); }
  return out.sort((a, b) => Number(a.created_at) - Number(b.created_at));
}
export const IMP_COLS = "actor, session, share_id, dwell_ms, listen_ratio, completed, fast_skip, replay, actions, created_at, feed, position, client";
export const EPSILON = 0.12, MAX_AUTHOR_RUN = 2, MAX_LABEL_RUN = 3, FRESH_HALF_LIFE_H = 48;

/** Signal weight of one impression: completion/dwell/actions positive, fast skip negative. */
export const signal = (i: { dwell_ms: number; completed: number; fast_skip: number; actions: string }) =>
  (i.fast_skip ? -1 : 0) + (i.completed ? 1 : 0) + (i.dwell_ms >= 10_000 ? 0.5 : 0) + (i.actions !== "[]" ? 1.5 : 0);

export const SOURCES = ["coeng", "affinity", "artists", "trending", "fresh", "cold"] as const;
export type Source = (typeof SOURCES)[number];
/** Per-source candidate quotas (fresh: everything < FRESH_WINDOW_H, uncapped). */
export const QUOTAS: Record<Source, number> = { coeng: 200, affinity: 250, artists: 150, trending: 300, fresh: Infinity, cold: 400 };
/** Cold start: one slot per COLD_BLOCK for a song < 48 h old with < COLD_K impressions. Near-dups: >= NEAR_DUP_GAP apart (max page size), so at most 1 per page. */
export const COLD_K = 50, COLD_BLOCK = 8, NEAR_DUP_GAP = 50;
export const POOL_MAX = 1000, CATALOG_MAX = 5000, FRESH_WINDOW_H = 48;
interface Ctx { t: number; pop: Map<string, number>; pref: Map<string, number>; sess: Map<string, number>; seen: Map<string, number>; co: Map<string, number>; artists: Map<string, number>; history: number; maxScore: number; maxCo: number }
const keysOf = (s: Song) => [...s.tags.map((x) => `t:${x}`), ...s.labels.map((x) => `l:${x}`), `a:${s.owner}`, ...s.fam.map((x) => `f:${x}`)];
const sq = (m: Map<string, number>, s: Song) => { let v = 0; for (const k of keysOf(s)) v += m.get(k) ?? 0; return Math.tanh(v / 3); };
interface Song { id: string; owner: string; title: string; parent: string | null; score: number; published_at: number; tags: string[]; labels: string[]; fam: string[]; dur: number }
/** Song length in seconds from project_json (last note end through the tempo map); null if unknown. */
export function projectSeconds(p: { ppq?: number; tempos?: { tick: number; microPerQuarter: number }[]; notes?: { tick: number; duration: number }[] }): number | null {
  const ppq = p.ppq || 480; const end = Math.max(0, ...(p.notes ?? []).map((n) => n.tick + n.duration)); if (!end) return null;
  const ts = [...(p.tempos?.length ? p.tempos : [{ tick: 0, microPerQuarter: 500000 }])].sort((a, b) => a.tick - b.tick); let sec = 0;
  for (let i = 0; i < ts.length; i++) { const a = Math.max(ts[i].tick, i ? ts[i].tick : 0), b = Math.min(end, ts[i + 1]?.tick ?? end); if (b > a) sec += ((b - a) / ppq) * (ts[i].microPerQuarter / 1e6); }
  if (ts[0].tick > 0) sec += (Math.min(end, ts[0].tick) / ppq) * 0.5; return sec;
}
const rng = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export class Ranker {
  weights: Weights = { ...HEURISTIC }; model: Model | null = null; version = "heur-2"; private cache: { at: number; key: string; songs: Song[] } | null = null;
  constructor(private db: DatabaseSync, private now: () => number = Date.now) {
    // promoted: 1 = the served model (at most one), 0 = lost the gate, retired or demoted. No write when the schema exists (read-only eval).
    const cols = (this.db.prepare("PRAGMA table_info(rank_models)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.length) this.db.exec("CREATE TABLE rank_models (version TEXT PRIMARY KEY, weights TEXT NOT NULL, n INTEGER NOT NULL, auc REAL, created_at INTEGER NOT NULL, promoted INTEGER)");
    else if (!cols.includes("promoted")) this.db.exec("ALTER TABLE rank_models ADD COLUMN promoted INTEGER");
    this.reload();
  }
  /** Serve the latest promoted model; none, a legacy row or bad (NaN) weights fall back to heur-2. */
  reload() { const p = this.promoted(); this.weights = { ...HEURISTIC }; this.model = p?.model ?? null; this.version = p?.version ?? "heur-2"; }
  promoted() {
    const r = this.db.prepare("SELECT version, weights, created_at FROM rank_models WHERE promoted = 1 ORDER BY created_at DESC LIMIT 1").get() as { version: string; weights: string; created_at: number } | undefined;
    const model = r ? parseModel(r.weights) : null; return r && model ? { version: r.version, model, at: Number(r.created_at) } : null;
  }
  /** Catalog: public non-wip songs, the top CATALOG_MAX by score plus every song published in the last FRESH_WINDOW_H. */
  private songs(): Song[] {
    // Cheap freshness key so a just-published / unpublished song shows up (or disappears) immediately.
    const k = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(COALESCE(published_at, created_at)), 0) AS m, COALESCE(SUM(score), 0) AS sc FROM shares WHERE public = 1").get() as { n: number; m: number; sc: number };
    const key = `${k.n}:${k.m}:${Math.round(Number(k.sc))}`;
    if (this.cache && this.cache.key === key && this.now() - this.cache.at < 30_000) return this.cache.songs;
    const nowt = this.now();
    const rows = this.db.prepare(`SELECT s.id, s.owner, s.title, s.parent_id, s.score, COALESCE(s.published_at, s.created_at) AS pub, s.labels, s.project_json AS project FROM shares s
      WHERE s.public = 1 AND NOT EXISTS (SELECT 1 FROM json_each(s.labels) WHERE value = 'wip') AND (s.id IN (SELECT id FROM shares WHERE public = 1 ORDER BY score DESC LIMIT ?) OR COALESCE(s.published_at, s.created_at) > ?)
      ORDER BY s.score DESC`).all(CATALOG_MAX, nowt - FRESH_WINDOW_H * 3_600_000) as { id: string; owner: string; title: string; parent_id: string | null; score: number; pub: number; labels: string; project: string | null }[];
    const tags = new Map<string, string[]>(); for (const t of this.db.prepare("SELECT share_id, tag FROM share_tags").all() as { share_id: string; tag: string }[]) (tags.get(t.share_id) ?? tags.set(t.share_id, []).get(t.share_id)!).push(t.tag);
    const fam = (j: { tracks?: { program?: number; channel?: number }[] }) => [...new Set((j.tracks ?? []).map((t) => t.channel === 9 ? "drums" : `gm${Math.floor((t.program ?? 0) / 8)}`))];
    const songs: Song[] = rows.map((r) => { let j: Parameters<typeof projectSeconds>[0] & { tracks?: { program?: number; channel?: number }[] } = {}; try { j = JSON.parse(r.project ?? "{}"); } catch { /* bad json */ }
      return { id: r.id, owner: r.owner, title: r.title, parent: r.parent_id, score: Number(r.score), published_at: Number(r.pub), tags: tags.get(r.id) ?? [], labels: JSON.parse(r.labels || "[]") as string[], fam: fam(j), dur: projectSeconds(j) ?? NaN }; });
    const known = songs.map((x) => x.dur).filter((d) => Number.isFinite(d)).sort((a, b) => a - b); const median = known.length ? known[Math.floor(known.length / 2)] : 60;
    for (const x of songs) if (!Number.isFinite(x.dur)) x.dur = median;
    this.cache = { at: this.now(), key, songs }; return songs;
  }
  invalidate() { this.cache = null; }

  /** Actor context, point-in-time: only impressions before `asOf`. */
  private context(actor: string | null, session: string | null, t: number, songs: Song[]): Ctx {
    const hist = actor ? this.db.prepare("SELECT share_id, dwell_ms, completed, fast_skip, actions, session, created_at FROM impressions WHERE actor = ? AND created_at > ? AND created_at < ? ORDER BY id DESC LIMIT 500").all(actor, t - 60 * 86_400_000, t) as { share_id: string; dwell_ms: number; completed: number; fast_skip: number; actions: string; session: string; created_at: number }[] : [];
    const byId = new Map(songs.map((s) => [s.id, s]));
    const pref = new Map<string, number>(), sess = new Map<string, number>(), seen = new Map<string, number>(), liked: string[] = [], artists = new Map<string, number>();
    for (const h of hist) {
      const s = byId.get(h.share_id); const w = signal(h); seen.set(h.share_id, (seen.get(h.share_id) ?? 0) + 1); if (w > 0) liked.push(h.share_id);
      if (!s) continue; const keys = keysOf(s);
      const decay = Math.exp(-(t - h.created_at) / (14 * 86_400_000));
      for (const k of keys) pref.set(k, (pref.get(k) ?? 0) + w * decay);
      if (session && h.session === session) for (const k of keys) sess.set(k, (sess.get(k) ?? 0) + w);
      // artists source: positive engagement, plus explicit like/follow actions
      const acts = h.actions === "[]" ? [] : (JSON.parse(h.actions) as string[]);
      if (w > 0 || acts.includes("like") || acts.includes("follow")) artists.set(s.owner, (artists.get(s.owner) ?? 0) + w * decay + (acts.includes("follow") ? 2 : acts.includes("like") ? 1 : 0));
    }
    // item-item co-engagement: songs positively engaged by actors who positively engaged what this actor liked
    const co = new Map<string, number>();
    if (liked.length) {
      const ids = [...new Set(liked)].slice(0, 50); const ph = ids.map(() => "?").join(",");
      for (const r of this.db.prepare(`SELECT i2.share_id AS id, COUNT(DISTINCT i2.actor) AS n FROM impressions i1 JOIN impressions i2 ON i2.actor = i1.actor AND i2.share_id <> i1.share_id
        WHERE i1.share_id IN (${ph}) AND i1.actor <> ? AND (i1.completed = 1 OR i1.actions <> '[]') AND (i2.completed = 1 OR i2.actions <> '[]') AND i1.created_at > ? AND i1.created_at < ? AND i2.created_at < ? GROUP BY i2.share_id ORDER BY n DESC LIMIT 200`).all(...ids, actor!, t - 30 * 86_400_000, t, t) as { id: string; n: number }[]) co.set(r.id, Number(r.n));
    }
    return { t, pop: this.popularity(t), pref, sess, seen, co, artists, history: hist.length, maxScore: Math.max(1e-9, ...songs.map((s) => s.score)), maxCo: Math.max(1, ...co.values()) };
  }
  private popCache = new Map<number, Map<string, number>>();
  /** Point-in-time popularity: log1p(engaged impressions by non-owners in [t - POP_WINDOW_D, t)) / max over songs. */
  private popularity(t: number) {
    let m = this.popCache.get(t); if (m) return m;
    const rows = this.db.prepare(`SELECT i.share_id AS id, COUNT(*) AS n FROM impressions i JOIN shares s ON s.id = i.share_id WHERE i.created_at >= ? AND i.created_at < ? AND i.actor <> s.owner AND ${engagedSql("i.")} GROUP BY i.share_id`).all(t - POP_WINDOW_D * 86_400_000, t) as { id: string; n: number }[];
    const max = Math.log1p(Math.max(0, ...rows.map((r) => Number(r.n)))); m = new Map(rows.map((r) => [r.id, max > 0 ? Math.log1p(Number(r.n)) / max : 0]));
    if (this.popCache.size > 256) this.popCache.clear(); this.popCache.set(t, m); return m;
  }
  private feat(c: Ctx, s: Song) {
    return { affinity: sq(c.pref, s), coeng: (c.co.get(s.id) ?? 0) / c.maxCo, popularity: c.pop.get(s.id) ?? 0, freshness: Math.pow(0.5, Math.max(0, c.t - s.published_at) / (FRESH_HALF_LIFE_H * 3_600_000)), session: sq(c.sess, s), seen: Math.min(1, (c.seen.get(s.id) ?? 0) / 2) };
  }
  /** Per-song feature vectors for one actor (and current session), point-in-time: only impressions before `asOf`. */
  features(actor: string | null, session: string | null, asOf?: number, songs = this.songs(), only?: Song) {
    const c = this.context(actor, session, asOf ?? this.now(), songs);
    return (only ? [only] : songs).map((s) => ({ song: s, f: this.feat(c, s), history: c.history }));
  }
  /** Candidate generation: named sources, each capped by its QUOTAS entry; `fresh` always contributes in full.
   *  Union capped at POOL_MAX (fresh first), backfilled by score. Returns the pool and a song -> sources map. */
  candidates(c: Ctx, songs: Song[]) {
    const src = new Map<string, Source[]>(); const add = (name: Source, ids: string[]) => { for (const id of ids.slice(0, QUOTAS[name])) (src.get(id) ?? src.set(id, []).get(id)!).push(name); };
    const top = (xs: Song[], f: (s: Song) => number) => xs.map((s) => [s, f(s)] as const).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).map((x) => x[0].id);
    const fresh = songs.filter((s) => c.t - s.published_at < FRESH_WINDOW_H * 3_600_000).sort((a, b) => b.published_at - a.published_at).map((s) => s.id);
    add("fresh", fresh);
    add("coeng", [...c.co.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]));
    add("affinity", top(songs, (s) => sq(c.pref, s)));
    add("artists", top(songs, (s) => c.artists.get(s.owner) ?? 0));
    add("trending", songs.map((s) => s.id)); // songs() is score-ordered
    if (c.history === 0) add("cold", top(songs, (s) => s.score / c.maxScore + Math.pow(0.5, Math.max(0, c.t - s.published_at) / (FRESH_HALF_LIFE_H * 3_600_000))));
    const pool = new Set<string>(fresh); // fresh is never cut by the cap
    for (const id of src.keys()) { if (pool.size >= POOL_MAX) break; pool.add(id); }
    for (const s of songs) { if (pool.size >= POOL_MAX) break; if (!pool.has(s.id)) { pool.add(s.id); (src.get(s.id) ?? src.set(s.id, []).get(s.id)!).push("trending"); } }
    return { pool, sources: src };
  }
  /** Score: P(engaged) with a learned model, else HEURISTIC w·f. */
  value(f: Record<string, number>, m: Model | null = this.model, w = this.weights) {
    const x = FEATURES.map((k) => f[k] ?? 0); return m ? sig(lin(x, m.engaged)) : lin(x, w);
  }

  /** Full ranked id list for an actor; deterministic for (seed, asOf) so pages never duplicate or drop songs: the
   *  catalog, features and the session's already-seen set are all taken as of `asOf` (the first page's time).
   *  `sources` is for debugging only (not logged). */
  rank(o: { actor: string | null; session: string | null; seed: number; viewer?: string | null; asOf?: number }): { ids: string[]; owners: Map<string, string>; version: string; cold: boolean; sources: Map<string, Source[]> } {
    const t = o.asOf ?? this.now(); const songs = this.songs().filter((s) => s.published_at <= t);
    const c = this.context(o.actor, o.session, t, songs); const r = rng(o.seed); const cold = c.history === 0;
    const { pool, sources } = this.candidates(c, songs);
    // no repeats within a session (iOS passes ?session=; web does not, so this is a no-op there)
    if (o.actor && o.session) for (const x of this.db.prepare("SELECT DISTINCT share_id FROM impressions WHERE actor = ? AND session = ? AND created_at < ?").all(o.actor, o.session, t) as { share_id: string }[]) pool.delete(x.share_id);
    // Songs this actor already saw rank after every unseen one: their own impressions raise popularity and affinity
    // more than the capped `seen` penalty lowers them, so a top song would otherwise lead every new session.
    const scored = songs.filter((s) => pool.has(s.id)).map((s) => ({ s, seen: c.seen.has(s.id) ? 1 : 0, v: this.value(this.feat(c, s)) + (s.owner === o.viewer ? -0.5 : 0) + r() * 1e-3 }));
    scored.sort((a, b) => a.seen - b.seen || b.v - a.v);
    // cold-start candidates: < FRESH_WINDOW_H old with < COLD_K impressions in total (as of t)
    const young = scored.filter((x) => t - x.s.published_at < FRESH_WINDOW_H * 3_600_000).map((x) => x.s.id);
    const imps = new Map<string, number>(); if (young.length) for (const x of this.db.prepare(`SELECT share_id, COUNT(*) AS n FROM impressions WHERE share_id IN (${young.map(() => "?").join(",")}) AND created_at < ? GROUP BY share_id`).all(...young, t) as { share_id: string; n: number }[]) imps.set(x.share_id, Number(x.n));
    const isCold = (s: Song) => t - s.published_at < FRESH_WINDOW_H * 3_600_000 && (imps.get(s.id) ?? 0) < COLD_K;
    // exploration: ~EPSILON of the slots go to random lower-ranked (often new / untried) songs. In every block of
    // COLD_BLOCK slots one slot goes to a cold-start song (if any is left); it is taken out of the epsilon budget.
    const out: Song[] = []; const rest = scored.map((x) => x.s); let blockCold = false, debt = 0;
    while (rest.length) {
      const slot = out.length; if (slot % COLD_BLOCK === 0) blockCold = false;
      let explore = r() < EPSILON && rest.length > 3; if (explore && debt > 0) { debt--; explore = false; }
      const ci = blockCold ? -1 : rest.findIndex(isCold); let i: number;
      if (ci === 0 || (ci > 0 && explore)) i = ci; // the cold slot uses this exploration draw
      else if (ci > 0 && slot % COLD_BLOCK === COLD_BLOCK - 1) { i = ci; debt++; } // forced at the block end, repaid from the next draw
      else i = explore ? 1 + Math.floor(r() * (rest.length - 1)) : 0;
      const s = rest.splice(i, 1)[0]; if (isCold(s)) blockCold = true; out.push(s);
    }
    // diversity re-rank (greedy): never > MAX_AUTHOR_RUN in a row by one artist, never > MAX_LABEL_RUN in a row sharing
    // any label, and near-duplicates (same owner + same remix source or same title) at least NEAR_DUP_GAP apart.
    const res: Song[] = []; const left = out;
    const near = (a: Song, b: Song) => a.owner === b.owner && ((!!a.parent && a.parent === b.parent) || a.title.trim().toLowerCase() === b.title.trim().toLowerCase());
    const ok = (s: Song) => { const n = res.length; const a = res.slice(Math.max(0, n - MAX_AUTHOR_RUN)); const l = res.slice(Math.max(0, n - MAX_LABEL_RUN));
      if (a.length === MAX_AUTHOR_RUN && a.every((x) => x.owner === s.owner)) return false;
      if (l.length === MAX_LABEL_RUN && s.labels.some((lb) => l.every((x) => x.labels.includes(lb)))) return false;
      return !res.slice(Math.max(0, n - NEAR_DUP_GAP + 1)).some((x) => near(x, s)); };
    const okLoose = (s: Song) => { const n = res.length; const a = res.slice(Math.max(0, n - MAX_AUTHOR_RUN)); const l = res.slice(Math.max(0, n - MAX_LABEL_RUN));
      return !(a.length === MAX_AUTHOR_RUN && a.every((x) => x.owner === s.owner)) && !(l.length === MAX_LABEL_RUN && s.labels.some((lb) => l.every((x) => x.labels.includes(lb)))); };
    while (left.length) {
      // Feasibility: if one artist dominates what is left, place them now (when allowed) so the tail is not forced into a run > MAX_AUTHOR_RUN.
      const cnt = new Map<string, number>(); for (const x of left) cnt.set(x.owner, (cnt.get(x.owner) ?? 0) + 1);
      const [top, cn] = [...cnt.entries()].sort((x, y) => y[1] - x[1])[0]; const others = left.length - cn;
      let i = cn > MAX_AUTHOR_RUN * others ? left.findIndex((x) => x.owner === top && ok(x)) : -1;
      if (i === -1) i = left.findIndex(ok);
      if (i === -1) i = left.findIndex(okLoose); // near-dup gap is the first rule to give when nothing else fits
      res.push(left.splice(i === -1 ? 0 : i, 1)[0]);
    }
    return { ids: res.map((s) => s.id), owners: new Map(res.map((s) => [s.id, s.owner])), version: this.version, cold, sources };
  }

  /** Nightly: fit, gate, store. Every fitted candidate is stored; promoted only if it clearly beats heur-2 and the
   *  current model on the holdout (see gate()). A current model that now loses to heur-2 is demoted. */
  train(): TrainResult | TrainSkip {
    const t0 = Date.now(); const g = this.gate(); if ("skipped" in g) return g;
    const { model, cur, promote, demote } = g; const t = this.now();
    let version = `lr-eng-${new Date(t).toISOString().slice(0, 10).replace(/-/g, "")}`; if (cur?.version === version && !promote) version += "-c";
    this.db.prepare("INSERT OR REPLACE INTO rank_models (version, weights, n, auc, created_at, promoted) VALUES (?,?,?,?,?,?)").run(version, JSON.stringify(model), g.n, model.auc ?? null, t, promote ? 1 : 0);
    // promoted = 1 marks the one served model: a new winner retires the old one; a demoted one goes back to heur-2
    if (promote || demote) this.db.prepare("UPDATE rank_models SET promoted = 0 WHERE promoted = 1 AND version <> ?").run(promote ? version : "");
    this.reload();
    return { version, n: g.n, holdout: g.holdout, labels: g.labels, auc: g.auc, auc_heur: g.auc_heur, auc_prev: g.auc_prev, win: g.win, lift: g.lift, lift_ci: g.lift_ci, l2: g.l2, cv: g.cv, folds: g.folds, prev: g.prev, promoted: promote, demoted: demote ? cur!.version : null, previous: cur?.version ?? null, ms: Date.now() - t0, model };
  }
  /** Fit + gate decision without writing (train() and the rank-eval --preview). Out-of-time evaluation by forward
   *  chaining: the last EVAL_FRAC of rows by time (at least HOLDOUT_MIN_DAYS) is cut into EVAL_FOLDS consecutive blocks,
   *  each scored by a model fit only on earlier rows (its L2 chosen by CV on those rows), and the blocks are pooled.
   *  Promote iff pooled AUC >= heur-2 + PROMOTE_MARGIN and the candidate beats heur-2 in >= BOOT_WIN of BOOT_N seeded
   *  resamples of evaluated actors, with the 95% lift interval above 0. The stored model is fit on all rows.
   *  The current model was fit on rows before its created_at, so it is judged only on evaluated rows after that (`prev`),
   *  once they hold MIN_HOLDOUT_LABELS of each label: there the candidate must also beat it by PROMOTE_MARGIN, and it is
   *  demoted if it loses to heur-2. Until then it is neither compared nor demoted. */
  gate(): Gate | TrainSkip {
    const t = this.now();
    const imps = trainable(this.db.prepare(`SELECT ${IMP_COLS} FROM impressions WHERE created_at > ? AND created_at < ? ORDER BY id DESC LIMIT 20000`).all(t - 30 * 86_400_000, t) as Imp[]);
    if (imps.length < MIN_TRAIN) return { skipped: "few_impressions", impressions: imps.length, n: 0, holdout: 0, min: MIN_TRAIN };
    const rows = this.dataset(imps, Infinity).tr.sort((a, b) => a.at - b.at);
    const start = rows.length ? Math.min(rows[Math.floor(rows.length * (1 - EVAL_FRAC))].at, t - HOLDOUT_MIN_DAYS * 86_400_000) : t;
    const tr = rows.filter((r) => r.at < start), ho = rows.filter((r) => r.at >= start); const cnt = (rs: Row[]) => { const p = rs.filter((d) => d.y).length; return [p, rs.length - p]; };
    const labels = { train: cnt(tr), holdout: cnt(ho) }; const base = { impressions: imps.length, n: rows.length, holdout: ho.length, labels };
    if (rows.length < MIN_TRAIN) return { skipped: "few_train_rows", ...base, min: MIN_TRAIN };
    if (labels.train.some((v) => v < MIN_TRAIN_LABELS)) return { skipped: "few_train_labels", ...base, min: MIN_TRAIN_LABELS };
    if (labels.holdout.some((v) => v < MIN_HOLDOUT_LABELS)) return { skipped: "few_holdout_labels", ...base, min: MIN_HOLDOUT_LABELS };
    const sC: number[] = [], folds: number[] = []; const size = Math.ceil(ho.length / EVAL_FOLDS);
    for (let k = 0; k * size < ho.length; k++) { const fit = rows.slice(0, tr.length + k * size); const w = fitLR(fit, chooseL2(fit).l2); folds.push(fit.length); sC.push(...ho.slice(k * size, (k + 1) * size).map((d) => lin(d.x, w))); }
    // fit on the graded target, shrunk toward heur-2; L2 picked by forward-chaining CV
    const { l2, cv } = chooseL2(rows); const w = fitLR(rows, l2); const cur = this.promoted();
    const y = ho.map((d) => d.y), sH = ho.map((d) => lin(d.x, HEURISTIC));
    const auc = aucOf(sC, y), auc_heur = aucOf(sH, y);
    const { win, lift, lift_ci } = bootWin(ho.map((d) => d.actor), y, sC, sH);
    // the current model, out of its own sample only
    const ix = cur ? ho.flatMap((d, i) => (d.at >= cur.at ? [i] : [])) : []; const at = (v: number[]) => ix.map((i) => v[i]); const fy = at(y);
    const pl = cnt(ix.map((i) => ho[i])); const judged = !!cur && pl.every((v) => v >= MIN_HOLDOUT_LABELS);
    const prev = cur ? { n: ix.length, labels: pl, auc: judged ? aucOf(fy.map((_, k) => lin(ho[ix[k]].x, cur.model.engaged)), fy) : null, auc_cand: judged ? aucOf(at(sC), fy) : null, auc_heur: judged ? aucOf(at(sH), fy) : null } : null;
    const auc_prev = prev?.auc ?? null;
    // approved bar (+0.02, >= 90% wins), and the 95% lift interval must exclude 0 so a lucky holdout cannot promote
    const promote = auc !== null && auc_heur !== null && auc >= auc_heur + PROMOTE_MARGIN && win >= BOOT_WIN && !!lift_ci && lift_ci[0] > 0
      && (auc_prev === null || (prev!.auc_cand !== null && prev!.auc_cand >= auc_prev + PROMOTE_MARGIN));
    const demote = !promote && auc_prev !== null && prev!.auc_heur !== null && auc_prev < prev!.auc_heur;
    return { ...base, model: { engaged: w, auc, auc_heur, win, l2 }, cur, auc, auc_heur, auc_prev, prev, win, lift, lift_ci, l2, cv, folds, promote, demote };
  }
  /** Point-in-time training rows: features as of the impression's own time (so same-session history counts, as when
   *  serving) with its session, split at `split`. The catalog is read once. */
  dataset(imps: Omit<Imp, "feed" | "position">[], split: number) {
    const songs = this.songs(); const byId = new Map(songs.map((s) => [s.id, s])); const tr: Row[] = [], ho: Row[] = [];
    for (const i of imps) {
      const at = Number(i.created_at); const song = byId.get(i.share_id); if (!song || song.owner === i.actor) continue;
      const [e] = this.features(i.actor, i.session, at, songs, song);
      (at >= split ? ho : tr).push({ x: FEATURES.map((k) => e.f[k]), y: engaged(i), t: grade(i), g: signal(i), dur: e.song.dur, fresh: at - e.song.published_at < FRESH_WINDOW_H * 3_600_000, at, actor: i.actor, session: i.session, share_id: i.share_id });
    }
    return { tr, ho };
  }
}
/** train() did not fit a model (too little data); logged as rank_train_skipped so a skip is visible. labels = [pos, neg]. */
export interface TrainSkip { skipped: "few_impressions" | "few_train_rows" | "few_train_labels" | "few_holdout_labels"; impressions: number; n: number; holdout: number; min: number; labels?: { train: number[]; holdout: number[] } }
type Stats = { auc: number | null; auc_heur: number | null; auc_prev: number | null; win: number; lift: number | null; lift_ci: [number, number] | null; l2: number; cv: Record<string, number | null> };
/** The current model on evaluated rows after its created_at: auc (null until both labels >= MIN_HOLDOUT_LABELS), the candidate's and heur-2's AUC there. */
export type Prev = { n: number; labels: number[]; auc: number | null; auc_cand: number | null; auc_heur: number | null };
export interface Gate extends Stats { folds: number[]; prev: Prev | null; impressions: number; n: number; holdout: number; labels: { train: number[]; holdout: number[] }; model: Model; cur: { version: string; model: Model; at: number } | null; promote: boolean; demote: boolean }
export interface TrainResult extends Stats { folds: number[]; prev: Prev | null; version: string; n: number; holdout: number; labels: { train: number[]; holdout: number[] }; promoted: boolean; demoted: string | null; previous: string | null; ms: number; model: Model }
/** y = binary engaged (eval/gate label), t = graded target (fit). */
export type Row = { x: number[]; y: number; t: number; g: number; dur: number; fresh: boolean; at: number; actor: string; session: string; share_id: string };
/** Sized to the ~370 clean rows / ~76 engaged per 30 days left once CI rows are dropped (2026-11-11): train labels
 *  count rows before the evaluated span, holdout labels the pooled evaluated rows. */
export const MIN_TRAIN = 300, MIN_TRAIN_LABELS = 30, MIN_HOLDOUT_LABELS = 30, EVAL_FRAC = 0.6, EVAL_FOLDS = 4, HOLDOUT_MIN_DAYS = 3;
export const PROMOTE_MARGIN = 0.02, BOOT_N = 1000, BOOT_WIN = 0.9, L2_GRID = [0.1, 1, 10, 100, 1000];
export function lin(x: number[], w: Weights) { return w.bias + x.reduce((a, v, j) => a + v * (w[FEATURES[j]] ?? 0), 0); }
/** Logistic regression on a graded target t in [0, 1] (cross-entropy), shrunk toward heur-2: the standardized heur-2
 *  score is an unpenalized input and the standardized features carry the L2 penalty (l2 · ||w||² / 2), so a large l2
 *  gives a rescaled heur-2 and a small one a free fit. (Near-)constant features (sd <= 1e-3) get no own weight.
 *  Returned as raw-feature weights. */
export function fitLR(data: { x: number[]; t: number }[], l2 = 10): Weights {
  const d = FEATURES.length, n = data.length || 1; const hOf = (x: number[]) => lin(x, HEURISTIC);
  const mean = (f: (r: { x: number[] }) => number) => data.reduce((a, r) => a + f(r), 0) / n;
  const mu = FEATURES.map((_, j) => mean((r) => r.x[j])), mh = mean((r) => hOf(r.x));
  const sd = FEATURES.map((_, j) => Math.sqrt(mean((r) => (r.x[j] - mu[j]) ** 2))), sh = Math.sqrt(mean((r) => (hOf(r.x) - mh) ** 2)) || 1;
  const live = sd.map((v) => v > 1e-3); // features are in [0, 1]: a near-constant one would get a huge raw weight
  const z = data.map((r) => [(hOf(r.x) - mh) / sh, ...r.x.map((v, j) => (live[j] ? (v - mu[j]) / sd[j] : 0))]);
  const w = new Array(d + 2).fill(0); // [bias, heur-2, ...features]
  for (let ep = 0; ep < 800; ep++) {
    const g = new Array(d + 2).fill(0);
    data.forEach((r, i) => { const e = sig(w[0] + z[i].reduce((a, v, j) => a + v * w[j + 1], 0)) - r.t; g[0] += e; z[i].forEach((v, j) => { g[j + 1] += e * v; }); });
    for (let j = 0; j < w.length; j++) w[j] -= (0.5 * (g[j] + (j > 1 ? l2 * w[j] : 0))) / (n + (j > 1 ? l2 : 0)); // diagonal step: stable for any l2
    if (w[1] < 0) w[1] = 0; // shrink toward heur-2, never toward its inverse
  }
  const s = w[1] / sh; const raw = FEATURES.map((k, j) => s * HEURISTIC[k] + (live[j] ? w[j + 2] / sd[j] : 0));
  return { bias: w[0] + s * (HEURISTIC.bias - mh) - FEATURES.reduce((a, _, j) => a + (live[j] ? (w[j + 2] / sd[j]) * mu[j] : 0), 0), ...Object.fromEntries(FEATURES.map((k, j) => [k, raw[j]])) } as Weights;
}
/** L2 from L2_GRID by forward-chaining CV on the (time-ordered) training rows: fit on the first 50% / 75%, score the
 *  next 25% by binary-engaged AUC; best mean wins, ties go to the larger l2 (closer to heur-2). */
export function chooseL2(tr: Row[]) {
  const rows = [...tr].sort((a, b) => a.at - b.at); const n = rows.length; const folds = [[0.5, 0.75], [0.75, 1]].map(([a, b]) => [rows.slice(0, Math.floor(n * a)), rows.slice(Math.floor(n * a), Math.floor(n * b))]);
  const cv: Record<string, number | null> = {}; let best = L2_GRID[L2_GRID.length - 1], bestAuc = -Infinity;
  for (const l2 of [...L2_GRID].reverse()) {
    const aucs = folds.map(([fit, val]) => { const w = fitLR(fit, l2); return aucOf(val.map((r) => lin(r.x, w)), val.map((r) => r.y)); }).filter((v): v is number => v !== null);
    const m = aucs.length ? aucs.reduce((a, v) => a + v, 0) / aucs.length : null; cv[String(l2)] = m;
    if (m !== null && m > bestAuc + 1e-9) { best = l2; bestAuc = m; }
  }
  return { l2: best, cv };
}
/** BOOT_N seeded resamples of actors (with replacement): share where AUC(a) > AUC(b), mean AUC lift a − b and its 95%
 *  percentile interval. Resamples without both labels are skipped. */
export function bootWin(actors: string[], y: number[], a: number[], b: number[], n = BOOT_N, seed = 1) {
  const by = new Map<string, number[]>(); actors.forEach((x, i) => (by.get(x) ?? by.set(x, []).get(x)!).push(i)); const groups = [...by.values()]; const r = rng(seed);
  let wins = 0; const lifts: number[] = [];
  for (let k = 0; k < n; k++) {
    const idx: number[] = []; for (let j = 0; j < groups.length; j++) idx.push(...groups[Math.floor(r() * groups.length)]);
    const yy = idx.map((i) => y[i]), x = aucOf(idx.map((i) => a[i]), yy), z = aucOf(idx.map((i) => b[i]), yy); if (x === null || z === null) continue;
    lifts.push(x - z); if (x > z) wins++;
  }
  if (!lifts.length) return { win: 0, lift: null, lift_ci: null };
  lifts.sort((p, q) => p - q); const q = (p: number) => lifts[Math.min(lifts.length - 1, Math.floor(p * lifts.length))];
  return { win: wins / lifts.length, lift: lifts.reduce((s, v) => s + v, 0) / lifts.length, lift_ci: [q(0.025), q(0.975)] as [number, number] };
}
/** Run train() in a worker thread on its own connection to the same database file; resolves with the result
 *  (the caller then calls ranker.reload()). In-memory databases train in-process. */
export async function trainInWorker(ranker: Ranker, file: string | null, now?: number): Promise<TrainResult | TrainSkip | null> {
  if (!file) return ranker.train();
  const { Worker } = await import("node:worker_threads"); const { existsSync } = await import("node:fs"); const { dirname, join } = await import("node:path"); const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url)); const mjs = join(here, "rank-train.mjs"), ts = join(here, "train-worker.ts");
  const w = existsSync(mjs) ? new Worker(mjs, { workerData: { file, now } })
    : new Worker(`import("tsx/esm/api").then((m) => { m.register(); return import(${JSON.stringify(`file://${ts}`)}); });`, { eval: true, workerData: { file, now } });
  return new Promise((res, rej) => { w.once("message", (m: { ok: boolean; result?: TrainResult | TrainSkip | null; error?: string }) => { void w.terminate(); if (m.ok) { ranker.reload(); res(m.result ?? null); } else rej(new Error(m.error)); }); w.once("error", rej); });
}
/** ROC AUC (Mann-Whitney); tied scores share their mean rank, so a constant scorer gets 0.5. */
export function aucOf(score: number[], y: number[]): number | null {
  const pos = y.filter((v) => v).length, neg = y.length - pos; if (!pos || !neg) return null;
  const idx = score.map((s, i) => [s, y[i]] as const).sort((a, b) => a[0] - b[0]); let sum = 0;
  for (let i = 0; i < idx.length;) { let j = i; while (j < idx.length && idx[j][0] === idx[i][0]) j++; const mid = (i + 1 + j) / 2; for (let k = i; k < j; k++) if (idx[k][1]) sum += mid; i = j; }
  return (sum - (pos * (pos + 1)) / 2) / (pos * neg);
}
