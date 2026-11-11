// Offline ranking eval (read-only): node --import tsx/esm scripts/rank-eval.ts [--db <shares.sqlite>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json] [--preview]
// Default: compares the promoted model, the latest candidate and heur-2 on trainable impressions in [from, to):
// AUC of the engaged label, NDCG@10 per session (gain = signal()), share of < 48 h songs in the top 10.
// --preview: the gate decision tonight's nightly train() would make (fit, holdout AUCs, resample win rate), no writes.
// Prod bundle: node server/dist/rank-eval.mjs (same flags).
import { DatabaseSync } from "node:sqlite";
import { evalRange, preview } from "../server/src/ranking/eval.ts";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const db = new DatabaseSync(arg("db") ?? `${process.env.COMPOSER_DATA_DIR ?? "/var/lib/gbk-composer"}/shares.sqlite`, { readOnly: true });
if (process.argv.includes("--preview")) console.log(JSON.stringify(preview(db), null, 2));
else {
  const to = arg("to") ? Date.parse(`${arg("to")}T00:00:00Z`) + 86_400_000 : Date.now(); const from = arg("from") ? Date.parse(`${arg("from")}T00:00:00Z`) : to - 3 * 86_400_000;
  const rep = evalRange(db, from, to);
  if (process.argv.includes("--json")) console.log(JSON.stringify({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), models: rep }, null, 2));
  else { const f = (v: number | null) => (v === null ? "  —  " : v.toFixed(3)); console.log(`impressions ${rep[0]?.n ?? 0}, sessions ${rep[0]?.sessions ?? 0}, ${new Date(from).toISOString().slice(0, 10)}..${new Date(to - 1).toISOString().slice(0, 10)}`);
    console.log("model       version          auc_engaged  ndcg@10  new_in_top10");
    for (const r of rep) console.log(`${r.name.padEnd(11)} ${r.version.padEnd(16)} ${f(r.auc_engaged).padStart(11)}  ${f(r.ndcg10).padStart(7)}  ${f(r.new_share_top10).padStart(12)}`); }
}
db.close();
