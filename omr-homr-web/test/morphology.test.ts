/*
 * #217 replaced the per-pixel morphology loop and the sort-everything convex
 * hull with fast paths. They must stay exactly equivalent to the direct
 * definitions (OpenCV semantics, out-of-image samples ignored), which are
 * re-implemented here as the reference.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GrayImage,
  convexHull,
  dilate,
  ellipseKernel,
  erode,
  rectKernel,
  type KernelOffsets,
} from "../src/geometry/image.js";

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomImage(w: number, h: number, rand: () => number, binary: boolean): GrayImage {
  const img = GrayImage.zeros(w, h);
  for (let i = 0; i < img.data.length; i++) {
    img.data[i] = binary ? (rand() < 0.15 ? 255 : 0) : Math.floor(rand() * 256);
  }
  return img;
}

function morphReference(src: GrayImage, kernel: KernelOffsets, iterations: number, isDilate: boolean): GrayImage {
  let cur = src;
  for (let it = 0; it < iterations; it++) {
    const dst = GrayImage.zeros(cur.width, cur.height);
    for (let y = 0; y < cur.height; y++) {
      for (let x = 0; x < cur.width; x++) {
        let best = isDilate ? 0 : 255;
        for (const [dx, dy] of kernel) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cur.width || ny >= cur.height) continue;
          const v = cur.data[ny * cur.width + nx];
          best = isDilate ? Math.max(best, v) : Math.min(best, v);
        }
        dst.data[y * cur.width + x] = best;
      }
    }
    cur = dst;
  }
  return cur;
}

function hullReference(points: Array<readonly [number, number]>): Array<[number, number]> {
  const pts = points.map((p) => [p[0], p[1]] as [number, number]);
  pts.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (seq: Array<[number, number]>) => {
    const out: Array<[number, number]> = [];
    for (const p of seq) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return half(pts).concat(half([...pts].reverse()));
}

describe("morphology fast path matches the direct definition", () => {
  // The pipeline's kernels (staff.ts) plus odd/even, thin, and wide shapes.
  const kernels: Array<[string, KernelOffsets]> = [
    ["rect 3x5", rectKernel(3, 5)],
    ["rect 7x7", rectKernel(7, 7)],
    ["rect 9x9", rectKernel(9, 9)],
    ["rect 4x2", rectKernel(4, 2)],
    ["rect 1x1", rectKernel(1, 1)],
    ["ellipse 1x5", ellipseKernel(1, 5)],
    ["ellipse 5x35", ellipseKernel(5, 35)],
    ["ellipse 35x5", ellipseKernel(35, 5)],
    ["ellipse 6x4", ellipseKernel(6, 4)],
    ["ellipse 2x2", ellipseKernel(2, 2)],
    // Not run-decomposable on either axis: exercises the direct fallback.
    ["ring", [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]]],
  ];
  for (const [name, kernel] of kernels) {
    for (const binary of [true, false]) {
      it(`${name}, ${binary ? "binary" : "grayscale"}`, () => {
        const rand = rng(name.length * 7919 + (binary ? 1 : 2));
        // Sizes smaller and larger than the kernel, so edges dominate some cases.
        for (const [w, h] of [[3, 2], [17, 11], [64, 48]]) {
          const img = randomImage(w, h, rand, binary);
          for (const iterations of [1, 2]) {
            for (const isDilate of [true, false]) {
              const got = (isDilate ? dilate : erode)(img, kernel, iterations);
              const want = morphReference(img, kernel, iterations, isDilate);
              assert.ok(
                Buffer.compare(Buffer.from(got.data), Buffer.from(want.data)) === 0,
                `${isDilate ? "dilate" : "erode"} ${w}x${h} x${iterations}`,
              );
            }
          }
        }
      });
    }
  }
});

describe("convex hull fast path matches the full monotone chain", () => {
  it("random integer pixel sets (dense, sparse, duplicates, collinear)", () => {
    const rand = rng(217);
    const cases: Array<Array<readonly [number, number]>> = [
      [[5, 5], [5, 5], [5, 5]], // one pixel, repeated
      [[0, 0], [1, 0], [2, 0], [3, 0]], // horizontal line
      [[2, 0], [2, 1], [2, 2]], // vertical line
    ];
    for (let n = 0; n < 200; n++) {
      const count = 3 + Math.floor(rand() * 300);
      const spread = 1 + Math.floor(rand() * (n % 2 ? 40 : 2000)); // dense and sparse in x
      const pts: Array<readonly [number, number]> = [];
      for (let i = 0; i < count; i++) pts.push([Math.floor(rand() * spread), Math.floor(rand() * 60)]);
      cases.push(pts);
    }
    for (const pts of cases) assert.deepEqual(convexHull(pts), hullReference(pts));
  });

  it("non-integer points take the full path and agree too", () => {
    const pts: Array<readonly [number, number]> = [[0.5, 0], [3, 1.25], [1, 4], [2, 2], [0, 3.5]];
    assert.deepEqual(convexHull(pts), hullReference(pts));
  });
});
