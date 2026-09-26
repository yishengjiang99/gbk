import test from "node:test";
import assert from "node:assert/strict";

import { transcribeSheetImage, type BinarySheetImage } from "../src/sheet-music-reader.ts";

function makeBlank(width: number, height: number): BinarySheetImage {
  return {
    width,
    height,
    dark: new Uint8Array(width * height),
    rowCounts: new Uint16Array(height),
  };
}

function ink(image: BinarySheetImage, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const i = y * image.width + x;
  if (image.dark[i]) return;
  image.dark[i] = 1;
  image.rowCounts[y] += 1;
}

function drawStaff(image: BinarySheetImage, top: number, spacing: number, slope = 0): void {
  for (let line = 0; line < 5; line += 1) {
    for (let x = 40; x < image.width - 40; x += 1) {
      const y = Math.round(top + line * spacing + slope * (x - image.width / 2));
      ink(image, x, y);
    }
  }
}

function drawNotehead(image: BinarySheetImage, cx: number, cy: number, rx = 5, ry = 4): void {
  const minX = Math.floor(cx - rx);
  const maxX = Math.ceil(cx + rx);
  const minY = Math.floor(cy - ry);
  const maxY = Math.ceil(cy + ry);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) ink(image, x, y);
    }
  }
}

test("transcribeSheetImage recovers noteheads on spaces and staff lines", () => {
  const image = makeBlank(640, 320);
  const top = 120;
  const spacing = 10;
  drawStaff(image, top, spacing);

  // Treble: F5 on the top line, B4 on the middle line, A4 in the space below it, E4 on the bottom line.
  drawNotehead(image, 180, top);
  drawNotehead(image, 260, top + spacing * 2);
  drawNotehead(image, 340, top + spacing * 2.5);
  drawNotehead(image, 420, top + spacing * 4);

  const result = transcribeSheetImage(image);
  assert.equal(result.notes.length, 4, result.warnings.join(" "));
  const pitches = result.notes.map((note) => note.midi).sort((a, b) => b - a);
  assert.deepEqual(pitches, [77, 71, 69, 64]);
});

test("a lone grand staff pair shares onset ticks and splits clefs across channels", () => {
  const image = makeBlank(640, 360);
  const spacing = 10;
  const trebleTop = 70;
  const bassTop = 160;
  drawStaff(image, trebleTop, spacing);
  drawStaff(image, bassTop, spacing);
  drawNotehead(image, 220, trebleTop + spacing * 4); // E4
  drawNotehead(image, 220, bassTop); // A3

  const result = transcribeSheetImage(image);
  assert.equal(result.notes.length, 2, result.warnings.join(" "));
  assert.equal(result.notes[0].startTick, result.notes[1].startTick);
  const byPitch = new Map(result.notes.map((note) => [note.midi, note]));
  assert.equal(byPitch.get(64)?.channel ?? 0, 0);
  assert.equal(byPitch.get(57)?.channel, 1);
});

test("staff lines without noteheads do not invent pitches", () => {
  const image = makeBlank(640, 320);
  drawStaff(image, 120, 10);
  const result = transcribeSheetImage(image);
  assert.equal(result.notes.length, 0);
  assert.match(result.warnings.join(" "), /no noteheads/i);
});
