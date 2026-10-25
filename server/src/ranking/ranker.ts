// Personalized "For you" ranking (docs/social/ranking.md). Small and in-process:
//   1. candidate generation: named sources with quotas (coeng, affinity, artists, trending, fresh < 48 h always in,
//      cold = popularity + freshness for actors with no history); union capped at POOL_MAX.
//   2. pointwise value: expected listen value from two nightly LR heads (lr2: P(complete), P(fast skip)) once a
//      model passes the promotion gate, otherwise HEURISTIC weights · features.
//   3. re-rank: freshness boost, ~12% epsilon exploration, diversity (max 2 in a row per artist, max 3 per label).
//   4. session-aware: impressions from the current session (fast skips / long dwell) steer tags and artists.
import type { DatabaseSync } from "node:sqlite";

export const FEATURES = ["affinity", "coeng", "popularity", "freshness", "session", "seen"] as const;
export type Weights = Record<(typeof FEATURES)[number], number> & { bias: number };
export const HEURISTIC: Weights = { bias: 0, affinity: 1.0, coeng: 0.8, popularity: 0.6, freshness: 0.4, session: 1.2, seen: -0.6 };
/** Learned model (lr2): two pointwise LR heads on the same features; value = expected listen value. */
export interface Model { complete: Weights; skip: Weights; auc_skip?: number | null }
export const SKIP_LAMBDA = 1.0, DUR_CAP_S = 180;
const sig = (z: number) => 1 / (1 + Math.exp(-z));
/** Labels: completion = completed, replay, or listen_ratio >= 0.9; fast skip = dwell < 2 s (as logged). */
export const labels = (i: { completed: number; replay?: number; listen_ratio?: number; fast_skip: number }) => ({ complete: i.completed || i.replay || (i.listen_ratio ?? 0) >= 0.9 ? 1 : 0, skip: i.fast_skip ? 1 : 0 });
export const EPSILON = 0.12, MAX_AUTHOR_RUN = 2, MAX_LABEL_RUN = 3, MIN_TRAIN = 500, FRESH_HALF_LIFE_H = 48;

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
interface Ctx { t: number; pref: Map<string, number>; sess: Map<string, number>; seen: Map<string, number>; co: Map<string, number>; artists: Map<string, number>; history: number; maxScore: number; maxCo: number }
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
    this.db.exec("CREATE TABLE IF NOT EXISTS rank_models (version TEXT PRIMARY KEY, weights TEXT NOT NULL, n INTEGER NOT NULL, auc REAL, created_at INTEGER NOT NULL)");
    // promoted: 1 = served, 0 = candidate that lost the gate. Pre-gate rows (NULL) were served, so they count as promoted.
    if (!(this.db.prepare("PRAGMA table_info(rank_models)").all() as { name: string }[]).some((c) => c.name === "promoted")) this.db.exec("ALTER TABLE rank_models ADD COLUMN promoted INTEGER");
    this.reload();
  }
  /** Load the latest promoted model (or stay on HEURISTIC). */
  reload() {
    const m = this.db.prepare("SELECT version, weights FROM rank_models WHERE promoted IS NULL OR promoted = 1 ORDER BY created_at DESC LIMIT 1").get() as { version: string; weights: string } | undefined;
    this.weights = { ...HEURISTIC }; this.model = null; this.version = "heur-2";
    if (m) { const w = JSON.parse(m.weights) as Weights | Model; this.version = m.version; if ("complete" in w) this.model = w; else this.weights = w; }
  }
  /** Latest promoted model (lr2 two-head); a legacy single-head row or none counts as "no model" for the gate. */
  private promoted() { const m = this.db.prepare("SELECT version, weights FROM rank_models WHERE promoted IS NULL OR promoted = 1 ORDER BY created_at DESC LIMIT 1").get() as { version: string; weights: string } | undefined; const w = m ? JSON.parse(m.weights) as Weights | Model : null; return m && w && "complete" in w ? { version: m.version, model: w } : null; }
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
    return { t, pref, sess, seen, co, artists, history: hist.length, maxScore: Math.max(1e-9, ...songs.map((s) => s.score)), maxCo: Math.max(1, ...co.values()) };
  }
  private feat(c: Ctx, s: Song) {
    return { affinity: sq(c.pref, s), coeng: (c.co.get(s.id) ?? 0) / c.maxCo, popularity: s.score / c.maxScore, freshness: Math.pow(0.5, Math.max(0, c.t - s.published_at) / (FRESH_HALF_LIFE_H * 3_600_000)), session: sq(c.sess, s), seen: Math.min(1, (c.seen.get(s.id) ?? 0) / 2) };
  }
  /** Per-song feature vectors for one actor (and current session), point-in-time: only impressions before `asOf`. */
  features(actor: string | null, session: string | null, asOf?: number) {
    const songs = this.songs(); const c = this.context(actor, session, asOf ?? this.now(), songs);
    return songs.map((s) => ({ song: s, f: this.feat(c, s), history: c.history }));
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
  /** Score: with a learned model, expected listen value P(complete)·min(dur,180)/180 − SKIP_LAMBDA·P(fast skip); else HEURISTIC w·f. */
  value(f: Record<string, number>, durS = 60, m: Model | null = this.model, w = this.weights) {
    const x = FEATURES.map((k) => f[k] ?? 0);
    if (m) return sig(lin(x, m.complete)) * (Math.min(durS, DUR_CAP_S) / DUR_CAP_S) - SKIP_LAMBDA * sig(lin(x, m.skip));
    return lin(x, w);
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
    const scored = songs.filter((s) => pool.has(s.id)).map((s) => ({ s, v: this.value(this.feat(c, s), s.dur) + (s.owner === o.viewer ? -0.5 : 0) + r() * 1e-3 }));
    scored.sort((a, b) => b.v - a.v);
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

  /** Nightly: fit two LR heads, P(complete) and P(fast skip), on point-in-time features (as of each impression's
   *  hour, with its own session); the last HOLDOUT_DAYS are held out. The candidate is always stored, and promoted
   *  only if both heads' holdout AUC are >= the promoted model's on the same holdout (HEURISTIC = no model). */
  train(): TrainResult | null {
    const t0 = Date.now(); const t = this.now();
    const imps = this.db.prepare("SELECT actor, session, share_id, dwell_ms, listen_ratio, completed, fast_skip, replay, actions, created_at FROM impressions WHERE created_at > ? AND position >= 0 ORDER BY id DESC LIMIT 20000").all(t - 30 * 86_400_000) as { actor: string; session: string; share_id: string; dwell_ms: number; listen_ratio: number; completed: number; fast_skip: number; replay: number; actions: string; created_at: number }[];
    if (imps.length < MIN_TRAIN) return null;
    const { tr, ho } = this.dataset(imps, t - HOLDOUT_DAYS * 86_400_000);
    if (tr.length < MIN_TRAIN || !ho.length) return null;
    const model: Model = { complete: fitLR(tr.map((d) => ({ x: d.x, y: d.c }))), skip: fitLR(tr.map((d) => ({ x: d.x, y: d.s }))) };
    const ev = (m: Model) => ({ c: aucOf(ho.map((d) => lin(d.x, m.complete)), ho.map((d) => d.c)), s: aucOf(ho.map((d) => lin(d.x, m.skip)), ho.map((d) => d.s)) });
    const a = ev(model); model.auc_skip = a.s; const cur = this.promoted(); const b = cur ? ev(cur.model) : null;
    const ge = (x: number | null, y: number | null | undefined) => y === null || y === undefined || (x !== null && x >= y);
    const promote = !cur || (ge(a.c, b!.c) && ge(a.s, b!.s));
    let version = `lr2-${new Date(t).toISOString().slice(0, 10).replace(/-/g, "")}`; if (cur?.version === version && !promote) version += "-c";
    this.db.prepare("INSERT OR REPLACE INTO rank_models (version, weights, n, auc, created_at, promoted) VALUES (?,?,?,?,?,?)").run(version, JSON.stringify(model), tr.length, a.c, t, promote ? 1 : 0);
    if (promote) { this.model = model; this.version = version; }
    return { version, n: tr.length, holdout: ho.length, auc: a.c, auc_skip: a.s, promoted: promote, previous: cur?.version ?? null, previous_auc: b?.c ?? null, previous_auc_skip: b?.s ?? null, ms: Date.now() - t0, model };
  }
  /** Point-in-time training rows (features as of each impression's hour + its session), split at `split`. */
  dataset(imps: { actor: string; session: string; share_id: string; dwell_ms: number; listen_ratio: number; completed: number; fast_skip: number; replay: number; actions: string; created_at: number }[], split: number) {
    const cache = new Map<string, Map<string, { f: Record<string, number>; song: Song }>>(); const tr: Row[] = [], ho: Row[] = [];
    for (const i of imps) {
      const hr = Math.floor(Number(i.created_at) / 3_600_000) * 3_600_000; const key = `${i.actor}\u0001${i.session}\u0001${hr}`;
      let m = cache.get(key); if (!m) { if (cache.size > 2000) cache.clear(); m = new Map(this.features(i.actor, i.session, hr).map((x) => [x.song.id, { f: x.f as Record<string, number>, song: x.song }])); cache.set(key, m); }
      const e = m.get(i.share_id); if (!e) continue; const l = labels(i); const at = Number(i.created_at);
      (at >= split ? ho : tr).push({ x: FEATURES.map((k) => e.f[k]), c: l.complete, s: l.skip, g: signal(i), dur: e.song.dur, fresh: at - e.song.published_at < FRESH_WINDOW_H * 3_600_000, at, actor: i.actor, session: i.session, share_id: i.share_id });
    }
    return { tr, ho };
  }
}
export interface TrainResult { version: string; n: number; holdout: number; auc: number | null; auc_skip: number | null; promoted: boolean; previous: string | null; previous_auc: number | null; previous_auc_skip: number | null; ms: number; model: Model }
export type Row = { x: number[]; c: number; s: number; g: number; dur: number; fresh: boolean; at: number; actor: string; session: string; share_id: string };
export const HOLDOUT_DAYS = 3;
export function lin(x: number[], w: Weights) { return w.bias + x.reduce((a, v, j) => a + v * (w[FEATURES[j]] ?? 0), 0); }
function fitLR(data: { x: number[]; y: number }[]): Weights {
  const w = new Array(FEATURES.length + 1).fill(0); const lr = 0.1, l2 = 1e-3;
  for (let ep = 0; ep < 200; ep++) { const g = new Array(w.length).fill(0); for (const d of data) { const z = w[0] + d.x.reduce((a, v, j) => a + v * w[j + 1], 0); const e = 1 / (1 + Math.exp(-z)) - d.y; g[0] += e; d.x.forEach((v, j) => { g[j + 1] += e * v; }); } for (let j = 0; j < w.length; j++) w[j] -= lr * (g[j] / data.length + (j ? l2 * w[j] : 0)); }
  return { bias: w[0], ...Object.fromEntries(FEATURES.map((k, j) => [k, w[j + 1]])) } as Weights;
}
/** Run train() in a worker thread on its own connection to the same database file; resolves with the result
 *  (the caller then calls ranker.reload()). In-memory databases train in-process. */
export async function trainInWorker(ranker: Ranker, file: string | null, now?: number): Promise<TrainResult | null> {
  if (!file) return ranker.train();
  const { Worker } = await import("node:worker_threads"); const { existsSync } = await import("node:fs"); const { dirname, join } = await import("node:path"); const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url)); const mjs = join(here, "rank-train.mjs"), ts = join(here, "train-worker.ts");
  const w = existsSync(mjs) ? new Worker(mjs, { workerData: { file, now } })
    : new Worker(`import("tsx/esm/api").then((m) => { m.register(); return import(${JSON.stringify(`file://${ts}`)}); });`, { eval: true, workerData: { file, now } });
  return new Promise((res, rej) => { w.once("message", (m: { ok: boolean; result?: TrainResult | null; error?: string }) => { void w.terminate(); if (m.ok) { ranker.reload(); res(m.result ?? null); } else rej(new Error(m.error)); }); w.once("error", rej); });
}
export function aucOf(score: number[], y: number[]): number | null {
  const pos = y.filter((v) => v).length, neg = y.length - pos; if (!pos || !neg) return null;
  const idx = score.map((s, i) => [s, y[i]] as const).sort((a, b) => a[0] - b[0]); let rank = 0, sum = 0;
  for (const [, l] of idx) { rank++; if (l) sum += rank; } return (sum - (pos * (pos + 1)) / 2) / (pos * neg);
}
