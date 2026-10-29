import test from "node:test";
import assert from "node:assert/strict";
import { transpose, invert, retrograde, scaleTime, sequence, fitRange, motion, parallelPerfects, estimateKey, estimateChord, counterpoint, analyze } from "../src/music/theory.ts";
import { WorkstationController } from "../src/workstation/controller.ts";
import { buildAllTools } from "../src/webmcp/registry.ts";
import { runTool } from "../src/webmcp/tools.ts";
import { emptyProject } from "../src/workstation/model.ts";

const N = (tick: number, pitch: number, duration = 480) => ({ tick, pitch, duration, velocity: 80 });
const cScale = [60, 62, 64, 65, 67, 69, 71, 72].map((p, i) => N(i * 480, p));

test("transforms", () => {
  assert.equal(transpose([N(0, 60)], 7)[0].pitch, 67);
  assert.equal(invert([N(0, 64)], 60)[0].pitch, 56);
  assert.deepEqual(retrograde([N(0, 60), N(480, 62)]).map((n) => n.pitch), [62, 60]);
  assert.equal(scaleTime([N(0, 60), N(480, 62)], 2)[1].tick, 960);
  assert.equal(sequence([N(0, 60)], 3, 480, 2)[2].pitch, 64);
  assert.equal(fitRange([N(0, 40)], 55, 70)[0].pitch, 64);
});

test("motion + parallel fifths detection", () => {
  assert.equal(motion(60, 62, 48, 46), "contrary");
  assert.equal(motion(60, 62, 53, 55), "parallel");
  const up = [N(0, 67), N(480, 69)], lo = [N(0, 60), N(480, 62)];
  assert.equal(parallelPerfects(up, lo)[0].interval, "P5");
  assert.equal(parallelPerfects([N(0, 67), N(480, 65)], lo).length, 0);
});

test("key estimate heuristic finds C major on a C scale", () => {
  const k = estimateKey(cScale);
  assert.equal(k.label, "C major"); assert.match(k.method, /heuristic/);
});

test("counterpoint deterministic per seed, stays in register, consonant on strong beats, no parallels", () => {
  const o = { lo: 67, hi: 81, rhythm: 1 as const, seed: 3, startTick: 0, endTick: 3840, ppq: 480, tonic: 0, mode: "major" as const };
  const a = counterpoint(cScale, o), b = counterpoint(cScale, o);
  assert.deepEqual(a, b);
  for (const n of a.notes) { assert.ok(n.pitch >= 67 && n.pitch <= 81); const c = cScale.find((x) => x.tick <= n.tick && x.tick + x.duration > n.tick)!; assert.ok([0, 3, 4, 7, 8, 9].includes(Math.abs(n.pitch - c.pitch) % 12), `dissonance at ${n.tick}`); }
  assert.equal(parallelPerfects(a.notes, cScale).length, 0);
});

test("analyze passage: pitch classes, motifs, density", () => {
  const an = analyze([...cScale, ...cScale.map((n) => ({ ...n, tick: n.tick + 3840 }))], 480, 1920);
  assert.equal(an.noteCount, 16); assert.equal(an.pitchClassHistogram.C, 4); assert.ok(an.recurringMotifs.length > 0); assert.equal(an.densityNotesPerBar, 4);
});

test("tools: counterpoint + fugue section produce pending proposals without mutating", async () => {
  const p = emptyProject("t", 480);
  p.tracks.push({ id: "s", name: "Soprano", channel: 0, color: "", visible: true, mix: { volume: 100, pan: 64, expression: 127, mute: false, solo: false } });
  p.notes.push(...cScale.map((n, i) => ({ ...n, id: `n${i}`, trackId: "s", channel: 0 })));
  const c = new WorkstationController(p);
  const tools = new Map(buildAllTools(c).map((t) => [t.name, t]));
  const call = (n: string, a: unknown) => runTool(c, tools.get(n)!, a, new AbortController().signal);
  const cp = await call("gbk_generate_counterpoint", { cantusTrackId: "Soprano", range: { unit: "bars", start: 1, end: 2 }, position: "below", register: { low: 55, high: 69 }, seed: 5, candidates: 3 });
  assert.ok(cp.ok, JSON.stringify(cp.error));
  assert.equal((cp.data as { candidates: unknown[] }).candidates.length, 3);
  assert.equal(c.project.tracks.length, 1);
  const an = await call("gbk_analyze_passage", { range: { unit: "bars", start: 1, end: 2 } });
  assert.equal((an.data as { key: { label: string } }).key.label, "C major");
  const fg = await call("gbk_generate_fugue_section", { key: "D minor", voices: 3, seed: 11, atBar: 3, maxBars: 8 });
  assert.ok(fg.ok, JSON.stringify(fg.error));
  c.approvalHandler = async () => true;
  await call("gbk_commit_proposal", { proposalId: (fg.data as { proposalId: string }).proposalId });
  assert.ok(c.project.tracks.length >= 4);
  assert.ok(c.project.notes.some((n) => n.tick >= 2 * 1920));
});

test("estimateChord labels triads and sevenths, null on too little signal (#162)", () => {
  assert.equal(estimateChord([0, 4, 7])?.label, "C major");
  assert.equal(estimateChord([9, 0, 4])?.label, "A minor");
  assert.equal(estimateChord([2, 5, 9])?.label, "D minor");
  assert.equal(estimateChord([0, 4, 7, 10])?.label, "C dominant 7th");
  assert.equal(estimateChord([7]), null);
  assert.equal(estimateChord([0, 1]), null);
  assert.equal(estimateChord([]), null);
});
