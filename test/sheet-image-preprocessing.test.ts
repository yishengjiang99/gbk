import test from "node:test";
import assert from "node:assert/strict";
import { binarizeSheetPixels } from "../src/sheet-music-reader.ts";

function pixels(ink: number, paper: number, transparent = false): Uint8ClampedArray {
  // A short staff segment surrounded by paper; geometry is independent of exposure.
  return Uint8ClampedArray.from([0, 0, 0, 1, 1, 1, 0, 0, 0].flatMap((dark) => {
    const value = dark ? ink : paper;
    return [value, value, value, transparent && !dark ? 0 : 255];
  }));
}

for (const [ink, paper] of [[0, 255], [100, 220], [200, 245]]) {
  test(`preserves the same staff pixels at ink ${ink}, paper ${paper}`, () => {
    const image = binarizeSheetPixels(pixels(ink, paper), 3, 3);
    assert.deepEqual([...image.dark], [0, 0, 0, 1, 1, 1, 0, 0, 0]);
    assert.deepEqual([...image.rowCounts], [0, 3, 0]);
  });
}

test("transparent PNG paper produces the same mask as white paper", () => {
  const opaque = binarizeSheetPixels(pixels(0, 255), 3, 3);
  const transparent = binarizeSheetPixels(pixels(0, 0, true), 3, 3);
  assert.deepEqual(transparent.dark, opaque.dark);
});

test("uniform pale paper produces no notation", () => {
  assert.deepEqual([...binarizeSheetPixels(pixels(220, 220), 3, 3).dark], Array(9).fill(0));
});

test("a uniform dark image is not recognized as an all-ink score", () => {
  assert.deepEqual([...binarizeSheetPixels(pixels(0, 0), 3, 3).dark], Array(9).fill(0));
});

test("semitransparent ink matches its appearance composited on white paper", () => {
  const transparentInk = pixels(0, 0, true);
  for (const index of [3, 4, 5]) transparentInk[index * 4 + 3] = 128;
  const before = transparentInk.slice();
  const actual = binarizeSheetPixels(transparentInk, 3, 3);
  assert.deepEqual(actual.dark, binarizeSheetPixels(pixels(127, 255), 3, 3).dark);
  assert.deepEqual(transparentInk, before);
});
