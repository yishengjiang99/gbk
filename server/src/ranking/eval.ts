// Offline ranking eval (docs/social/ranking.md "Offline eval"): replays logged impressions with point-in-time
// features and compares models. Used by scripts/rank-eval.ts and the tests.
import type { DatabaseSync } from "node:sqlite";
import { Ranker, HEURISTIC, FEATURES, aucOf, lin, type Model, type Row, type Weights } from "./ranker.ts";

export type Scorer = { name: string; version: string; complete: (x: number[]) => number; skip: (x: number[]) => number; value: (r: Row) => number };
export function scorers(rk: Ranker, db: DatabaseSync): Scorer[] {
  const rows = db.prepare("SELECT version, weights, promoted, created_at FROM rank_models ORDER BY created_at DESC").all() as { version: string; weights: string; promoted: number | null }[];
  const mk = (name: string, version: string, w: Weights | Model): Scorer => "complete" in w
    ? { name, version, complete: (x) => lin(x, w.complete), skip: (x) => lin(x, w.skip), value: (r) => rk.value(Object.fromEntries(FEATURES.map((k, j) => [k, r.x[j]])), r.dur, w) }
    : { name, version, complete: (x) => lin(x, w), skip: (x) => -lin(x, w), value: (r) => rk.value(Object.fromEntries(FEATURES.map((k, j) => [k, r.x[j]])), r.dur, null, w) };
  const out: Scorer[] = [];
  const prom = rows.find((r) => r.promoted === null || r.promoted === 1); if (prom) out.push(mk("promoted", prom.version, JSON.parse(prom.weights)));
  const cand = rows[0]; if (cand && cand.version !== prom?.version) out.push(mk("candidate", cand.version, JSON.parse(cand.weights)));
  out.push(mk("heuristic", "heur-2", HEURISTIC));
  return out;
}
/** NDCG@k of one ordering; gains = max(0, signal). */
export function ndcg(gains: number[], k = 10) {
  const dcg = (g: number[]) => g.slice(0, k).reduce((a, v, i) => a + (Math.pow(2, Math.max(0, v)) - 1) / Math.log2(i + 2), 0);
  const ideal = dcg([...gains].sort((a, b) => b - a)); return ideal > 0 ? dcg(gains) / ideal : null;
}
export interface EvalReport { name: string; version: string; n: number; sessions: number; auc_complete: number | null; auc_skip: number | null; ndcg10: number | null; new_share_top10: number | null }
export function evaluate(rows: Row[], ss: Scorer[]): EvalReport[] {
  const bySess = new Map<string, Row[]>(); for (const r of rows) (bySess.get(`${r.actor}\u0001${r.session}`) ?? bySess.set(`${r.actor}\u0001${r.session}`, []).get(`${r.actor}\u0001${r.session}`)!).push(r);
  return ss.map((s) => {
    let nd = 0, nn = 0, fresh = 0, top = 0;
    for (const list of bySess.values()) {
      // one row per song per session (best signal) so a re-shown song is not counted twice
      const per = new Map<string, Row>(); for (const r of list) { const p = per.get(r.share_id); if (!p || r.g > p.g) per.set(r.share_id, r); }
      const ord = [...per.values()].sort((a, b) => s.value(b) - s.value(a)); const v = ndcg(ord.map((r) => r.g)); if (v !== null) { nd += v; nn++; }
      for (const r of ord.slice(0, 10)) { top++; if (r.fresh) fresh++; }
    }
    return { name: s.name, version: s.version, n: rows.length, sessions: bySess.size, auc_complete: aucOf(rows.map((r) => s.complete(r.x)), rows.map((r) => r.c)), auc_skip: aucOf(rows.map((r) => s.skip(r.x)), rows.map((r) => r.s)), ndcg10: nn ? nd / nn : null, new_share_top10: top ? fresh / top : null };
  });
}
/** Load impressions in [from, to) and build point-in-time rows. */
export function evalRange(db: DatabaseSync, from: number, to: number, now = Date.now()) {
  const rk = new Ranker(db, () => now);
  const imps = db.prepare("SELECT actor, session, share_id, dwell_ms, listen_ratio, completed, fast_skip, replay, actions, created_at FROM impressions WHERE created_at >= ? AND created_at < ? AND position >= 0 ORDER BY id").all(from, to) as Parameters<Ranker["dataset"]>[0];
  const { ho } = rk.dataset(imps, -Infinity);
  return evaluate(ho, scorers(rk, db));
}
