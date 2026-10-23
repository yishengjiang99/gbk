import test from "node:test";
import assert from "node:assert/strict";
import { followScroll } from "../src/workstation/follow.ts";
test("page-style follow: in view -> null; past edge or behind -> jump with lead", () => {
  assert.equal(followScroll(500, 0, 1000), null);
  assert.equal(followScroll(900, 0, 1000), 800);
  assert.equal(followScroll(100, 2000, 1000), 0);
  assert.equal(followScroll(5000, 2000, 1000), 4900); // seek far ahead
  assert.equal(followScroll(5000, 0, 0), null);
});

import { buildNoteIndex, visibleNotes, visiblePoints } from "../src/workstation/visible.ts";
test("visible window index matches brute force and is bounded", () => {
  const notes = Array.from({ length: 50000 }, (_, i) => ({ tick: i * 10, duration: i % 97 === 0 ? 5000 : 40 }));
  const ix = buildNoteIndex(notes);
  for (const [a, b] of [[0, 100], [123456, 130000], [499000, 600000]]) {
    const brute = notes.filter((n) => n.tick <= b && n.tick + n.duration >= a);
    assert.deepEqual(visibleNotes(ix, a, b), brute);
  }
  const pts = notes.map((n) => ({ tick: n.tick }));
  const v = visiblePoints(pts, 1000, 2000);
  assert.equal(v[0].tick, 990); assert.equal(v[v.length - 1].tick, 2000);
});
