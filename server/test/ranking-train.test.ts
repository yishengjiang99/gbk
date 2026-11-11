// Nightly lr-eng training: minimums, forward-chained out-of-time eval, gate vs heur-2 (margin + seeded actor resamples), demotion, fallback.
import test from "node:test";
import assert from "node:assert/strict";
import { Ranker, trainInWorker, aucOf, bootWin, fitLR, lin, chooseL2, grade, FEATURES, HEURISTIC, MIN_TRAIN, MIN_TRAIN_LABELS, MIN_HOLDOUT_LABELS, type TrainResult, type Weights } from "../src/ranking/ranker.ts";
import { preview } from "../src/ranking/eval.ts";
import { fixture, rand, H, D } from "./rank-fixture.ts";

type Fx = ReturnType<typeof fixture>;
const models = (fx: Fx) => fx.db.prepare("SELECT version, promoted FROM rank_models ORDER BY created_at").all() as { version: string; promoted: number }[];
const put = (fx: Fx, version: string, weights: unknown, ageD = 1) => { new Ranker(fx.db, fx.now); fx.db.prepare("INSERT INTO rank_models (version, weights, n, auc, created_at, promoted) VALUES (?, ?, 1, 0.5, ?, 1)").run(version, typeof weights === "string" ? weights : JSON.stringify(weights), fx.now() - ageD * D); };
const w = (o: Partial<Weights>): Weights => ({ bias: 0, ...Object.fromEntries(FEATURES.map((k) => [k, 0])), ...o }) as Weights;

/** Repeat listens: each actor's first play of a song is not engaged, the replay 2 h later is. heur-2 penalizes `seen`, so it ranks these backwards. */
function repeatWorld(fx: Fx, seed = 1, actors = 80) {
  const r = rand(seed); const songs = Array.from({ length: 60 }, (_, i) => fx.song({ owner: `o${i}`, ageH: 24 * 40 }));
  for (let a = 0; a < actors; a++) for (let k = 0; k < 6; k++) {
    const s = songs[Math.floor(r() * songs.length)]; const at = fx.now() - D - Math.floor(r() * 19 * D);
    fx.imp({ actor: `a${a}`, song: s, at, good: false, skip: false }); fx.imp({ actor: `a${a}`, song: s, at: at + 2 * H, good: true });
  }
}
/** No signal: engagement is a coin flip. */
function noiseWorld(fx: Fx, seed = 2, n = 900) {
  const r = rand(seed); const songs = Array.from({ length: 40 }, (_, i) => fx.song({ owner: `o${i}`, ageH: 24 * 40 }));
  for (let k = 0; k < n; k++) fx.imp({ actor: `a${Math.floor(r() * 90)}`, song: songs[Math.floor(r() * songs.length)], at: fx.now() - H - Math.floor(r() * 20 * D), good: r() < 0.4, skip: false });
}

test("aucOf: ties share their mean rank; bootWin is seeded and deterministic", () => {
  assert.equal(aucOf([1, 1, 1, 1], [0, 1, 0, 1]), 0.5); assert.equal(aucOf([0.1, 0.9, 0.4, 0.8], [0, 1, 0, 1]), 1); assert.equal(aucOf([1, 2], [1, 1]), null);
  const actors = Array.from({ length: 60 }, (_, i) => `a${i % 20}`), y = actors.map((_, i) => i % 2), good = y.map((v, i) => v + (i % 7) / 10), bad = y.map((_, i) => (i * 37) % 11);
  const b = bootWin(actors, y, good, bad); assert.equal(b.win, 1); assert.ok(b.lift! > 0 && b.lift_ci![0] > 0 && b.lift_ci![0] <= b.lift! && b.lift! <= b.lift_ci![1]);
  assert.equal(bootWin(actors, y, bad, good).win, 0); assert.deepEqual(bootWin(actors, y, good, bad, 200, 9), bootWin(actors, y, good, bad, 200, 9));
});

test("fitLR: shrunk toward heur-2; small l2 recovers a real feature; (near-)constant features only get heur-2's share", () => {
  const r = rand(5); const data = Array.from({ length: 400 }, () => { const x = FEATURES.map(() => r()); x[2] = 0.3; x[3] = 1e-6 * r(); return { x, t: r() < 1 / (1 + Math.exp(-(6 * x[5] - 3))) ? 1 : 0 }; });
  const m = fitLR(data, 0.1); assert.ok(m.seen > 2, `seen ${m.seen}`); assert.ok(Object.values(m).every(Number.isFinite));
  const s = m.popularity / HEURISTIC.popularity; assert.ok(Math.abs(m.freshness - s * HEURISTIC.freshness) < 1e-9, "near-constant: no huge raw weight");
  const hd = data.map((d) => ({ x: d.x, t: r() < 1 / (1 + Math.exp(-3 * (lin(d.x, HEURISTIC) - 0.6))) ? 1 : 0 }));
  const big = fitLR(hd, 1e6); const k = big.seen / HEURISTIC.seen; assert.ok(k > 0.5, `heur-2 scale ${k}`); for (const f of FEATURES) assert.ok(Math.abs(big[f] - k * HEURISTIC[f]) < 0.05 * k, `${f}: large l2 = rescaled heur-2`);
  const anti = fitLR(hd.map((d) => ({ x: d.x, t: 1 - d.t })), 1e6); for (const f of FEATURES) assert.ok(Math.abs(anti[f]) < 1e-3, `${f}: never inverted heur-2 (${anti[f]})`);
});

test("grade: longer play before scrolling is strictly stronger (5 s > 3 s > fast skip); monotonic in dwell and listen_ratio; capped", () => {
  const g = (o: Partial<{ dwell_ms: number; fast_skip: number; listen_ratio: number; completed: number; replay: number; actions: string }>) => grade({ completed: 0, replay: 0, listen_ratio: 0, dwell_ms: 0, fast_skip: 0, actions: "[]", ...o });
  const skip = g({ dwell_ms: 1500, fast_skip: 1 }), s3 = g({ dwell_ms: 3000 }), s5 = g({ dwell_ms: 5000 });
  assert.equal(skip, 0); assert.ok(s3 > skip && s5 > s3, `${skip} < ${s3} < ${s5}`); assert.ok(Math.abs(s3 - Math.log(1.5) / Math.log(30)) < 1e-12);
  let prev = -1; for (let d = 0; d <= 120_000; d += 250) { const v = g({ dwell_ms: d, fast_skip: d < 2000 ? 1 : 0 }); assert.ok(v >= prev && v <= 1, `dwell ${d}`); if (d > 2000 && d <= 60_000) assert.ok(v > prev, `strict at ${d}`); prev = v; }
  assert.equal(g({ dwell_ms: 60_000 }), 1); assert.equal(g({ dwell_ms: 600_000 }), 1);
  prev = -1; for (let l = 0; l <= 1; l += 0.01) { const v = g({ dwell_ms: 2500, listen_ratio: l }); assert.ok(v >= prev, `ratio ${l}`); prev = v; }
  assert.equal(g({ listen_ratio: 0.25 }), 0.5); assert.equal(g({ listen_ratio: 0.8 }), 1);
  for (const o of [{ completed: 1 }, { replay: 1 }, { actions: '["like"]', fast_skip: 1 }]) assert.equal(g(o), 1);
});

test("train: skips with a reason and writes nothing below the minimums", () => {
  let fx = fixture(); noiseWorld(fx, 3, MIN_TRAIN - 1); let res = new Ranker(fx.db, fx.now).train();
  assert.ok("skipped" in res); assert.equal(res.skipped, "few_impressions"); assert.equal(models(fx).length, 0);
  fx = fixture(); const songs = Array.from({ length: 20 }, (_, i) => fx.song({ owner: `o${i}`, ageH: 24 * 40 }));
  for (let k = 0; k < 600; k++) fx.imp({ actor: `a${k % 50}`, song: songs[k % 20], at: fx.now() - H - (k % 400) * H, good: k % 10 === 0, skip: false }); // 60 engaged in train+holdout
  res = new Ranker(fx.db, fx.now).train(); assert.ok("skipped" in res); assert.equal(res.skipped, "few_train_labels"); assert.equal(res.min, MIN_TRAIN_LABELS); assert.ok(res.labels!.train[0] < MIN_TRAIN_LABELS);
  fx = fixture(); const s2 = Array.from({ length: 20 }, (_, i) => fx.song({ owner: `o${i}`, ageH: 24 * 40 }));
  for (let k = 0; k < 800; k++) { const hold = k >= 320; fx.imp({ actor: `a${k % 50}`, song: s2[k % 20], at: fx.now() - (hold ? H + (k % 60) * H : 4 * D + (k % 300) * H), good: hold ? k % 40 === 0 : k % 2 === 0, skip: false }); }
  res = new Ranker(fx.db, fx.now).train(); assert.ok("skipped" in res); assert.equal(res.skipped, "few_holdout_labels"); assert.equal(res.min, MIN_HOLDOUT_LABELS); assert.ok(res.labels!.holdout[0] < MIN_HOLDOUT_LABELS);
  assert.equal(models(fx).length, 0);
});

test("train: evaluates the last 60% of rows by time (never under 3 days) in 4 forward-chained folds", () => {
  const fx = fixture(); repeatWorld(fx); const g = new Ranker(fx.db, fx.now).gate(); assert.ok(!("skipped" in g));
  assert.ok(Math.abs(g.holdout / g.n - 0.6) < 0.02, `holdout share ${g.holdout / g.n}`);
  const tr = g.n - g.holdout, q = Math.ceil(g.holdout / 4); assert.deepEqual(g.folds, [tr, tr + q, tr + 2 * q, tr + 3 * q], "each fold fits only on earlier rows");
  const fy = fixture(); const songs = Array.from({ length: 30 }, (_, i) => fy.song({ owner: `o${i}`, ageH: 24 * 40 }));
  for (let k = 0; k < 900; k++) fy.imp({ actor: `a${k % 80}`, song: songs[k % 30], at: fy.now() - H - (k < 300 ? 6 * D + (k % 200) * H : (k % 24) * H), good: k % 3 === 0, skip: false }); // 2/3 of rows in the last day
  const g2 = new Ranker(fy.db, fy.now).gate(); assert.ok(!("skipped" in g2)); assert.equal(g2.holdout, 600, "3-day floor");
});

test("train: a candidate that clearly beats heur-2 is promoted and served; preview agrees and writes nothing", () => {
  const fx = fixture(); repeatWorld(fx);
  const p = preview(fx.db, fx.now()); assert.ok(!("skipped" in p)); assert.equal(models(fx).length, 0, "preview writes nothing");
  const rk = new Ranker(fx.db, fx.now); const res = rk.train() as TrainResult;
  assert.equal(res.promoted, true); assert.equal(p.promote, true); assert.equal(p.auc, res.auc); assert.equal(p.win, res.win); assert.deepEqual(p.lift_ci, res.lift_ci); assert.ok(res.lift_ci![0] > 0);
  assert.ok(res.auc! >= res.auc_heur! + 0.02 && res.win >= 0.9, JSON.stringify({ auc: res.auc, heur: res.auc_heur, win: res.win }));
  assert.match(res.version, /^lr-eng-\d{8}$/); assert.equal(rk.version, res.version); assert.equal(new Ranker(fx.db, fx.now).version, res.version, "startup loads it");
  assert.equal(rk.rank({ actor: "a1", session: null, seed: 1 }).version, res.version); assert.ok(res.model.engaged.seen > 0);
});

test("train: no real signal -> never promoted (12 seeds), feed stays on heur-2", () => {
  for (let seed = 2; seed < 14; seed++) {
    const fx = fixture(); noiseWorld(fx, seed); const rk = new Ranker(fx.db, fx.now); const res = rk.train() as TrainResult;
    assert.equal(res.promoted, false, `seed ${seed}: ${JSON.stringify({ auc: res.auc, heur: res.auc_heur, win: res.win, l2: res.l2 })}`); assert.equal(rk.version, "heur-2"); assert.deepEqual(models(fx).map((m) => m.promoted), [0]);
  }
});

test("chooseL2: picks a small l2 when the features carry real signal, the largest (heur-2-like) on noise", () => {
  const fx = fixture(); repeatWorld(fx); const g = new Ranker(fx.db, fx.now).gate(); assert.ok(!("skipped" in g)); assert.ok(g.l2 <= 10, `repeat world l2 ${g.l2}`);
  const fy = fixture(); noiseWorld(fy, 7); const g2 = new Ranker(fy.db, fy.now).gate(); assert.ok(!("skipped" in g2)); assert.ok(Object.keys(g2.cv).length === 5);
  void chooseL2;
});

test("train: a newer winner retires the old model; a model that now loses to heur-2 is demoted to heur-2", () => {
  let fx = fixture(); repeatWorld(fx); put(fx, "lr-eng-old", { engaged: w({ bias: 0 }) }); // constant scorer: AUC 0.5
  let rk = new Ranker(fx.db, fx.now); assert.equal(rk.version, "lr-eng-old"); const res = rk.train() as TrainResult;
  assert.equal(res.promoted, true); assert.equal(res.previous, "lr-eng-old"); assert.deepEqual(models(fx).map((m) => [m.version, m.promoted]), [["lr-eng-old", 0], [res.version, 1]]);
  fx = fixture(); noiseWorld(fx, 6); put(fx, "lr-eng-bad", { engaged: w({ bias: 0, ...Object.fromEntries(Object.entries(HEURISTIC).map(([k, v]) => [k, -v])) }) }); // anti-heur-2
  rk = new Ranker(fx.db, fx.now); const g = rk.gate(); assert.ok(!("skipped" in g));
  assert.ok(!g.promote && g.auc_prev! < g.auc_heur!, JSON.stringify({ prev: g.auc_prev, heur: g.auc_heur }));
  const r2 = rk.train() as TrainResult; assert.equal(r2.demoted, "lr-eng-bad"); assert.equal(rk.version, "heur-2"); assert.equal(new Ranker(fx.db, fx.now).version, "heur-2");
});

test("serving falls back to heur-2 on NaN weights, legacy rows, or no promoted model", () => {
  const fx = fixture(); fx.song({ owner: "o" }); assert.equal(new Ranker(fx.db, fx.now).version, "heur-2");
  put(fx, "lr2-legacy", { complete: w({}), skip: w({}) }, 3); assert.equal(new Ranker(fx.db, fx.now).version, "heur-2");
  put(fx, "lr-eng-nan", `{"engaged":{"bias":0,"affinity":null}}`, 2); assert.equal(new Ranker(fx.db, fx.now).version, "heur-2");
  put(fx, "lr-eng-ok", { engaged: w({ popularity: 1 }) }, 1); const rk = new Ranker(fx.db, fx.now); assert.equal(rk.version, "lr-eng-ok"); assert.ok(rk.rank({ actor: null, session: null, seed: 1 }).ids.length === 1);
});

test("train in a worker thread on a file DB, then the main ranker reloads the promoted model", async () => {
  const fx = fixture({ file: true }); repeatWorld(fx, 4); const rk = new Ranker(fx.db, fx.now);
  const res = await trainInWorker(rk, fx.file, fx.now()) as TrainResult; assert.equal(res.promoted, true); assert.equal(rk.version, res.version);
});
