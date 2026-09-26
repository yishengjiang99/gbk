import test from "node:test";
import assert from "node:assert/strict";

import { resolveViewportHeightPx } from "../src/viewport-height.ts";

test("prefers visualViewport height when available", () => {
  assert.equal(resolveViewportHeightPx(689, 844), 689);
});

test("falls back to innerHeight when visualViewport is missing", () => {
  assert.equal(resolveViewportHeightPx(null, 844), 844);
  assert.equal(resolveViewportHeightPx(undefined, 844), 844);
});

test("ignores non-positive visualViewport values", () => {
  assert.equal(resolveViewportHeightPx(0, 700), 700);
  assert.equal(resolveViewportHeightPx(-10, 700), 700);
});

test("rounds fractional heights to whole CSS px", () => {
  assert.equal(resolveViewportHeightPx(688.6, 844), 689);
});

test("returns null when nothing usable is available", () => {
  assert.equal(resolveViewportHeightPx(null, null), null);
  assert.equal(resolveViewportHeightPx(undefined, undefined), null);
  assert.equal(resolveViewportHeightPx(0, 0), null);
  assert.equal(resolveViewportHeightPx(NaN, null), null);
});
