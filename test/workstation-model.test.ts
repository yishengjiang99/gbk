import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emptyProject, type Project } from "../src/workstation/model.ts";
import { parseSmf, serializeSmf } from "../src/workstation/smf.ts";
import { tickToSec, secToTick, barBeatToTick, tickToBarBeat } from "../src/workstation/timing.ts";
import { generateCurve } from "../src/workstation/curves.ts";
import { WorkstationController, WorkstationError } from "../src/workstation/controller.ts";

function demo(): Project {
  const p = emptyProject("demo", 96);
  p.tempos = [{ tick: 0, microPerQuarter: 500000 }, { tick: 384, microPerQuarter: 1000000 }];
  p.timeSigs = [{ tick: 0, numerator: 3, denominator: 4 }];
  p.tracks.push({ id: "t1", name: "Strings", channel: 2, color: "#fff", visible: true, mix: { volume: 100, pan: 64, expression: 127, mute: false, solo: false } });
  p.notes.push({ id: "n1", trackId: "t1", channel: 2, tick: 0, duration: 96, pitch: 60, velocity: 90 }, { id: "n2", trackId: "t1", channel: 2, tick: 96, duration: 96, pitch: 60, velocity: 80 });
  p.ccs.push({ id: "c1", trackId: "t1", channel: 2, controller: 11, tick: 96, value: 50 }, { id: "c2", trackId: "t1", channel: 2, controller: 64, tick: 0, value: 127 }, { id: "c3", trackId: "t1", channel: 2, controller: 85, tick: 10, value: 3 });
  p.pitchBends.push({ id: "b1", trackId: "t1", channel: 2, tick: 48, value: 12000 });
  p.channelPressure.push({ id: "p1", trackId: "t1", channel: 2, tick: 50, value: 70 });
  p.polyPressure.push({ id: "p2", trackId: "t1", channel: 2, tick: 51, pitch: 60, value: 33 });
  p.programs.push({ id: "g1", trackId: "t1", channel: 2, tick: 0, program: 48, bankMsb: 0, bankLsb: 0 });
  p.raw.push({ id: "r1", trackId: "t1", tick: 5, kind: "sysex", bytes: [0xf0, 3, 0x7e, 0x7f, 0xf7] });
  p.endTick = 192;
  return p;
}

test("tick<->sec under tempo change and non-4/4 meter", () => {
  const p = demo();
  assert.equal(tickToSec(p, 384), 2);
  assert.equal(tickToSec(p, 480), 3);
  assert.equal(secToTick(p, 3), 480);
  assert.equal(barBeatToTick(p, 2), 288); // 3/4 at 96 ppq
  assert.deepEqual(tickToBarBeat(p, 300), { bar: 2, beat: 0.125 });
});

test("SMF round trip preserves timed CC, channels, bend, pressure, program, tempo/meter, raw", () => {
  const p = demo();
  const back = parseSmf(serializeSmf(p));
  assert.equal(back.ppq, 96);
  assert.deepEqual(back.tempos, p.tempos);
  assert.deepEqual(back.timeSigs, p.timeSigs);
  assert.equal(back.tracks[1].name, "Strings");
  const t = back.tracks[1].id;
  assert.deepEqual(back.ccs.filter((c) => c.trackId === t).map((c) => [c.tick, c.channel, c.controller, c.value]), [[0, 2, 64, 127], [10, 2, 85, 3], [96, 2, 11, 50]]);
  assert.deepEqual(back.notes.map((n) => [n.tick, n.duration, n.pitch, n.channel]), [[0, 96, 60, 2], [96, 96, 60, 2]]);
  assert.equal(back.pitchBends[0].value, 12000);
  assert.equal(back.channelPressure[0].value, 70);
  assert.equal(back.polyPressure[0].value, 33);
  assert.equal(back.programs[0].program, 48);
  assert.deepEqual(back.raw.filter((r) => r.kind === "sysex")[0].bytes, [0xf0, 3, 0x7e, 0x7f, 0xf7]);
});

test("note-off before note-on at same tick (repeated pitch keeps both notes)", () => {
  const bytes = serializeSmf(demo());
  const back = parseSmf(bytes);
  assert.equal(back.notes.length, 2);
  assert.equal(back.notes[0].duration, 96);
});

test("bundled MIDI parses and re-exports with identical note & CC counts", () => {
  const buf = readFileSync("public/static/bizet_carmen_act-1_05_habanera_(c)yogore.mid");
  const a = parseSmf(buf);
  const b = parseSmf(serializeSmf(a));
  assert.ok(a.notes.length > 100);
  assert.equal(b.notes.length, a.notes.length);
  assert.equal(b.ccs.length, a.ccs.length);
  assert.equal(b.endTick, a.endTick);
});

test("curves deterministic, monotone crescendo, density configurable", () => {
  const spec = { shape: "crescendo" as const, startTick: 0, endTick: 960, from: 30, to: 110 };
  const a = generateCurve(spec, 480), b = generateCurve(spec, 480);
  assert.deepEqual(a, b);
  assert.equal(a[0].value, 30); assert.equal(a[a.length - 1].value, 110);
  for (let i = 1; i < a.length; i++) assert.ok(a[i].value >= a[i - 1].value);
  assert.ok(generateCurve({ ...spec, stepTicks: 10, simplify: false }, 480).length > generateCurve({ ...spec, stepTicks: 120, simplify: false }, 480).length);
  const sw = generateCurve({ shape: "swell", startTick: 0, endTick: 100, from: 40, to: 40, peak: 100, stepTicks: 5 }, 480);
  assert.equal(Math.max(...sw.map((x) => x.value)), 100);
  assert.throws(() => generateCurve({ ...spec, endTick: 0 }, 480), /INVALID_RANGE/);
});

test("controller: edit/undo/redo share history; revisions monotonic; STALE_REVISION", () => {
  const c = new WorkstationController(demo());
  const r0 = c.project.revision;
  c.edit([{ op: "updateNotes", updates: [{ id: "n1", pitch: 62 }] }], { baseRevision: r0 });
  assert.equal(c.project.notes.find((n) => n.id === "n1")!.pitch, 62);
  assert.throws(() => c.edit([{ op: "removeNotes", ids: ["n1"] }], { baseRevision: r0 }), (e: WorkstationError) => e.code === "STALE_REVISION");
  assert.ok(c.undo());
  assert.equal(c.project.notes.find((n) => n.id === "n1")!.pitch, 60);
  assert.ok(c.project.revision > r0 + 1);
  assert.ok(c.redo());
  assert.equal(c.project.notes.find((n) => n.id === "n1")!.pitch, 62);
});

test("controller: invalid args rejected", () => {
  const c = new WorkstationController(demo());
  assert.throws(() => c.edit([{ op: "addNotes", notes: [{ trackId: "t1", channel: 0, tick: 0, duration: 1, pitch: 200, velocity: 1 }] }]), /pitch/);
  assert.throws(() => c.edit([{ op: "setCC", trackId: "t1", channel: 0, controller: 11, startTick: 10, endTick: 5, mode: "replace", points: [] }]), (e: WorkstationError) => e.code === "INVALID_RANGE");
});

test("proposals: reject leaves project untouched; agent commit needs approval; commit is one undo step", async () => {
  const c = new WorkstationController(demo());
  const before = c.project;
  const p = c.propose([{ op: "setCC", trackId: "t1", channel: 2, controller: 11, startTick: 0, endTick: 192, mode: "replace", points: generateCurve({ shape: "crescendo", startTick: 0, endTick: 192 }, 96) }], { source: "agent" });
  c.discardProposal(p.id);
  assert.equal(c.project, before);
  const q = c.propose([{ op: "addNotes", notes: [{ trackId: "t1", channel: 2, tick: 0, duration: 96, pitch: 67, velocity: 70 }] }], { source: "agent" });
  await assert.rejects(c.commitProposal(q.id, { source: "agent" }), (e: WorkstationError) => e.code === "USER_APPROVAL_REQUIRED");
  c.approvalHandler = async () => true;
  await c.commitProposal(q.id, { source: "agent" });
  assert.equal(c.project.notes.length, 3);
  c.undo();
  assert.equal(c.project.notes.length, 2);
});

test("proposal becomes stale after unrelated edit", async () => {
  const c = new WorkstationController(demo());
  const p = c.propose([{ op: "removeNotes", ids: ["n2"] }]);
  c.edit([{ op: "updateTrack", trackId: "t1", name: "Violins" }]);
  assert.equal(c.getProposal(p.id).status, "stale");
  await assert.rejects(c.commitProposal(p.id, { source: "user" }), (e: WorkstationError) => e.code === "STALE_REVISION");
});
