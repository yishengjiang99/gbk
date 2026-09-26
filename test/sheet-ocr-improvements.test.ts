import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeSheetImageQuality,
  binarizeLuminance,
  deskewBinaryImage,
  deskewInverseY,
  detectStaves,
  estimateStaffSkew,
  laplacianVariance,
  transcribeSheetImageWithLayout,
  type BinarySheetImage,
} from "../src/sheet-music-reader.ts";

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

// ---------- Skew estimation ----------

test("estimateStaffSkew finds a positive slope on a tilted staff", () => {
  const image = makeBlank(600, 300);
  drawStaff(image, 130, 10, 0.12);
  const skew = estimateStaffSkew(image);
  assert.ok(Math.abs(skew.slope - 0.12) < 0.02, `estimated ${skew.slope}`);
});

test("estimateStaffSkew finds a negative slope on a tilted staff", () => {
  const image = makeBlank(600, 300);
  drawStaff(image, 130, 10, -0.12);
  const skew = estimateStaffSkew(image);
  assert.ok(Math.abs(skew.slope + 0.12) < 0.02, `estimated ${skew.slope}`);
});

test("estimateStaffSkew returns zero for a horizontal staff", () => {
  const image = makeBlank(600, 300);
  drawStaff(image, 130, 10, 0);
  const skew = estimateStaffSkew(image);
  assert.equal(skew.slope, 0);
});

// ---------- Deskew ----------

test("deskewBinaryImage straightens tilted staff lines", () => {
  const image = makeBlank(600, 300);
  drawStaff(image, 130, 10, 0.12);
  const skew = estimateStaffSkew(image);
  const deskewed = deskewBinaryImage(image, skew.slope);
  const staves = detectStaves(deskewed.image);
  assert.ok(staves.length >= 1, "staff detected after deskew");
  assert.ok(Math.abs(staves[0].slope) < 0.03, `residual slope ${staves[0].slope}`);
});

test("deskewInverseY maps deskewed coordinates back to the original image", () => {
  const image = makeBlank(600, 300);
  const deskewed = deskewBinaryImage(image, 0.1);
  // The center column is unshifted apart from the padding offset.
  const y = 150;
  const roundTripped = deskewInverseY(deskewed, image.width / 2, y + deskewed.yOffset);
  assert.ok(Math.abs(roundTripped - y) < 1e-6, `got ${roundTripped}`);
});

test("transcribeSheetImageWithLayout deskews a significantly tilted page", () => {
  const image = makeBlank(640, 360);
  const top = 150;
  const spacing = 10;
  const slope = 0.12;
  drawStaff(image, top, spacing, slope);
  drawNotehead(image, 220, Math.round(top + spacing * 2 + slope * (220 - image.width / 2)));
  drawNotehead(image, 320, Math.round(top + spacing * 3 + slope * (320 - image.width / 2)));

  const result = transcribeSheetImageWithLayout(image);
  assert.equal(result.notes.length, 2, result.warnings.join(" "));
  assert.equal(result.layout.length, 2);
});

// ---------- Uneven lighting ----------

function luminanceWithGradient(width: number, height: number): { luminance: Uint8ClampedArray; lineRows: number[] } {
  // Background fades from dark gray on the left to light gray on the right;
  // a global threshold cannot separate black staff lines on both sides.
  const luminance = new Uint8ClampedArray(width * height);
  const lineRows = [100, 110, 120, 130, 140];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const background = 90 + (110 * x) / width;
      const isLine = lineRows.includes(y) && x >= 20 && x < width - 20;
      luminance[y * width + x] = isLine ? 0 : Math.round(background);
    }
  }
  return { luminance, lineRows };
}

test("binarizeLuminance recovers staff lines under a lighting gradient", () => {
  const width = 400;
  const height = 240;
  const { luminance, lineRows } = luminanceWithGradient(width, height);
  const image = binarizeLuminance(luminance, width, height);

  for (const y of lineRows) {
    let darkOnLine = 0;
    for (let x = 20; x < width - 20; x += 1) if (image.dark[y * width + x]) darkOnLine += 1;
    assert.ok(darkOnLine > (width - 40) * 0.9, `line at y=${y} has ${darkOnLine} dark pixels`);
  }
  // The dark (left) background itself must not binarize as ink.
  let backgroundDark = 0;
  for (let x = 20; x < width - 20; x += 1) {
    if (image.dark[50 * width + x]) backgroundDark += 1;
  }
  assert.ok(backgroundDark < (width - 40) * 0.1, `background has ${backgroundDark} dark pixels`);
});

test("binarizeLuminance keeps uniform images blank", () => {
  const width = 64;
  const height = 64;
  const pale = new Uint8ClampedArray(width * height).fill(220);
  const dark = new Uint8ClampedArray(width * height).fill(0);
  assert.equal(binarizeLuminance(pale, width, height).dark.reduce((a, b) => a + b, 0), 0);
  assert.equal(binarizeLuminance(dark, width, height).dark.reduce((a, b) => a + b, 0), 0);
});

// ---------- Image quality warnings ----------

function sharpLuminance(width: number, height: number): Uint8ClampedArray {
  const luminance = new Uint8ClampedArray(width * height).fill(255);
  const block = 8;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((Math.floor(x / block) + Math.floor(y / block)) % 2 === 0) luminance[y * width + x] = 0;
    }
  }
  return luminance;
}

function blurredLuminance(width: number, height: number): Uint8ClampedArray {
  // Heavy separable box-blur of the checkerboard: edges vanish, variance of
  // Laplacian collapses. Two passes (horizontal then vertical) keep it fast.
  const radius = 24;
  const horizontal = new Uint8ClampedArray(width * height);
  const sharp = sharpLuminance(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const xx = x + dx;
        if (xx < 0 || xx >= width) continue;
        sum += sharp[y * width + xx];
        count += 1;
      }
      horizontal[y * width + x] = Math.round(sum / count);
    }
  }
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        sum += horizontal[yy * width + x];
        count += 1;
      }
      out[y * width + x] = Math.round(sum / count);
    }
  }
  return out;
}

test("laplacianVariance separates sharp from blurred images", () => {
  const sharp = laplacianVariance(sharpLuminance(200, 200), 200, 200);
  const blurred = laplacianVariance(blurredLuminance(200, 200), 200, 200);
  assert.ok(sharp > 30, `sharp variance ${sharp}`);
  assert.ok(blurred < 30, `blurred variance ${blurred}`);
});

test("analyzeSheetImageQuality warns about blur without throwing", () => {
  const blurred = blurredLuminance(1280, 800);
  const warnings = analyzeSheetImageQuality(blurred, 1280, 800, 1280, 800);
  assert.ok(warnings.some((w) => /blur/i.test(w)), warnings.join(" "));
});

test("analyzeSheetImageQuality warns about low resolution without throwing", () => {
  const sharp = sharpLuminance(800, 600);
  const warnings = analyzeSheetImageQuality(sharp, 800, 600, 800, 600);
  assert.ok(warnings.some((w) => /resolution/i.test(w)), warnings.join(" "));
});

test("analyzeSheetImageQuality stays silent for a sharp high-resolution image", () => {
  const sharp = sharpLuminance(1400, 1800);
  const warnings = analyzeSheetImageQuality(sharp, 1400, 1800, 1400, 1800);
  assert.deepEqual(warnings, []);
});

// ---------- Layout ----------

test("transcribeSheetImageWithLayout keeps layout aligned with notes", () => {
  const image = makeBlank(640, 320);
  const top = 120;
  const spacing = 10;
  drawStaff(image, top, spacing);
  drawNotehead(image, 180, top);
  drawNotehead(image, 260, top + spacing * 2);
  drawNotehead(image, 340, top + spacing * 4);

  const result = transcribeSheetImageWithLayout(image);
  assert.equal(result.notes.length, 3, result.warnings.join(" "));
  assert.equal(result.layout.length, result.notes.length);
  for (let i = 0; i < result.notes.length; i += 1) {
    const note = result.notes[i];
    const entry = result.layout[i];
    assert.equal(entry.midi, note.midi);
    assert.equal(entry.startTick, note.startTick);
    assert.ok(entry.bbox.x >= 0 && entry.bbox.y >= 0, `bbox ${JSON.stringify(entry.bbox)}`);
    assert.ok(entry.bbox.w > 0 && entry.bbox.h > 0, `bbox ${JSON.stringify(entry.bbox)}`);
    assert.ok(entry.bbox.x + entry.bbox.w <= image.width, `bbox ${JSON.stringify(entry.bbox)}`);
    assert.ok(entry.bbox.y + entry.bbox.h <= image.height, `bbox ${JSON.stringify(entry.bbox)}`);
  }
});

test("transcribeSheetImageWithLayout maps boxes back through deskew", () => {
  const image = makeBlank(640, 360);
  const top = 150;
  const spacing = 10;
  const slope = 0.12;
  drawStaff(image, top, spacing, slope);
  const noteX = 220;
  const noteY = Math.round(top + spacing * 2 + slope * (noteX - image.width / 2));
  drawNotehead(image, noteX, noteY);

  const result = transcribeSheetImageWithLayout(image);
  assert.equal(result.notes.length, 1, result.warnings.join(" "));
  const bbox = result.layout[0].bbox;
  // The box must land on the notehead in original coordinates, not deskewed ones.
  const centerX = bbox.x + bbox.w / 2;
  const centerY = bbox.y + bbox.h / 2;
  assert.ok(Math.abs(centerX - noteX) < 8, `centerX ${centerX} vs ${noteX}`);
  assert.ok(Math.abs(centerY - noteY) < 8, `centerY ${centerY} vs ${noteY}`);
});
