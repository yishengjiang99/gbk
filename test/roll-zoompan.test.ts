import { test } from "node:test";
import assert from "node:assert/strict";
import { zoomTimeAt, zoomPitchAt, edgeVector, panStep, wheelFactor, MIN_PPT, MAX_PPT } from "../src/workstation/roll-zoompan.ts";
const v0 = { scrollTick: 1000, pxPerTick: 0.1, lowPitch: 36, highPitch: 83 };

test("time zoom keeps the tick under the cursor fixed and clamps", () => {
  const ax = 300, at = v0.scrollTick + ax / v0.pxPerTick;
  const v = zoomTimeAt(v0, 2, ax); assert.equal(v.pxPerTick, 0.2); assert.ok(Math.abs(v.scrollTick + ax / v.pxPerTick - at) < 1e-6);
  assert.equal(zoomTimeAt(v0, 1e6, ax).pxPerTick, MAX_PPT); assert.equal(zoomTimeAt(v0, 1e-6, ax).pxPerTick, MIN_PPT);
  assert.equal(zoomTimeAt(v0, 0.5, 0).scrollTick, 1000); assert.ok(zoomTimeAt(v0, 0.01, 300).scrollTick >= 0);
});
test("wheel up zooms in, down zooms out", () => { assert.ok(wheelFactor(-100) > 1); assert.ok(wheelFactor(100) < 1); assert.ok(wheelFactor(-3, 1) > wheelFactor(-3)); });
test("pitch zoom keeps the anchor row and stays in 0..127", () => {
  const v = zoomPitchAt(v0, 2, 0.5); assert.equal(v.highPitch - v.lowPitch + 1, 24); assert.ok(Math.abs((v.lowPitch + v.highPitch) / 2 - 59.5) <= 1);
  const out = zoomPitchAt(v0, 0.01, 0.5); assert.deepEqual([out.lowPitch, out.highPitch], [0, 127]);
  const top = zoomPitchAt({ ...v0, lowPitch: 100, highPitch: 127 }, 0.5, 0); assert.equal(top.highPitch, 127);
});
test("edge vector: zero in the middle, stronger nearer the edge", () => {
  assert.deepEqual(edgeVector(500, 300, 1000, 600), { dx: 0, dy: 0 });
  assert.ok(edgeVector(995, 300, 1000, 600).dx > edgeVector(970, 300, 1000, 600).dx); assert.ok(edgeVector(5, 300, 1000, 600).dx < 0);
  assert.ok(edgeVector(500, 2, 1000, 600).dy < 0); assert.ok(edgeVector(500, 598, 1000, 600).dy > 0);
});
test("pan step never passes content bounds", () => {
  const acc = { rows: 0 };
  assert.equal(panStep({ ...v0, scrollTick: 5 }, -1, 0, 1000, 5000, acc).scrollTick, 0);
  assert.equal(panStep(v0, 1, 0, 100000, 5000, acc).scrollTick, 5000);
  const up = panStep({ ...v0, lowPitch: 80, highPitch: 127 }, 0, -1, 1000, 0, acc); assert.equal(up.highPitch, 127);
  const dn = panStep(v0, 0, 1, 1000, 0, { rows: 0 }); assert.ok(dn.lowPitch < 36 && dn.highPitch - dn.lowPitch === 47);
});
