import test from "node:test";
import assert from "node:assert/strict";
import { detectStaves } from "../src/sheet-music-reader.ts";

for (const slope of [0, 0.04, -0.06, 0.07]) {
  test(`locates five staff lines at slope ${slope}`, () => {
    const width = 600;
    const height = 400;
    const dark = new Uint8Array(width * height);
    const rowCounts = new Uint16Array(height);
    const top = 120;
    const spacing = 10;
    for (let line = 0; line < 5; line++) {
      for (let x = 50; x < 550; x++) {
        const y = Math.round(top + line * spacing + slope * (x - width / 2));
        dark[y * width + x] = 1;
        rowCounts[y]++;
      }
    }
    const staves = detectStaves({ width, height, dark, rowCounts });
    assert.equal(staves.length, 1, JSON.stringify(staves));
    for (let line = 0; line < 5; line++) {
      for (const x of [50, 300, 549]) {
        const expected = top + line * spacing + slope * (x - width / 2);
        const actual = staves[0].lines[line] + staves[0].slope * (x - width / 2);
        assert.ok(Math.abs(actual - expected) <= 1.5, `line ${line}, x ${x}: expected ${expected}, got ${actual}`);
      }
    }
  });
}
