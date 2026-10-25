// Offline ranking eval: node --import tsx/esm scripts/rank-eval.ts [--db <shares.sqlite>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]
// Compares the promoted model, the latest candidate and HEURISTIC on logged impressions in [from, to):
// holdout AUC per head (P(complete), P(fast skip)), NDCG@10 per session (gain = signal()), share of < 48 h songs in the top 10.
import { DatabaseSync } from "node:sqlite";
import { evalRange } from "../server/src/ranking/eval.ts";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const db = new DatabaseSync(arg("db") ?? `${process.env.COMPOSER_DATA_DIR ?? "/var/lib/gbk-composer"}/shares.sqlite`, { readOnly: true });
const to = arg("to") ? Date.parse(`${arg("to")}T00:00:00Z`) + 86_400_000 : Date.now(); const from = arg("from") ? Date.parse(`${arg("from")}T00:00:00Z`) : to - 3 * 86_400_000;
const rep = evalRange(db, from, to);
if (process.argv.includes("--json")) console.log(JSON.stringify({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), models: rep }, null, 2));
else { const f = (v: number | null) => (v === null ? "  —  " : v.toFixed(3)); console.log(`impressions ${rep[0]?.n ?? 0}, sessions ${rep[0]?.sessions ?? 0}, ${new Date(from).toISOString().slice(0, 10)}..${new Date(to - 1).toISOString().slice(0, 10)}`);
  console.log("model       version          auc_complete  auc_skip  ndcg@10  new_in_top10");
  for (const r of rep) console.log(`${r.name.padEnd(11)} ${r.version.padEnd(16)} ${f(r.auc_complete).padStart(12)}  ${f(r.auc_skip).padStart(8)}  ${f(r.ndcg10).padStart(7)}  ${f(r.new_share_top10).padStart(12)}`); }
