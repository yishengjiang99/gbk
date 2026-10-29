import test from "node:test";
import assert from "node:assert/strict";
import { buildPreview, PREVIEW_MAX_NOTES } from "../src/agent/piano-roll-preview.ts";

// Mirrors the shape of a real feed song ("Midnight Bb Swing Groove", 1,991 notes): several tracks
// starting a note on the same tick, the project notes array grouped by track.
function song(ticksPerTrack: number) {
  const tracks = [
    { id: "sax", color: "#4fc3f7" }, { id: "piano", color: "#ffb74d" },
    { id: "bass", color: "#81c784" }, { id: "drums", color: "#e57373" },
  ];
  const pitch = [(t: number) => 65, () => 60, () => 45, (t: number) => [36, 38, 42][t % 3]];
  const notes = tracks.flatMap((tr, ti) =>
    Array.from({ length: ticksPerTrack }, (_, t) => ({ trackId: tr.id, tick: t * 480, duration: 240, pitch: pitch[ti](t) })));
  return { tracks, notes };
}

test("preview under the cap keeps every note", () => {
  const pv = buildPreview(song(100)); // 400 notes
  assert.equal(pv.notes.length, 400);
  assert.equal(pv.lo, 36); assert.equal(pv.hi, 65);
});

test("a 1,991-note song fits the default cap whole (no sampling, no missing rows)", () => {
  const p = song(448); p.notes.push(...Array.from({ length: 199 }, (_, i) => ({ trackId: "sax", tick: i * 480, duration: 240, pitch: 67 })));
  assert.equal(p.notes.length, 1991);
  const pv = buildPreview(p);
  assert.equal(pv.notes.length, 1991);
  const opening = pv.notes.filter((n) => n[1] < 100); // first 10% of the song
  assert.deepEqual([...new Set(opening.map((n) => n[0]))].sort(), [0, 1, 2, 3], "all four tracks in the opening");
  assert.ok(opening.some((n) => n[0] === 3 && n[3] === 36), "drum row 36 present in the opening");
});

test("over the cap, sampling is per-track: every track survives in every section", () => {
  const pv = buildPreview(song(400), 200); // 1,600 notes -> 200
  assert.ok(pv.notes.length <= 200 && pv.notes.length >= 190, `got ${pv.notes.length}`);
  for (let d = 0; d < 10; d++) {
    const section = pv.notes.filter((n) => n[1] >= d * 100 && n[1] < (d + 1) * 100);
    assert.deepEqual([...new Set(section.map((n) => n[0]))].sort(), [0, 1, 2, 3], `decile ${d} keeps all tracks`);
  }
  // lo/hi/end still describe the full song, not the sample
  assert.equal(pv.lo, 36); assert.equal(pv.hi, 65); assert.equal(pv.end, 399 * 480 + 240);
});

test("empty project keeps the fallback range", () => {
  const pv = buildPreview({});
  assert.deepEqual([pv.lo, pv.hi, pv.notes.length], [60, 72, 0]);
  assert.ok(PREVIEW_MAX_NOTES >= 1991, "default cap covers the reported song whole");
});
