/**
 * Staff dewarping: TypeScript port of homr's staff_dewarping.py and the
 * staff-crop pipeline in staff_parsing.py (prepare_staff_image).
 *
 * Faithful details preserved from the Python:
 * - Region: x +/- 2*unitSize, y +/- 4*unitSize clipped by StaffRegions.
 * - The full page image is resized by scaling_factor =
 *   image_dimensions[1] / region_height, where image_dimensions comes from
 *   get_tr_omr_canvas_size; region is np.round'ed after scaling.
 * - Crop expansion [-10, -50, +10, +50]; staff coords transformed as
 *   (p - top_left) * scaling_factor, with dewarp_point applied in between
 *   for the second pass (see _dewarp_staff).
 * - Dewarp control points: six vertical bands (top line, top area, middle
 *   area, staff middle line, bottom area, bottom line), x sampled every
 *   80px; each line displaced from the staff middle line y[2], then
 *   flattened to its average y. Endpoints at x=0/width and the image
 *   top/bottom edges are added as fixed control points.
 * - Piecewise-affine warp via Delaunay triangulation, inverse-mapped with
 *   bilinear interpolation, outside filled with 1 (black on the 0-1 scale).
 * - After warping: crop back to region_step2, whiten large dark
 *   edge-connected blobs, resize and centre on a white 1280x256 canvas.
 *
 * Fidelity gaps vs the Python (documented, not hidden):
 * - Delaunay triangulation is Bowyer-Watson; scipy uses Qhull. Both are
 *   valid triangulations, but degenerate (cocircular) point sets may be
 *   triangulated differently, changing the warp slightly.
 * - np.round uses round-half-to-even; Math.round uses round-half-up.
 *   Differs only when a scaled region coordinate lands exactly on .5.
 * - skimage.warp border/interpolation details may differ by a pixel at
 *   control-point boundaries.
 * - The Python try/except in dewarp_staff_image returns StaffDewarping(None)
 *   on any error (identity); this port mirrors that behaviour.
 */

import { GrayImage, crop, findContours, resize } from "./image.ts";
import { Staff, StaffRegions } from "./staff-model.ts";

// ---------------------------------------------------------------------------
// Canvas constants (homr/transformer/configs.py: max_height=256, max_width=1280)
// ---------------------------------------------------------------------------

export const TR_OMR_MAX_HEIGHT = 256;
export const TR_OMR_MAX_WIDTH = 1280;

type Pt = [number, number];

// ---------------------------------------------------------------------------
// Delaunay triangulation (Bowyer-Watson; replaces scipy.spatial.Delaunay)
// ---------------------------------------------------------------------------

function dedupePoints(points: Pt[]): Pt[] {
  const seen = new Set<string>();
  const out: Pt[] = [];
  for (const p of points) {
    const key = `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

function orient2d(a: Pt, b: Pt, c: Pt): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
}

/** True when p lies strictly inside the circumcircle of triangle abc. */
function inCircumcircle(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const ax = a[0] - p[0];
  const ay = a[1] - p[1];
  const bx = b[0] - p[0];
  const by = b[1] - p[1];
  const cx = c[0] - p[0];
  const cy = c[1] - p[1];
  const det =
    (ax * ax + ay * ay) * (bx * cy - by * cx) -
    (bx * bx + by * by) * (ax * cy - ay * cx) +
    (cx * cx + cy * cy) * (ax * by - ay * bx);
  const orient = orient2d(a, b, c);
  if (Math.abs(orient) < 1e-12) return false;
  return orient > 0 ? det > 1e-9 : det < -1e-9;
}

interface Tri {
  a: number;
  b: number;
  c: number;
}

/**
 * Delaunay triangulation of a point set; returns index triples into the
 * deduplicated point list. Bowyer-Watson incremental insertion.
 */
export function delaunayTriangulation(points: Pt[]): Array<[number, number, number]> {
  const pts = dedupePoints(points);
  const n = pts.length;
  if (n < 3) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  const dx = Math.max(1, maxX - minX);
  const dy = Math.max(1, maxY - minY);
  const delta = Math.max(dx, dy) * 100;
  const all: Pt[] = pts.concat([
    [minX - delta, minY - delta],
    [minX + dx / 2, maxY + delta],
    [maxX + delta, minY - delta],
  ]);
  let triangles: Tri[] = [{ a: n, b: n + 1, c: n + 2 }];
  for (let i = 0; i < n; i++) {
    const p = all[i];
    const bad: Tri[] = [];
    const kept: Tri[] = [];
    for (const tri of triangles) {
      if (inCircumcircle(p, all[tri.a], all[tri.b], all[tri.c])) bad.push(tri);
      else kept.push(tri);
    }
    // Boundary edges of the polygonal hole: edges occurring exactly once.
    const counts = new Map<string, number>();
    const edgeOf = new Map<string, [number, number]>();
    for (const tri of bad) {
      const edges: Array<[number, number]> = [
        [tri.a, tri.b],
        [tri.b, tri.c],
        [tri.c, tri.a],
      ];
      for (const [u, v] of edges) {
        const key = u < v ? `${u},${v}` : `${v},${u}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        edgeOf.set(key, [u, v]);
      }
    }
    triangles = kept;
    for (const [key, count] of counts) {
      if (count === 1) {
        const [u, v] = edgeOf.get(key) as [number, number];
        triangles.push({ a: u, b: i, c: v });
      }
    }
  }
  return triangles
    .filter((t) => t.a < n && t.b < n && t.c < n)
    .map((t) => [t.a, t.b, t.c] as [number, number, number]);
}

// ---------------------------------------------------------------------------
// Piecewise-affine transform (replaces skimage.transform.PiecewiseAffineTransform)
// ---------------------------------------------------------------------------

/** Solves the affine map src -> dst for three point correspondences. */
function affineFromTriangles(
  src: Array<Pt>,
  dst: Array<Pt>,
): { a: number; b: number; tx: number; c: number; d: number; ty: number } | null {
  const [x0, y0] = src[0];
  const [x1, y1] = src[1];
  const [x2, y2] = src[2];
  const [u0, v0] = dst[0];
  const [u1, v1] = dst[1];
  const [u2, v2] = dst[2];
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(det) < 1e-12) return null;
  const du1 = u1 - u0;
  const du2 = u2 - u0;
  const dv1 = v1 - v0;
  const dv2 = v2 - v0;
  const a = (du1 * (y2 - y0) - du2 * (y1 - y0)) / det;
  const b = ((x1 - x0) * du2 - (x2 - x0) * du1) / det;
  const c = (dv1 * (y2 - y0) - dv2 * (y1 - y0)) / det;
  const d = ((x1 - x0) * dv2 - (x2 - x0) * dv1) / det;
  return { a, b, tx: u0 - a * x0 - b * y0, c, d, ty: v0 - c * x0 - d * y0 };
}

interface Affine6 {
  a: number;
  b: number;
  tx: number;
  c: number;
  d: number;
  ty: number;
}

function applyAffine(m: Affine6, x: number, y: number): Pt {
  return [m.a * x + m.b * y + m.tx, m.c * x + m.d * y + m.ty];
}

/**
 * Piecewise-affine transform estimated from src -> dst control points.
 * `inverse` mirrors skimage's tform.inverse (estimates dst -> src).
 * `warp` inverse-maps the output image through the transform with bilinear
 * sampling, filling outside with `fill` (0-255).
 */
export class PiecewiseAffineTransform {
  private src: Pt[] = [];
  private triangles: Array<[number, number, number]> = [];
  private affines: Array<Affine6 | null> = [];

  estimate(src: Pt[], dst: Pt[]): void {
    this.src = src;
    this.triangles = delaunayTriangulation(src);
    this.affines = this.triangles.map((tri) =>
      affineFromTriangles(
        [src[tri[0]], src[tri[1]], src[tri[2]]],
        [dst[tri[0]], dst[tri[1]], dst[tri[2]]],
      ),
    );
  }

  get inverse(): PiecewiseAffineTransform {
    throw new Error("Use PiecewiseAffineTransform.inverseOf(src, dst) instead");
  }

  /** Builds the dst -> src transform (equivalent to skimage's tform.inverse). */
  static inverseOf(src: Pt[], dst: Pt[]): PiecewiseAffineTransform {
    const t = new PiecewiseAffineTransform();
    t.estimate(dst, src);
    return t;
  }

  /** Finds the triangle containing p (in the estimate's source space). */
  private findTriangle(p: Pt): number {
    for (let i = 0; i < this.triangles.length; i++) {
      const tri = this.triangles[i];
      const a = this.src[tri[0]];
      const b = this.src[tri[1]];
      const c = this.src[tri[2]];
      if (pointInTriangle(p, a, b, c)) return i;
    }
    return -1;
  }

  /** Maps one point through the estimated transform; null when outside. */
  transformPoint(p: Pt): Pt | null {
    const i = this.findTriangle(p);
    if (i < 0) return null;
    const m = this.affines[i];
    if (m === null) return null;
    return applyAffine(m, p[0], p[1]);
  }

  /**
   * Inverse-warps `image` into an (outH x outW) image. Each output pixel is
   * mapped back to the source image (the estimate's destination space) and
   * sampled bilinearly; pixels mapping outside get `fill`.
   */
  warp(image: GrayImage, outW: number, outH: number, fill: number): GrayImage {
    const out = GrayImage.zeros(outW, outH);
    out.data.fill(fill);
    for (let i = 0; i < this.triangles.length; i++) {
      const tri = this.triangles[i];
      const m = this.affines[i];
      if (m === null) continue;
      const a = this.src[tri[0]];
      const b = this.src[tri[1]];
      const c = this.src[tri[2]];
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
      const x1 = Math.min(outW - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
      const y1 = Math.min(outH - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (!pointInTriangle([x, y], a, b, c)) continue;
          const [sx, sy] = applyAffine(m, x, y);
          out.data[y * outW + x] = sampleBilinearFill(image, sx, sy, fill);
        }
      }
    }
    return out;
  }
}

function pointInTriangle(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const d1 = orient2d(p, a, b);
  const d2 = orient2d(p, b, c);
  const d3 = orient2d(p, c, a);
  const hasNeg = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9;
  const hasPos = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
  return !(hasNeg && hasPos);
}

function sampleBilinearFill(img: GrayImage, x: number, y: number, fill: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (ix: number, iy: number): number =>
    ix < 0 || iy < 0 || ix >= img.width || iy >= img.height ? fill : img.data[iy * img.width + ix];
  const v =
    at(x0, y0) * (1 - fx) * (1 - fy) +
    at(x0 + 1, y0) * fx * (1 - fy) +
    at(x0, y0 + 1) * (1 - fx) * fy +
    at(x0 + 1, y0 + 1) * fx * fy;
  return Math.max(0, Math.min(255, Math.round(v)));
}

// ---------------------------------------------------------------------------
// StaffDewarping (homr/staff_dewarping.py)
// ---------------------------------------------------------------------------

export class StaffDewarping {
  constructor(private readonly inverse: PiecewiseAffineTransform | null) {}

  /** Dewarps the whole image; identity when no transform was estimated. */
  dewarp(image: GrayImage): GrayImage {
    if (this.inverse === null) return image;
    return this.inverse.warp(image, image.width, image.height, 1);
  }

  /** Dewarps a single point; returns it unchanged when outside/identity. */
  dewarpPoint(point: Pt): Pt {
    if (this.inverse === null) return point;
    return this.inverse.transformPoint(point) ?? point;
  }
}

/**
 * Builds the source (span) and destination (optimal/straight) control
 * point grids. Direct port of calculate_span_and_optimal_points: six
 * horizontal bands across the image; each band's points follow the staff's
 * vertical drift (y[2] offset from the first sample), and the optimal
 * points are the same x positions at the band's average y.
 */
export function calculateSpanAndOptimalPoints(
  staff: Staff,
  image: GrayImage,
): { spanPoints: Pt[][]; optimalPoints: Pt[][] } {
  const imageWidth = image.width;
  const imageHeight = image.height;
  const spanPoints: Pt[][] = [];
  const optimalPoints: Pt[][] = [];
  let firstYOffset: number | null = null;
  const numberOfYIntervals = 6;
  const yStep = Math.trunc(imageHeight / numberOfYIntervals);
  if (yStep === 0) return { spanPoints, optimalPoints };
  const inImage = (x: number, y: number): boolean => {
    const margin = 10;
    return !(x < margin || x > imageWidth - margin || y < margin || y > imageHeight - margin);
  };
  for (let y = 2; y < imageHeight - 2; y += yStep) {
    const linePoints: Pt[] = [];
    for (let x = 2; x < imageWidth; x += 80) {
      const values = staff.getAt(x);
      if (values === null) continue;
      const yOffset = values.y[2];
      let yDelta: number;
      if (!firstYOffset) {
        firstYOffset = yOffset;
        yDelta = 0;
      } else {
        yDelta = Math.trunc(yOffset - firstYOffset);
      }
      const point: Pt = [x, y + yDelta];
      if (inImage(point[0], point[1])) linePoints.push(point);
    }
    if (linePoints.length > 2) {
      const averageY = linePoints.reduce((s, p) => s + p[1], 0) / linePoints.length;
      spanPoints.push(linePoints);
      optimalPoints.push(linePoints.map(([px]) => [px, Math.trunc(averageY)] as Pt));
    }
  }
  return { spanPoints, optimalPoints };
}

/**
 * Estimates the piecewise-affine dewarp transform from the control grids.
 * Direct port of calculate_dewarp_transformation.
 */
export function calculateDewarpTransformation(
  image: GrayImage,
  spanPoints: Pt[][],
  optimalPoints: Pt[][],
): StaffDewarping {
  const width = image.width;
  const height = image.height;
  // add_first_and_last_point_to_every_line
  const extend = (lines: Pt[][]): Pt[][] =>
    lines.map((line) => [[0, line[0][1]] as Pt, ...line, [width, line[line.length - 1][1]] as Pt]);
  const srcLines: Pt[][] = extend(spanPoints);
  const dstLines: Pt[][] = extend(optimalPoints);
  // add_image_edges_to_lines
  srcLines.unshift([[0, 0], [width, 0]]);
  srcLines.push([[0, height], [width, height]]);
  dstLines.unshift([[0, 0], [width, 0]]);
  dstLines.push([[0, height], [width, height]]);
  const source = srcLines.flat();
  const destination = dstLines.flat();
  // warp_image forward-maps source -> destination; this port inverse-warps
  // (destination frame -> source samples), hence inverseOf.
  const inverse = PiecewiseAffineTransform.inverseOf(source, destination);
  return new StaffDewarping(inverse);
}

/** Port of dewarp_staff_image: identity StaffDewarping on any failure. */
export function dewarpStaffImage(image: GrayImage, staff: Staff): StaffDewarping {
  try {
    const { spanPoints, optimalPoints } = calculateSpanAndOptimalPoints(staff, image);
    return calculateDewarpTransformation(image, spanPoints, optimalPoints);
  } catch {
    return new StaffDewarping(null);
  }
}

// ---------------------------------------------------------------------------
// Staff crop pipeline (homr/staff_parsing.py)
// ---------------------------------------------------------------------------

/**
 * Crops to (x1,y1)-(x2,y2) in numpy-slice semantics and returns the new
 * top-left corner. Direct port of crop_image_and_return_new_top.
 */
export function cropImageAndReturnNewTop(
  image: GrayImage,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { image: GrayImage; topLeft: Pt } {
  const xMin = Math.min(x1, x2);
  const xMax = Math.max(x1, x2);
  const yMin = Math.min(y1, y2);
  const yMax = Math.max(y1, y2);
  const x1l = Math.max(0, Math.min(image.width - 1, Math.round(xMin)));
  const y1l = Math.max(0, Math.min(image.height - 1, Math.round(yMin)));
  const x2l = Math.max(0, Math.min(image.width - 1, Math.round(xMax)));
  const y2l = Math.max(0, Math.min(image.height - 1, Math.round(yMax)));
  return {
    image: crop(image, x1l, y1l, Math.max(0, x2l - x1l), Math.max(0, y2l - y1l)),
    topLeft: [x1l, y1l],
  };
}

/**
 * Aspect-preserving size fitting (tr_omr_max_width, tr_omr_max_height).
 * Returns [width, height] like cv2.resize expects. Direct port of
 * get_tr_omr_canvas_size.
 */
export function getTrOmrCanvasSize(
  imageH: number,
  imageW: number,
  marginTop = 0,
  marginBottom = 0,
): [number, number] {
  const maxH = TR_OMR_MAX_HEIGHT - marginTop - marginBottom;
  const ratio = maxH / TR_OMR_MAX_WIDTH;
  if (imageH / imageW > ratio) {
    return [Math.trunc((imageW / imageH) * maxH), maxH];
  }
  return [TR_OMR_MAX_WIDTH, Math.trunc((imageH / imageW) * TR_OMR_MAX_WIDTH)];
}

/**
 * Resizes to (canvasW, canvasH) and pastes onto a white
 * (TR_OMR_MAX_HEIGHT x TR_OMR_MAX_WIDTH) canvas, vertically centred.
 * Direct port of center_image_on_canvas.
 */
export function centerImageOnCanvas(
  image: GrayImage,
  canvasW: number,
  canvasH: number,
  marginTop = 0,
  marginBottom = 0,
): GrayImage {
  const resized = resize(image, canvasW, canvasH);
  const canvas = GrayImage.zeros(TR_OMR_MAX_WIDTH, TR_OMR_MAX_HEIGHT);
  canvas.data.fill(255);
  const maxH = TR_OMR_MAX_HEIGHT - marginTop - marginBottom;
  const yOffset = Math.trunc((maxH - resized.height) / 2) + marginTop;
  const xOffset = 0;
  for (let y = 0; y < resized.height; y++) {
    const dy = y + yOffset;
    if (dy < 0 || dy >= canvas.height) continue;
    canvas.data.set(
      resized.data.subarray(y * resized.width, (y + 1) * resized.width),
      dy * canvas.width + xOffset,
    );
  }
  return canvas;
}

/**
 * Whitens large dark blobs touching the image edge. Direct port of
 * remove_black_contours_at_edges_of_image.
 */
export function removeBlackContoursAtEdgesOfImage(image: GrayImage, unitSize: number): GrayImage {
  const out = image.clone();
  const inverted = GrayImage.zeros(image.width, image.height);
  for (let i = 0; i < image.data.length; i++) {
    inverted.data[i] = image.data[i] < 97 ? 255 : 0;
  }
  const contours = findContours(inverted);
  const limit = 2 * unitSize;
  for (const cnt of contours) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < cnt.pixels.length; i += 2) {
      const x = cnt.pixels[i];
      const y = cnt.pixels[i + 1];
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (w < limit || h < limit) continue;
    const atEdge = x0 === 0 || y0 === 0 || x1 === image.width - 1 || y1 === image.height - 1;
    if (!atEdge) continue;
    // mean over the inverted region: >= 127 means mostly dark in the original.
    let sum = 0;
    let n = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        sum += inverted.data[y * image.width + x];
        n++;
      }
    }
    if (n > 0 && sum / n < 127) continue;
    for (let y = y0; y <= y1; y++) {
      out.data.fill(255, y * image.width + x0, y * image.width + x1 + 1);
    }
  }
  return out;
}

/**
 * Applies the same geometric transformation to staff coordinates as was
 * applied to the image: subtract region, optionally dewarp the point, then
 * scale. Direct port of _dewarp_staff.
 */
export function transformStaffCoordinates(
  staff: Staff,
  dewarp: StaffDewarping | null,
  region: Pt,
  scaling: number,
): Staff {
  return staff.transformCoordinates((point) => {
    let [x, y] = point;
    x -= region[0];
    y -= region[1];
    if (dewarp !== null) [x, y] = dewarp.dewarpPoint([x, y]);
    return [x * scaling, y * scaling];
  });
}

/**
 * Maps a point in the final 1280x256 staff crop back to page pixels.
 * Coarse: the dewarp is piecewise-affine and the canvas centering rounds
 * offsets, so boxes derived from this are approximate (documented).
 */
export type CropToPageMapping = (x: number, y: number) => [number, number];

export interface PreparedStaffImage {
  /** 1280x256 grayscale encoder crop. */
  image: GrayImage;
  /** Staff in the pre-dewarp expanded-crop frame (kept for parity checks). */
  staff: Staff;
  /** Crop-pixel -> page-pixel mapping for attention boxes. */
  cropToPage: CropToPageMapping;
}

/**
 * Full staff-crop pipeline: region -> resize -> expanded crop -> dewarp ->
 * region crop -> edge cleanup -> 1280x256 canvas. Direct port of
 * prepare_staff_image (homr/staff_parsing.py).
 */
export function prepareStaffImage(
  staff: Staff,
  staffImage: GrayImage,
  regions: StaffRegions,
): PreparedStaffImage {
  const unitSize = staff.averageUnitSize;
  const xMin = Math.trunc(staff.minX - 2 * unitSize);
  const yMin = Math.trunc(
    Math.max(staff.minY - 4 * unitSize, regions.getStartOfClosestStaffAbove(staff.minY)),
  );
  const xMax = Math.trunc(staff.maxX + 2 * unitSize);
  const yMax = Math.trunc(
    Math.min(staff.maxY + 4 * unitSize, regions.getStartOfClosestStaffBelow(staff.maxY)),
  );
  const [canvasW, canvasH] = getTrOmrCanvasSize(yMax - yMin, xMax - xMin);
  const scalingFactor = canvasH / (yMax - yMin);
  let image = resize(
    staffImage,
    Math.trunc(staffImage.width * scalingFactor),
    Math.trunc(staffImage.height * scalingFactor),
  );
  // np.round: round-half-to-even vs Math.round half-up differs only on exact .5.
  const scaledRegion: Pt = [
    Math.round(xMin * scalingFactor),
    Math.round(yMin * scalingFactor),
  ];
  const scaledRegionMax: Pt = [
    Math.round(xMax * scalingFactor),
    Math.round(yMax * scalingFactor),
  ];
  // Expanded crop: region + [-10, -50, 10, 50].
  const expanded = cropImageAndReturnNewTop(
    image,
    scaledRegion[0] - 10,
    scaledRegion[1] - 50,
    scaledRegionMax[0] + 10,
    scaledRegionMax[1] + 50,
  );
  image = expanded.image;
  const topLeftExp = expanded.topLeft;
  const regionStep2: Pt[] = [
    [scaledRegion[0] - topLeftExp[0], scaledRegion[1] - topLeftExp[1]],
    [scaledRegionMax[0] - topLeftExp[0], scaledRegionMax[1] - topLeftExp[1]],
  ];
  const topLeftUnscaled: Pt = [topLeftExp[0] / scalingFactor, topLeftExp[1] / scalingFactor];
  const transformedStaff = transformStaffCoordinates(staff, null, topLeftUnscaled, scalingFactor);
  const dewarp = dewarpStaffImage(image, transformedStaff);
  image = dewarp.dewarp(image);
  const step2 = cropImageAndReturnNewTop(
    image,
    regionStep2[0][0],
    regionStep2[0][1],
    regionStep2[1][0],
    regionStep2[1][1],
  );
  image = step2.image;
  const rs2 = step2.topLeft;
  image = removeBlackContoursAtEdgesOfImage(image, transformedStaff.averageUnitSize);
  const yOffset = Math.trunc((TR_OMR_MAX_HEIGHT - canvasH) / 2);
  image = centerImageOnCanvas(image, canvasW, canvasH);

  const cropToPage: CropToPageMapping = (x, y) => {
    // Undo canvas centering + resize.
    const rx = (x * canvasW) / TR_OMR_MAX_WIDTH;
    const ry = ((y - yOffset) * canvasH) / TR_OMR_MAX_HEIGHT;
    // Undo the region_step2 crop (warped frame).
    const wx = rx + rs2[0];
    const wy = ry + rs2[1];
    // Undo the dewarp (warped -> pre-warp expanded-crop frame).
    const [px, py] = dewarp.dewarpPoint([wx, wy]);
    // Undo the expanded crop + scaling.
    return [(px + topLeftExp[0]) / scalingFactor, (py + topLeftExp[1]) / scalingFactor];
  };
  return { image, staff: transformedStaff, cropToPage };
}
