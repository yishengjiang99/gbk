// Personalized "For you" ranking (docs/social/ranking.md). Small and in-process:
//   1. candidate generation: item-item co-engagement, content affinity (tags/labels/artist/instrument family),
//      trending (popularity score), fresh uploads; cold start = popularity + freshness.
//   2. pointwise value score: w · features. The weights come from a logistic model trained nightly on logged
//      impressions (trainModel) once there is enough data, otherwise from heuristic defaults.
//   3. re-rank: freshness boost, ~12% epsilon exploration, diversity (max 2 in a row per artist, max 3 per label).
//   4. session-aware: impressions from the current session (fast skips / long dwell) steer tags and artists.
import type { DatabaseSync } from "node:sqlite";

export const FEATURES = ["affinity", "coeng", "popularity", "freshness", "session", "seen"] as const;
export type Weights = Record<(typeof FEATURES)[number], number> & { bias: number };
export const HEURISTIC: Weights = { bias: 0, affinity: 1.0, coeng: 0.8, popularity: 0.6, freshness: 0.4, session: 1.2, seen: -0.6 };
export const EPSILON = 0.12, MAX_AUTHOR_RUN = 2, MAX_LABEL_RUN = 3, MIN_TRAIN = 500, FRESH_HALF_LIFE_H = 48;

/** Signal weight of one impression: completion/dwell/actions positive, fast skip negative. */
export const signal = (i: { dwell_ms: number; completed: number; fast_skip: number; actions: string }) =>
  (i.fast_skip ? -1 : 0) + (i.completed ? 1 : 0) + (i.dwell_ms >= 10_000 ? 0.5 : 0) + (i.actions !== "[]" ? 1.5 : 0);

interface Song { id: string; owner: string; score: number; published_at: number; tags: string[]; labels: string[]; fam: string[] }
const rng = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export class Ranker {
  weights: Weights = { ...HEURISTIC }; version = "heur-2"; private cache: { at: number; songs: Song[] } | null = null;
  constructor(private db: DatabaseSync, private now: () => number = Date.now) {
    this.db.exec("CREATE TABLE IF NOT EXISTS rank_models (version TEXT PRIMARY KEY, weights TEXT NOT NULL, n INTEGER NOT NULL, auc REAL, created_at INTEGER NOT NULL)");
    const m = this.db.prepare("SELECT version, weights FROM rank_models ORDER BY created_at DESC LIMIT 1").get() as { version: string; weights: string } | undefined;
    if (m) { this.weights = JSON.parse(m.weights); this.version = m.version; }
  }
  private songs(): Song[] {
    if (this.cache && this.now() - this.cache.at < 30_000) return this.cache.songs;
    const rows = this.db.prepare(`SELECT s.id, s.owner, s.score, COALESCE(s.published_at, s.created_at) AS pub, s.labels, s.project_json AS project FROM shares s
      WHERE s.public = 1 AND NOT EXISTS (SELECT 1 FROM json_each(s.labels) WHERE value = 'wip') ORDER BY s.score DESC LIMIT 1000`).all() as { id: string; owner: string; score: number; pub: number; labels: string; project: string | null }[];
    const tags = new Map<string, string[]>(); for (const t of this.db.prepare("SELECT share_id, tag FROM share_tags").all() as { share_id: string; tag: string }[]) (tags.get(t.share_id) ?? tags.set(t.share_id, []).get(t.share_id)!).push(t.tag);
    const fam = (p: string | null) => { try { const j = JSON.parse(p ?? "{}") as { tracks?: { program?: number; channel?: number }[] }; return [...new Set((j.tracks ?? []).map((t) => t.channel === 9 ? "drums" : `gm${Math.floor((t.program ?? 0) / 8)}`))]; } catch { return []; } };
    const songs = rows.map((r) => ({ id: r.id, owner: r.owner, score: Number(r.score), published_at: Number(r.pub), tags: tags.get(r.id) ?? [], labels: JSON.parse(r.labels || "[]") as string[], fam: fam(r.project) }));
    this.cache = { at: this.now(), songs }; return songs;
  }
  invalidate() { this.cache = null; }

  /** Per-song feature vectors for one actor (and current session). */
  features(actor: string | null, session: string | null) {
    const songs = this.songs(); const t = this.now();
    const hist = actor ? this.db.prepare("SELECT share_id, dwell_ms, completed, fast_skip, actions, session, created_at FROM impressions WHERE actor = ? AND created_at > ? ORDER BY id DESC LIMIT 500").all(actor, t - 60 * 86_400_000) as { share_id: string; dwell_ms: number; completed: number; fast_skip: number; actions: string; session: string; created_at: number }[] : [];
    const byId = new Map(songs.map((s) => [s.id, s]));
    const pref = new Map<string, number>(), sess = new Map<string, number>(), seen = new Map<string, number>(), liked: string[] = [];
    for (const h of hist) {
      const s = byId.get(h.share_id); const w = signal(h); seen.set(h.share_id, (seen.get(h.share_id) ?? 0) + 1); if (w > 0) liked.push(h.share_id);
      if (!s) continue; const keys = [...s.tags.map((x) => `t:${x}`), ...s.labels.map((x) => `l:${x}`), `a:${s.owner}`, ...s.fam.map((x) => `f:${x}`)];
      const decay = Math.exp(-(t - h.created_at) / (14 * 86_400_000));
      for (const k of keys) pref.set(k, (pref.get(k) ?? 0) + w * decay);
      if (session && h.session === session) for (const k of keys) sess.set(k, (sess.get(k) ?? 0) + w);
    }
    // item-item co-engagement: songs positively engaged by actors who positively engaged what this actor liked
    const co = new Map<string, number>();
    if (liked.length) {
      const ids = [...new Set(liked)].slice(0, 50); const ph = ids.map(() => "?").join(",");
      for (const r of this.db.prepare(`SELECT i2.share_id AS id, COUNT(DISTINCT i2.actor) AS n FROM impressions i1 JOIN impressions i2 ON i2.actor = i1.actor AND i2.share_id <> i1.share_id
        WHERE i1.share_id IN (${ph}) AND i1.actor <> ? AND (i1.completed = 1 OR i1.actions <> '[]') AND (i2.completed = 1 OR i2.actions <> '[]') AND i1.created_at > ? GROUP BY i2.share_id ORDER BY n DESC LIMIT 200`).all(...ids, actor!, t - 30 * 86_400_000) as { id: string; n: number }[]) co.set(r.id, Number(r.n));
    }
    const maxScore = Math.max(1e-9, ...songs.map((s) => s.score)), maxCo = Math.max(1, ...co.values());
    const sq = (m: Map<string, number>, s: Song) => { const keys = [...s.tags.map((x) => `t:${x}`), ...s.labels.map((x) => `l:${x}`), `a:${s.owner}`, ...s.fam.map((x) => `f:${x}`)]; let v = 0; for (const k of keys) v += m.get(k) ?? 0; return Math.tanh(v / 3); };
    return songs.map((s) => ({ song: s, f: { affinity: sq(pref, s), coeng: (co.get(s.id) ?? 0) / maxCo, popularity: s.score / maxScore, freshness: Math.pow(0.5, (t - s.published_at) / (FRESH_HALF_LIFE_H * 3_600_000)), session: sq(sess, s), seen: Math.min(1, (seen.get(s.id) ?? 0) / 2) }, history: hist.length }));
  }
  value(f: Record<string, number>, w = this.weights) { let v = w.bias; for (const k of FEATURES) v += (w[k] ?? 0) * (f[k] ?? 0); return v; }

  /** Full ranked id list for an actor; deterministic for a given seed (pages stay consistent). */
  rank(o: { actor: string | null; session: string | null; seed: number; viewer?: string | null }): { ids: string[]; owners: Map<string, string>; version: string; cold: boolean } {
    const fs = this.features(o.actor, o.session); const r = rng(o.seed); const cold = !fs.length || fs[0].history === 0;
    const scored = fs.map((x) => ({ s: x.song, v: this.value(x.f) + (x.song.owner === o.viewer ? -0.5 : 0) + r() * 1e-3 }));
    scored.sort((a, b) => b.v - a.v);
    // exploration: ~EPSILON of the slots go to random lower-ranked (often new / untried) songs
    const out: typeof scored = []; const pool = [...scored];
    while (pool.length) { const explore = r() < EPSILON && pool.length > 3; const i = explore ? 1 + Math.floor(r() * (pool.length - 1)) : 0; out.push(pool.splice(i, 1)[0]); }
    // diversity re-rank: greedy, never > MAX_AUTHOR_RUN same artist or > MAX_LABEL_RUN same first label in a row
    const res: Song[] = []; const left = out.map((x) => x.s);
    const ok = (s: Song) => { const n = res.length; const a = res.slice(Math.max(0, n - MAX_AUTHOR_RUN)); const l = res.slice(Math.max(0, n - MAX_LABEL_RUN));
      return !(a.length === MAX_AUTHOR_RUN && a.every((x) => x.owner === s.owner)) && !(s.labels[0] && l.length === MAX_LABEL_RUN && l.every((x) => x.labels[0] === s.labels[0])); };
    while (left.length) { const i = left.findIndex(ok); res.push(left.splice(i === -1 ? 0 : i, 1)[0]); }
    return { ids: res.map((s) => s.id), owners: new Map(res.map((s) => [s.id, s.owner])), version: this.version, cold };
  }

  /** Nightly: fit a logistic model P(positive | features) on logged impressions; positive = completed or an action, negative = fast skip / short dwell. */
  train(): { version: string; n: number; auc: number | null; weights: Weights } | null {
    const t = this.now();
    const imps = this.db.prepare("SELECT actor, session, share_id, dwell_ms, completed, fast_skip, actions FROM impressions WHERE created_at > ? AND position >= 0 ORDER BY id DESC LIMIT 20000").all(t - 30 * 86_400_000) as { actor: string; session: string; share_id: string; dwell_ms: number; completed: number; fast_skip: number; actions: string }[];
    if (imps.length < MIN_TRAIN) return null;
    const featCache = new Map<string, Map<string, Record<string, number>>>();
    const data: { x: number[]; y: number }[] = [];
    for (const i of imps) {
      let m = featCache.get(i.actor); if (!m) { m = new Map(this.features(i.actor, null).map((x) => [x.song.id, x.f as Record<string, number>])); featCache.set(i.actor, m); if (featCache.size > 300) featCache.clear(); }
      const f = m.get(i.share_id); if (!f) continue; data.push({ x: FEATURES.map((k) => f[k]), y: signal(i) > 0 ? 1 : 0 });
    }
    if (data.length < MIN_TRAIN) return null;
    const w = new Array(FEATURES.length + 1).fill(0); const lr = 0.1, l2 = 1e-3;
    for (let ep = 0; ep < 200; ep++) { const g = new Array(w.length).fill(0); for (const d of data) { const z = w[0] + d.x.reduce((a, v, j) => a + v * w[j + 1], 0); const e = 1 / (1 + Math.exp(-z)) - d.y; g[0] += e; d.x.forEach((v, j) => { g[j + 1] += e * v; }); } for (let j = 0; j < w.length; j++) w[j] -= lr * (g[j] / data.length + (j ? l2 * w[j] : 0)); }
    const pred = data.map((d) => w[0] + d.x.reduce((a, v, j) => a + v * w[j + 1], 0));
    const auc = aucOf(pred, data.map((d) => d.y));
    const weights = { bias: w[0], ...Object.fromEntries(FEATURES.map((k, j) => [k, w[j + 1]])) } as Weights;
    const version = `lr-${new Date(t).toISOString().slice(0, 10).replace(/-/g, "")}`;
    this.db.prepare("INSERT OR REPLACE INTO rank_models VALUES (?,?,?,?,?)").run(version, JSON.stringify(weights), data.length, auc, t);
    this.weights = weights; this.version = version; return { version, n: data.length, auc, weights };
  }
}
export function aucOf(score: number[], y: number[]): number | null {
  const pos = y.filter((v) => v).length, neg = y.length - pos; if (!pos || !neg) return null;
  const idx = score.map((s, i) => [s, y[i]] as const).sort((a, b) => a[0] - b[0]); let rank = 0, sum = 0;
  for (const [, l] of idx) { rank++; if (l) sum += rank; } return (sum - (pos * (pos + 1)) / 2) / (pos * neg);
}
