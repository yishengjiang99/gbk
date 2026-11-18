import test from "node:test";
import assert from "node:assert/strict";
import { hookStartMs, hookStartMsFromProject, hookStartMsFromShare } from "../../src/social/hook-start.ts";
import { DEFAULT_MIX, computeEndTick, emptyProject, type Project } from "../../src/workstation/model.ts";
import { ShareStore } from "../src/persistence/shares.ts";
import { SocialStore } from "../src/persistence/social.ts";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer, login } from "./ws-helpers.ts";
import { WorkstationController } from "../../src/workstation/controller.ts";
import { buildAllTools } from "../../src/webmcp/registry.ts";
import { runTool } from "../../src/webmcp/tools.ts";

const H = (a: { cookie: string; csrf: string }) => ({ "content-type": "application/json", origin: "http://composer.test", "x-gbk-csrf": a.csrf, cookie: `${a.cookie}; gbk_csrf=${a.csrf}` });

/** 120 BPM, 480 ppq: 1 beat = 500 ms, 1 bar = 2000 ms. */
function project(notes: { tick: number; dur?: number; pitch?: number; vel?: number }[], bpm = 120): Project {
  const p = emptyProject("Hook");
  p.tempos = [{ tick: 0, microPerQuarter: Math.round(60_000_000 / bpm) }];
  p.tracks = [{ id: "t1", name: "Lead", channel: 0, color: "#4fc3f7", mix: { ...DEFAULT_MIX }, visible: true }];
  p.notes = notes.map((n, i) => ({ id: `n${i}`, trackId: "t1", channel: 0, tick: n.tick, duration: n.dur ?? 120, pitch: n.pitch ?? 60, velocity: n.vel ?? 80 }));
  p.endTick = computeEndTick(p);
  return p;
}

test("hook detector: empty song returns null", () => {
  assert.equal(hookStartMs([]), null);
  assert.equal(hookStartMs([], 12_000), null);
  assert.equal(hookStartMsFromProject(emptyProject()), null);
  assert.equal(hookStartMsFromShare(JSON.stringify(emptyProject()), null), null);
});

test("hook detector: short song with notes returns 0", () => {
  // 2 bars at 120 BPM = 4 s, under the 8 s window.
  const p = project([{ tick: 0, vel: 90 }, { tick: 480, vel: 90 }, { tick: 1920, vel: 100 }]);
  assert.equal(hookStartMsFromProject(p), 0);
  assert.equal(hookStartMs([{ tMs: 0, vel: 80, pitch: 60 }, { tMs: 2_000, vel: 90, pitch: 64 }], 3_500), 0);
});

test("hook detector: dense chorus after a sparse intro", () => {
  const onsets = [];
  for (let t = 0; t < 16_000; t += 2_000) onsets.push({ tMs: t, vel: 20, pitch: 60 });
  for (let t = 16_000; t < 28_000; t += 125) onsets.push({ tMs: t, vel: 110, pitch: 72 });
  const hook = hookStartMs(onsets, 28_000);
  assert.ok(hook != null, "expected a hook");
  assert.ok(Math.abs(hook! - 16_000) <= 500, `hook ${hook} should be the chorus start (~16000)`);

  const ticks = [];
  for (let bar = 0; bar < 8; bar++) ticks.push({ tick: bar * 1920, vel: 20, pitch: 60 });
  for (let t = 8 * 1920; t < 14 * 1920; t += 120) ticks.push({ tick: t, vel: 110, pitch: 72 });
  const fromProj = hookStartMsFromProject(project(ticks));
  assert.ok(fromProj != null);
  assert.ok(Math.abs(fromProj! - 16_000) <= 500, `project hook ${fromProj} should be the chorus start`);
});

test("hook detector: first return of a repeated section", () => {
  // 8 s motif A, 8 s contrasting B, 8 s A again. Same density, so the hook is the return of A (~16 s).
  const onsets = [];
  const motif = (t0: number, pitches: number[]) => {
    for (let t = 0; t < 8_000; t += 250) onsets.push({ tMs: t0 + t, vel: 90, pitch: pitches[(t / 250) % pitches.length] });
  };
  motif(0, [60, 64, 67, 72]);
  motif(8_000, [62, 65, 69, 74]);
  motif(16_000, [60, 64, 67, 72]);
  const hook = hookStartMs(onsets, 24_000);
  assert.ok(hook != null);
  assert.ok(Math.abs(hook! - 16_000) <= 500, `hook ${hook} should be the first return of A (~16000)`);
});

test("hook backfill fills nulls only and is idempotent", () => {
  const shares = new ShareStore(":memory:");
  const dense = [];
  for (let bar = 0; bar < 8; bar++) dense.push({ tick: bar * 1920, vel: 20, pitch: 60 });
  for (let t = 8 * 1920; t < 14 * 1920; t += 120) dense.push({ tick: t, vel: 110, pitch: 72 });
  const json = JSON.stringify(project(dense));
  const fresh = shares.create({ owner: "a", title: "Old", projectJson: json, public: false });
  shares.database.prepare("UPDATE shares SET public = 1, hook_start_ms = NULL WHERE id = ?").run(fresh.id);
  const kept = shares.create({ owner: "a", title: "Kept", projectJson: json, public: true });
  shares.database.prepare("UPDATE shares SET hook_start_ms = 99999 WHERE id = ?").run(kept.id);
  new SocialStore(shares.database);
  const a = shares.database.prepare("SELECT hook_start_ms AS h FROM shares WHERE id = ?").get(fresh.id) as { h: number | null };
  const b = shares.database.prepare("SELECT hook_start_ms AS h FROM shares WHERE id = ?").get(kept.id) as { h: number | null };
  assert.ok(a.h != null && a.h !== 99999, `backfill should fill the null hook, got ${a.h}`);
  assert.ok(Math.abs(a.h! - 16_000) <= 500, `backfilled hook ${a.h} should be the chorus`);
  assert.equal(b.h, 99999, "existing hook must not be overwritten");
  new SocialStore(shares.database);
  const a2 = shares.database.prepare("SELECT hook_start_ms AS h FROM shares WHERE id = ?").get(fresh.id) as { h: number | null };
  assert.equal(a2.h, a.h);
});

test("hook_start_ms is present on feed, song detail, and profile lists", { timeout: 60_000 }, async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try {
    const alice = await login(s.base, "code-a");
    const c = new WorkstationController(); c.host.checkpoint = async () => {};
    const tools = new Map(buildAllTools(c).map((t) => [t.name, t]));
    const sig = new AbortController().signal;
    await runTool(c, tools.get("gbk_create_project")!, { name: "Hook Song" }, sig);
    await runTool(c, tools.get("gbk_generate_arrangement")!, { style: "baroque", bars: 2, seed: 1 }, sig);
    const r = await fetch(`${s.base}/api/shares`, { method: "POST", headers: H(alice), body: JSON.stringify({ title: "Hook Song", project: c.project, public: true }) });
    assert.equal(r.status, 200, await r.clone().text());
    const slug = (await r.json()).slug as string;
    const song = await (await fetch(`${s.base}/api/songs/${slug}`)).json();
    assert.ok("hook_start_ms" in song, "GET /api/songs/:slug must include hook_start_ms");
    assert.equal(song.hook_start_ms, 0, "a short published song hooks at 0");
    const feed = await (await fetch(`${s.base}/api/feed?sort=new`)).json();
    const item = feed.items.find((i: { slug: string }) => i.slug === slug);
    assert.ok(item, "song should appear in the feed");
    assert.ok("hook_start_ms" in item, "GET /api/feed must include hook_start_ms");
    assert.equal(item.hook_start_ms, 0);
    const profile = await (await fetch(`${s.base}/api/users/alice`)).json();
    const listed = profile.songs.find((i: { slug: string }) => i.slug === slug);
    assert.ok(listed, "song should appear on the profile list");
    assert.ok("hook_start_ms" in listed, "GET /api/users/:handle songs must include hook_start_ms");
    assert.equal(listed.hook_start_ms, 0);
  } finally { await s.app.close(); }
});
