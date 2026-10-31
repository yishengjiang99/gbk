import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./support/compose-setup.ts";
import { emptyProject, DEFAULT_MIX, type Project } from "../src/workstation/model.ts";
import { SYSTEM_PROMPT } from "../server/src/agent/prompt.ts";

/** Two bars: bar 1 = C major triad, bar 2 = D minor triad, one melody track (ppq 480, 4/4 -> bar = 1920 ticks). */
function twoBarProject(): Project {
  const p = emptyProject("Digest Song", 480);
  p.tracks = [{ id: "t_mel", name: "Melody", channel: 0, color: "#fff176", mix: { ...DEFAULT_MIX }, visible: true, role: "melody" }];
  const bar1 = [60, 64, 67], bar2 = [62, 65, 69];
  p.notes = [
    ...bar1.map((pitch, i) => ({ id: `a${i}`, trackId: "t_mel", channel: 0, tick: i * 480, duration: 480, pitch, velocity: 90 + i * 5 })),
    ...bar2.map((pitch, i) => ({ id: `b${i}`, trackId: "t_mel", channel: 0, tick: 1920 + i * 480, duration: 480, pitch, velocity: 80 })),
  ];
  p.endTick = 3840;
  return p;
}

test("gbk_get_score_digest: per-bar pitch classes, ranges, counts, mean velocity, chord estimates (#162 step 6)", async () => {
  const { c, call } = setup();
  c.load(twoBarProject());
  const r = await call("gbk_get_score_digest");
  assert.ok(r.ok, JSON.stringify(r.error));
  const d = r.data as { chords: Record<string, string>; tracks: { id: string; bars: { bar: number; pitchClasses: number[]; minPitch: number; maxPitch: number; noteCount: number; meanVelocity: number }[] }[] };
  assert.equal(d.chords["1"], "C major");
  assert.equal(d.chords["2"], "D minor");
  const bars = d.tracks[0].bars;
  assert.equal(bars.length, 2, "only non-empty bars are listed");
  assert.deepEqual(bars[0].pitchClasses, [0, 4, 7]);
  assert.equal(bars[0].minPitch, 60); assert.equal(bars[0].maxPitch, 67);
  assert.equal(bars[0].noteCount, 3); assert.equal(bars[0].meanVelocity, 95);
  assert.deepEqual(bars[1].pitchClasses, [2, 5, 9]);
});

test("system prompt carries the opened-song follow-up playbook (was the #162 step 6 remix playbook)", () => {
  // The remix binding is gone; what survives is the opened-song guidance: read the digest before
  // qualitative edits, a named key change is one remap call, and a follow-up never creates a project.
  assert.match(SYSTEM_PROMPT, /Editing an opened song/);
  assert.match(SYSTEM_PROMPT, /gbk_create_project is not available to you/);
  assert.match(SYSTEM_PROMPT, /gbk_get_score_digest/);
  assert.match(SYSTEM_PROMPT, /transform "remap", trackId "\*"/);
});
