import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./support/compose-setup.ts";
import { emptyProject, DEFAULT_MIX, type Project } from "../src/workstation/model.ts";
import { degreeMap } from "../src/webmcp/arrangement-tools.ts";

/** C-minor project: a violins track carrying the Fifth's motif (G G G Eb) + a drum track.
 * owner:"agent" + resumeAutonomousSession makes tool edits commit directly (no Accept round-trip). */
function motifProject(extraPitches: number[] = []): Project {
  const p = emptyProject("Symphony No. 5 in C Minor (fork)", 480);
  p.tracks = [
    { id: "t_vln", name: "Violins", channel: 0, color: "#fff176", mix: { ...DEFAULT_MIX }, visible: true, role: "melody" },
    { id: "t_drm", name: "Drums", channel: 9, color: "#e57373", mix: { ...DEFAULT_MIX }, visible: true, role: "percussion" },
  ];
  const motif = [67, 67, 67, 63]; // G4 G4 G4 Eb4
  p.notes = [
    ...motif.map((pitch, i) => ({ id: `m${i}`, trackId: "t_vln", channel: 0, tick: i * 240, duration: i === 3 ? 720 : 240, pitch, velocity: 100 })),
    ...extraPitches.map((pitch, i) => ({ id: `x${i}`, trackId: "t_vln", channel: 0, tick: 1440 + i * 240, duration: 240, pitch, velocity: 90 })),
    { id: "d0", trackId: "t_drm", channel: 9, tick: 0, duration: 120, pitch: 36, velocity: 110 },
    { id: "d1", trackId: "t_drm", channel: 9, tick: 480, duration: 120, pitch: 38, velocity: 105 },
  ];
  p.endTick = 1440 + extraPitches.length * 240;
  p.meta = { key: "C minor", owner: "agent" };
  return p;
}

function loaded(extraPitches: number[] = []) {
  const s = setup();
  s.c.load(motifProject(extraPitches));
  assert.equal(s.c.resumeAutonomousSession("remap test"), true);
  return s;
}
const pitchesOf = (c: { project: Project }, trackId: string) => c.project.notes.filter((n) => n.trackId === trackId).sort((a, b) => a.tick - b.tick).map((n) => n.pitch);
const FULL = { unit: "ticks", start: 0, end: 100000 } as const;

test("degreeMap: minor->major raises exactly b3/b6/b7; major->minor lowers 3/6/7", () => {
  assert.deepEqual(degreeMap("minor", "major"), [0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0]);
  assert.deepEqual(degreeMap("major", "minor"), [0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, -1]);
  assert.deepEqual(degreeMap("minor", "minor"), new Array(12).fill(0));
});

test("remap C minor -> A major: motif G G G Eb becomes E E E C#, drums unchanged, meta.key updated, ONE commit (#162 required test)", async () => {
  const { c, call } = loaded();
  const revBefore = c.project.revision;
  const r = await call("gbk_transform_notes", { trackId: "*", range: FULL, transform: "remap", targetKey: "A major" });
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.data.committed, true);
  assert.equal(r.data.key, "A major");
  assert.equal(r.data.semitones, -3, "C -> A goes DOWN a minor third, not up a major sixth");
  assert.deepEqual(pitchesOf(c, "t_vln"), [64, 64, 64, 61], "E4 E4 E4 C#4");
  assert.deepEqual(pitchesOf(c, "t_drm"), [36, 38], "percussion is never remapped (drum sounds are not pitches)");
  assert.equal(c.project.meta?.key, "A major");
  assert.equal(c.project.revision, revBefore + 1, "the whole-song key change is a single op batch / single revision");
  assert.ok(r.warnings.some((w: string) => /skipped percussion/.test(w)));
});

test("remap C minor -> C major (parallel major): raises only Eb/Ab/Bb, leading tone B natural untouched", async () => {
  const { c, call } = loaded([68, 70, 71]); // Ab4, Bb4, B4 after the motif
  const r = await call("gbk_transform_notes", { trackId: "*", range: FULL, transform: "remap", targetKey: "C major" });
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.data.semitones, 0);
  assert.deepEqual(pitchesOf(c, "t_vln"), [67, 67, 67, 64, 69, 71, 71], "G G G E | A B B: only the minor degrees moved");
  assert.equal(c.project.meta?.key, "C major");
});

test("remap with an explicit pitchClassMap + semitones does the same mapping and leaves meta.key alone (with a warning)", async () => {
  const { c, call } = loaded();
  const r = await call("gbk_transform_notes", { trackId: "*", range: FULL, transform: "remap", semitones: -3, pitchClassMap: [0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0] });
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.deepEqual(pitchesOf(c, "t_vln"), [64, 64, 64, 61]);
  assert.equal(c.project.meta?.key, "C minor", "no targetKey -> the key label is not guessed");
  assert.ok(r.warnings.some((w: string) => /meta\.key not updated/.test(w)));
});

test("remap refuses a percussion-only target and a missing map/targetKey", async () => {
  const { call } = loaded();
  const drums = await call("gbk_transform_notes", { trackId: "t_drm", range: FULL, transform: "remap", targetKey: "A major" });
  assert.equal(drums.ok, false); assert.equal(drums.error?.code, "INVALID_RANGE");
  const bare = await call("gbk_transform_notes", { trackId: "*", range: FULL, transform: "remap" });
  assert.equal(bare.ok, false); assert.equal(bare.error?.code, "INVALID_ARGUMENT");
});
