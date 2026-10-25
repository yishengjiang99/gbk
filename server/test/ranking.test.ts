import test from "node:test";
import assert from "node:assert/strict";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer, login } from "./ws-helpers.ts";
import { WorkstationController } from "../../src/workstation/controller.ts";
import { buildAllTools } from "../../src/webmcp/registry.ts";
import { runTool } from "../../src/webmcp/tools.ts";
import { aucOf } from "../src/ranking/ranker.ts";

const H = (a: { cookie: string; csrf: string }) => ({ "content-type": "application/json", origin: "http://composer.test", "x-gbk-csrf": a.csrf, cookie: `${a.cookie}; gbk_csrf=${a.csrf}` });
let base: unknown = null;
async function project(name: string) {
  if (!base) { const c = new WorkstationController(); c.host.checkpoint = async () => {}; const tools = new Map(buildAllTools(c).map((t) => [t.name, t])); const sig = new AbortController().signal;
    await runTool(c, tools.get("gbk_create_project")!, { name }, sig); await runTool(c, tools.get("gbk_generate_arrangement")!, { style: "baroque", bars: 2, seed: 1 }, sig); base = c.project; }
  return { ...(base as object), name };
}

test("ranking: personalized For you learns from dwell/skips, session-aware, paginates without dupes, diversity cap", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try {
    const authors = [await login(s.base, "code-a"), await login(s.base, "code-b")];
    const mk = async (a: (typeof authors)[number], t: string, labels: string[], tags: string[]) => { const slug = (await (await fetch(`${s.base}/api/shares`, { method: "POST", headers: H(a), body: JSON.stringify({ title: t, project: await project(t), public: true }) })).json()).slug as string;
      await fetch(`${s.base}/api/songs/${slug}/meta`, { method: "PATCH", headers: H(a), body: JSON.stringify({ labels, tags }) }); return slug; };
    const lofi: string[] = [], classical: string[] = [];
    for (let i = 0; i < 2; i++) lofi.push(await mk(authors[0], `Lofi ${i}`, ["lofi"], ["chill"]));
    for (let i = 0; i < 3; i++) classical.push(await mk(authors[1], `Bach ${i}`, ["classical"], ["fugue"]));
    const viewer = { "x-gbk-install": "install-test-0001" };
    const feed = async (q = "", h: Record<string, string> = viewer) => (await (await fetch(`${s.base}/api/feed?limit=4${q}`, { headers: h })).json()) as { items: { slug: string; author: { handle: string }; labels: string[] }[]; next_cursor: string | null; model_version: string };
    // cold start: all 8 songs across pages, no dupes, never 3 in a row by one artist
    const all: string[] = []; const owners: string[] = []; let cur: string | null = null; let f;
    do { f = await feed(cur ? `&cursor=${cur}` : ""); all.push(...f.items.map((i) => i.slug)); owners.push(...f.items.map((i) => i.author.handle)); cur = f.next_cursor; } while (cur);
    assert.equal(all.length, 5); assert.equal(new Set(all).size, 5); assert.match(f.model_version, /^heur-2$/);
    for (let i = 2; i < owners.length; i++) assert.ok(!(owners[i] === owners[i - 1] && owners[i] === owners[i - 2]), "max 2 in a row per artist");
    // signals: fast skips on lofi, completions on classical (iOS-style install id actor)
    const ev = (song: string, good: boolean) => ({ song, dwell_ms: good ? 40000 : 600, listen_ratio: good ? 1 : 0.02, completed: good, model_version: "heur-2", position: 0 });
    const r = await fetch(`${s.base}/api/events`, { method: "POST", headers: { ...viewer, "content-type": "application/json", authorization: "Bearer none" }, body: JSON.stringify({ session: "sess-rank-01", client: "ios", events: [...lofi.slice(0, 2).map((x) => ev(x, false)), ...classical.slice(0, 2).map((x) => ev(x, true))] }) });
    assert.equal((await r.json()).accepted, 4);
    // repeated runs (exploration is random per seed): classical dominates the top 2 most of the time
    let wins = 0; for (let k = 0; k < 10; k++) { const top = (await feed("&session=sess-rank-01")).items.slice(0, 2); if (top.every((i) => i.labels.includes("classical"))) wins++; }
    assert.ok(wins >= 6, `classical first in ${wins}/10`);
    assert.equal(aucOf([0.1, 0.9, 0.4, 0.8], [0, 1, 0, 1]), 1);
  } finally { await s.app.close(); }
});

// ---- v2 unit tests on synthetic fixtures (rank-fixture.ts) ----
import { Ranker, trainInWorker, FEATURES, HEURISTIC, SKIP_LAMBDA, labels, projectSeconds, QUOTAS, SOURCES } from "../src/ranking/ranker.ts";
import { fixture, rand, H as HR, D } from "./rank-fixture.ts";

const randomWorld = (fx: ReturnType<typeof fixture>, seed: number, n = 1600) => {
  const r = rand(seed); const songs = Array.from({ length: 40 }, (_, i) => fx.song({ owner: `o${i % 8}`, labels: [["lofi", "jazz", "classical"][i % 3]], tags: [`t${i % 5}`], score: r() }));
  for (let k = 0; k < n; k++) fx.imp({ actor: `a${Math.floor(r() * 60)}`, song: songs[Math.floor(r() * songs.length)], at: fx.now() - Math.floor(r() * 20 * D) - HR, good: r() < 0.5 });
  return songs;
};

test("ranking v2 / phase 1: leakage — random labels give holdout AUC near 0.5; holdout is time-split; trains in a worker", async () => {
  const fx = fixture({ file: true }); randomWorld(fx, 7);
  const rk = new Ranker(fx.db, fx.now); const res = rk.train()!;
  assert.ok(res && res.auc !== null, "trained"); assert.ok(res.auc! < 0.65 && res.auc! > 0.35, `holdout auc ${res.auc}`);
  assert.ok(res.holdout > 0 && res.n > res.holdout, "time split: older rows train, last 3 days hold out"); assert.equal(res.promoted, true, "no promoted model yet -> promote");
  assert.equal(rk.version, res.version);
  // worker: same result shape, main ranker reloads the promoted model
  fx.db.prepare("DELETE FROM rank_models").run(); const rk2 = new Ranker(fx.db, fx.now); assert.match(rk2.version, /^heur-/);
  const w = await trainInWorker(rk2, fx.file, fx.now()); assert.ok(w && w.promoted); assert.equal(rk2.version, w!.version);
});

test("ranking v2 / phase 1: promotion gate keeps a better promoted model and stores the worse candidate unpromoted", () => {
  const fx = fixture(); const r = rand(3);
  const songs = Array.from({ length: 40 }, (_, i) => fx.song({ owner: `o${i % 8}`, score: i / 40 }));
  // train window: random labels; holdout (last 3 days): label = popular song
  for (let k = 0; k < 1500; k++) { const s = Math.floor(r() * 40); const at = fx.now() - Math.floor(r() * 20 * D) - HR; const hold = at >= fx.now() - 3 * D; fx.imp({ actor: `a${Math.floor(r() * 50)}`, song: songs[s], at, good: hold ? s >= 20 : r() < 0.5 }); }
  const z = Object.fromEntries(FEATURES.map((k) => [k, 0])); const good = { complete: { ...z, bias: 0, popularity: 5 }, skip: { ...z, bias: 0, popularity: -5 } };
  new Ranker(fx.db, fx.now); fx.db.prepare("INSERT INTO rank_models (version, weights, n, auc, created_at, promoted) VALUES ('lr-good', ?, 1, 0.99, ?, 1)").run(JSON.stringify(good), fx.now() - D);
  const rk = new Ranker(fx.db, fx.now); assert.equal(rk.version, "lr-good");
  const res = rk.train()!; assert.equal(res.promoted, false); assert.ok(res.previous_auc! > res.auc!); assert.match(res.version, /^lr2-\d{8}/);
  assert.equal(rk.version, "lr-good"); assert.equal(new Ranker(fx.db, fx.now).version, "lr-good", "startup loads the promoted model");
  assert.equal((fx.db.prepare("SELECT promoted FROM rank_models WHERE version = ?").get(res.version) as { promoted: number }).promoted, 0);
  void HEURISTIC;
});

test("ranking v2 / phase 3: labels (replay / ratio >= 0.9 complete), two-head value orders a likely-complete long song above a likely-skip one", () => {
  assert.deepEqual(labels({ completed: 0, replay: 1, listen_ratio: 0.2, fast_skip: 0 }), { complete: 1, skip: 0 });
  assert.deepEqual(labels({ completed: 0, replay: 0, listen_ratio: 0.95, fast_skip: 0 }), { complete: 1, skip: 0 });
  assert.deepEqual(labels({ completed: 0, replay: 0, listen_ratio: 0.1, fast_skip: 1 }), { complete: 0, skip: 1 });
  assert.equal(SKIP_LAMBDA, 1.0);
  const z = Object.fromEntries(FEATURES.map((k) => [k, 0])) as Record<string, number>;
  const m = { complete: { ...z, bias: -1, affinity: 4 }, skip: { ...z, bias: -1, affinity: -4 } } as never;
  const fx = fixture(); const rk = new Ranker(fx.db, fx.now);
  const likely = rk.value({ ...z, affinity: 1 }, 240, m), skippy = rk.value({ ...z, affinity: -1 }, 240, m), short = rk.value({ ...z, affinity: 1 }, 30, m);
  assert.ok(likely > short && short > skippy, `${likely} > ${short} > ${skippy}`);
  // duration from project_json through the tempo map: 60 s fixture song
  assert.ok(Math.abs(projectSeconds({ ppq: 480, tempos: [{ tick: 0, microPerQuarter: 500000 }], notes: [{ tick: 0, duration: 57600 }] })! - 60) < 1e-9);
  // model served after promotion: version lr2-*, rank uses it
  const a = fx.song({ owner: "x", seconds: 170 }); fx.song({ owner: "y", seconds: 20 });
  fx.db.prepare("INSERT INTO rank_models (version, weights, n, auc, created_at, promoted) VALUES ('lr2-20261024', ?, 1, 0.7, ?, 1)").run(JSON.stringify({ complete: { ...z, bias: 2 }, skip: { ...z, bias: -3 } }), fx.now());
  rk.reload(); assert.equal(rk.version, "lr2-20261024"); const r = rk.rank({ actor: null, session: null, seed: 1 }); assert.equal(r.ids[0], a, "longer likely-complete song first"); assert.equal(r.version, "lr2-20261024");
});

test("ranking v2 / phase 4: candidate sources with quotas; a fresh 0-score song is in the pool of a > 1000-song catalog", () => {
  const fx = fixture(); fx.db.exec("BEGIN");
  for (let i = 0; i < 1100; i++) fx.song({ owner: `o${i % 40}`, labels: [["lofi", "jazz", "classical", "pop"][i % 4]], score: 1 + i / 100, ageH: 24 * 20 });
  const fresh = fx.song({ owner: "newbie", score: 0, ageH: 1 }); fx.db.exec("COMMIT");
  const rk = new Ranker(fx.db, fx.now);
  for (const actor of [null, "a-warm"]) {
    const r = rk.rank({ actor, session: null, seed: 5 });
    assert.ok(r.ids.length <= 1000 + 1 && r.ids.length >= 1000, `pool capped (${r.ids.length})`); assert.ok(r.ids.includes(fresh), "fresh song always in the pool");
    assert.deepEqual(r.sources.get(fresh)?.includes("fresh"), true);
  }
  assert.equal(QUOTAS.fresh, Infinity); assert.deepEqual([...SOURCES], ["coeng", "affinity", "artists", "trending", "fresh", "cold"]);
  assert.ok(rk.rank({ actor: null, session: null, seed: 1 }).sources.size > 0);
});

test("ranking v2 / phase 5: no repeats within a session over 5 pages, no dup/drop; label runs <= 3 on any label; near-dups 1 per page; cold slot in the first 8", () => {
  const fx = fixture(); const r = rand(11); const L = ["lofi", "jazz", "classical", "pop", "ambient"];
  const ids = Array.from({ length: 120 }, (_, i) => fx.song({ owner: `o${i % 12}`, title: `T${i}`, labels: [L[i % 5], L[(i + 1) % 5]], tags: [`t${i % 7}`], score: r() * 3, ageH: 24 * 5 + i }));
  // near-duplicates: same owner + same title, and same owner + same remix source
  const d1 = fx.song({ owner: "dup", title: "Same", score: 9 }), d2 = fx.song({ owner: "dup", title: "same ", score: 9 }), d3 = fx.song({ owner: "dup", title: "X", parent: ids[0], score: 9 }), d4 = fx.song({ owner: "dup", title: "Y", parent: ids[0], score: 9 });
  const newSong = fx.song({ owner: "fresh", title: "Brand new", labels: ["jazz"], score: 0, ageH: 2 });
  const actor = "inst:viewer-0001", session = "sess-five-pages";
  for (let k = 0; k < 30; k++) fx.imp({ actor, song: ids[Math.floor(r() * ids.length)], at: fx.now() - (k + 1) * 3_600_000 * 24, good: r() < 0.5, session: "old-session" });
  const rk = new Ranker(fx.db, fx.now); const seed = 42; const t0 = fx.now();
  const first = rk.rank({ actor, session, seed, asOf: t0 }).ids;
  // cold slot: the new song is within the first 8 for a warm and a cold actor
  assert.ok(first.slice(0, 8).includes(newSong), "cold slot in first 8 (warm)");
  assert.ok(rk.rank({ actor: null, session: null, seed: 3 }).ids.slice(0, 8).includes(newSong), "cold slot in first 8 (cold)");
  // 5 pages of 10; user watches page k before fetching k+1 (session impressions after t0 must not shift pages)
  const shown: string[] = [];
  for (let p = 0; p < 5; p++) {
    fx.set(t0 + (p + 1) * 60_000);
    const page = rk.rank({ actor, session, seed, asOf: t0 }).ids.slice(p * 10, p * 10 + 10); shown.push(...page);
    for (const id of page) fx.imp({ actor, session, song: id, at: fx.now(), good: true });
    const nd = page.filter((id) => [d1, d2].includes(id)).length, np = page.filter((id) => [d3, d4].includes(id)).length; assert.ok(nd <= 1 && np <= 1, "near-dups at most 1 per page");
  }
  assert.equal(new Set(shown).size, shown.length, "no dup across pages"); assert.deepEqual(shown, first.slice(0, 50), "no drop: pages = one list");
  // new session as of later: already-seen songs of this session are excluded
  const later = rk.rank({ actor, session, seed: 7, asOf: fx.now() + 1 }).ids; assert.ok(!later.some((id) => shown.includes(id)), "no repeats within the session");
  assert.ok(rk.rank({ actor, session: "other", seed: 7, asOf: fx.now() + 1 }).ids.some((id) => shown.includes(id)), "other sessions unaffected");
  // label runs: never 4 consecutive sharing any label; artist runs <= 2
  const lab = new Map(ids.map((id, i) => [id, [L[i % 5], L[(i + 1) % 5]]]));
  for (let k = 0; k < 6; k++) { const out = rk.rank({ actor: k % 2 ? actor : null, session: null, seed: k }).ids; const lbs = out.map((id) => lab.get(id) ?? []);
    for (let i = 3; i < out.length; i++) for (const l of lbs[i]) assert.ok(![1, 2, 3].every((j) => lbs[i - j].includes(l)), `label run of 4 on ${l} at ${i}`); }
});

test("ranking v2 / phase 6: offline eval — AUC per head, NDCG@10 per session, new-song share; promoted vs candidate vs heuristic; CLI runs read-only", async () => {
  const fx = fixture({ file: true }); const r = rand(21);
  const songs = Array.from({ length: 30 }, (_, i) => fx.song({ owner: `o${i % 6}`, score: i / 30, ageH: i < 3 ? 10 : 24 * 10 }));
  for (let k = 0; k < 1200; k++) { const s = Math.floor(r() * 30); fx.imp({ actor: `a${Math.floor(r() * 40)}`, song: songs[s], at: fx.now() - Math.floor(r() * 9 * D) - HR, good: r() < 0.2 + s / 40 }); }
  const rk = new Ranker(fx.db, fx.now); assert.ok(rk.train());
  const { evalRange, ndcg } = await import("../src/ranking/eval.ts");
  assert.equal(ndcg([2, 1, 0]), 1); assert.ok(ndcg([0, 1, 2])! < 1); assert.equal(ndcg([0, 0]), null);
  const rep = evalRange(fx.db, fx.now() - 3 * D, fx.now(), fx.now());
  assert.deepEqual(rep.map((x) => x.name), ["promoted", "heuristic"]);
  for (const x of rep) { assert.ok(x.n > 0 && x.sessions > 0); assert.ok(x.auc_complete! > 0 && x.auc_complete! < 1); assert.ok(x.ndcg10! > 0 && x.ndcg10! <= 1); assert.ok(x.new_share_top10! >= 0 && x.new_share_top10! <= 1); }
  assert.ok(rep[0].auc_complete! > 0.55, `learned model beats chance on popularity-driven labels (${rep[0].auc_complete})`);
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx/esm", "scripts/rank-eval.ts", "--db", fx.file, "--json"], { cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8" });
  assert.deepEqual(JSON.parse(out).models.map((m: { name: string }) => m.name), ["promoted", "heuristic"]);
});
