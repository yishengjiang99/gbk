// Offline ranking eval (docs/social/ranking.md "Offline eval"): replays logged impressions with point-in-time
// features and compares models. Used by scripts/rank-eval.ts and the tests.
import type { DatabaseSync } from "node:sqlite";
import { Ranker, HEURISTIC, FEATURES, IMP_COLS, aucOf, lin, parseModel, trainable, type Imp, type Model, type Row } from "./ranker.ts";

export type Scorer = { name: string; version: string; model: Model | null };
export function scorers(db: DatabaseSync): Scorer[] {
  const rows = db.prepare("SELECT version, weights, promoted FROM rank_models ORDER BY created_at DESC").all() as { version: string; weights: string; promoted: number | null }[];
  const out: Scorer[] = [];
  const prom = rows.find((r) => r.promoted === 1 && parseModel(r.weights)); if (prom) out.push({ name: "promoted", version: prom.version, model: parseModel(prom.weights) });
  const cand = rows.find((r) => parseModel(r.weights)); if (cand && cand.version !== prom?.version) out.push({ name: "candidate", version: cand.version, model: parseModel(cand.weights) });
  out.push({ name: "heuristic", version: "heur-2", model: null });
  return out;
}
const score = (s: Scorer, x: number[]) => lin(x, s.model ? s.model.engaged : HEURISTIC);
/** NDCG@k of one ordering; gains = max(0, signal). */
export function ndcg(gains: number[], k = 10) {
  const dcg = (g: number[]) => g.slice(0, k).reduce((a, v, i) => a + (Math.pow(2, Math.max(0, v)) - 1) / Math.log2(i + 2), 0);
  const ideal = dcg([...gains].sort((a, b) => b - a)); return ideal > 0 ? dcg(gains) / ideal : null;
}
export interface EvalReport { name: string; version: string; n: number; sessions: number; auc_engaged: number | null; ndcg10: number | null; new_share_top10: number | null }
export function evaluate(rows: Row[], ss: Scorer[]): EvalReport[] {
  const bySess = new Map<string, Row[]>(); for (const r of rows) (bySess.get(`${r.actor}\u0001${r.session}`) ?? bySess.set(`${r.actor}\u0001${r.session}`, []).get(`${r.actor}\u0001${r.session}`)!).push(r);
  return ss.map((s) => {
    let nd = 0, nn = 0, fresh = 0, top = 0;
    for (const list of bySess.values()) {
      // one row per song per session (best signal) so a re-shown song is not counted twice
      const per = new Map<string, Row>(); for (const r of list) { const p = per.get(r.share_id); if (!p || r.g > p.g) per.set(r.share_id, r); }
      const ord = [...per.values()].sort((a, b) => score(s, b.x) - score(s, a.x)); const v = ndcg(ord.map((r) => r.g)); if (v !== null) { nd += v; nn++; }
      for (const r of ord.slice(0, 10)) { top++; if (r.fresh) fresh++; }
    }
    return { name: s.name, version: s.version, n: rows.length, sessions: bySess.size, auc_engaged: aucOf(rows.map((r) => score(s, r.x)), rows.map((r) => r.y)), ndcg10: nn ? nd / nn : null, new_share_top10: top ? fresh / top : null };
  });
}
/** Load trainable impressions in [from, to) and build point-in-time rows. */
export function evalRange(db: DatabaseSync, from: number, to: number, now = Date.now()) {
  const rk = new Ranker(db, () => now);
  const imps = trainable(db.prepare(`SELECT ${IMP_COLS} FROM impressions WHERE created_at >= ? AND created_at < ?`).all(from, to) as Imp[]);
  const { ho } = rk.dataset(imps, -Infinity);
  return evaluate(ho, scorers(db));
}
/** What tonight's train() would decide, without writing (open the DB read-only). */
export function preview(db: DatabaseSync, now = Date.now()) {
  const g = new Ranker(db, () => now).gate(); if ("skipped" in g) return g;
  const { cur, model, ...rest } = g; return { ...rest, current: cur?.version ?? "heur-2", weights: Object.fromEntries(["bias", ...FEATURES].map((k) => [k, model.engaged[k as keyof typeof model.engaged]])) };
}
