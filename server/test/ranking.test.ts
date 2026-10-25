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
import { Ranker, trainInWorker, FEATURES, HEURISTIC } from "../src/ranking/ranker.ts";
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
  const good = { ...Object.fromEntries(FEATURES.map((k) => [k, 0])), bias: 0, popularity: 5 };
  new Ranker(fx.db, fx.now); fx.db.prepare("INSERT INTO rank_models (version, weights, n, auc, created_at, promoted) VALUES ('lr-good', ?, 1, 0.99, ?, 1)").run(JSON.stringify(good), fx.now() - D);
  const rk = new Ranker(fx.db, fx.now); assert.equal(rk.version, "lr-good");
  const res = rk.train()!; assert.equal(res.promoted, false); assert.ok(res.previous_auc! > res.auc!);
  assert.equal(rk.version, "lr-good"); assert.equal(new Ranker(fx.db, fx.now).version, "lr-good", "startup loads the promoted model");
  assert.equal((fx.db.prepare("SELECT promoted FROM rank_models WHERE version = ?").get(res.version) as { promoted: number }).promoted, 0);
  void HEURISTIC;
});
