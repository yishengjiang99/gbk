/**
 * Hand-rolled image primitives for the homr OMR port.
 *
 * The Python implementation leans on OpenCV / numpy / PIL for grayscale
 * morphology, connected components, rotated rectangles, ellipse fitting,
 * polygon rasterisation, affine warps, resizing and CLAHE. None of those
 * are available (or desirable) in the browser worker, so this module
 * implements the exact operations the port needs, with the same semantics
 * as the OpenCV calls they replace (documented per function).
 *
 * Pixel values are 0..255 (0 = black, 255 = white), row-major.
 */

// ---------------------------------------------------------------------------
// Image containers
// ---------------------------------------------------------------------------

export class GrayImage {
  readonly data: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
    data?: Uint8Array,
  ) {
    this.data = data ?? new Uint8Array(width * height);
    if (this.data.length !== width * height) {
      throw new Error(`GrayImage: data length ${this.data.length} != ${width}x${height}`);
    }
  }

  static zeros(width: number, height: number): GrayImage {
    return new GrayImage(width, height);
  }

  static full(width: number, height: number, value: number): GrayImage {
    const img = new GrayImage(width, height);
    img.data.fill(value);
    return img;
  }

  clone(): GrayImage {
    return new GrayImage(this.width, this.height, new Uint8Array(this.data));
  }

  get(x: number, y: number): number {
    return this.data[y * this.width + x];
  }

  set(x: number, y: number, v: number): void {
    this.data[y * this.width + x] = v;
  }
}

export class FloatImage {
  readonly data: Float32Array;
  constructor(
    readonly width: number,
    readonly height: number,
    data?: Float32Array,
  ) {
    this.data = data ?? new Float32Array(width * height);
    if (this.data.length !== width * height) {
      throw new Error(`FloatImage: data length ${this.data.length} != ${width}x${height}`);
    }
  }

  static zeros(width: number, height: number): FloatImage {
    return new FloatImage(width, height);
  }

  clone(): FloatImage {
    return new FloatImage(this.width, this.height, new Float32Array(this.data));
  }

  get(x: number, y: number): number {
    return this.data[y * this.width + x];
  }

  set(x: number, y: number, v: number): void {
    this.data[y * this.width + x] = v;
  }
}

// ---------------------------------------------------------------------------
// Basic pixel ops (cv2.threshold / bitwise ops / subtract)
// ---------------------------------------------------------------------------

export function threshold(
  src: GrayImage,
  thresh: number,
  maxval: number,
  invert = false,
): GrayImage {
  const dst = GrayImage.zeros(src.width, src.height);
  const d = dst.data;
  const s = src.data;
  if (!invert) {
    for (let i = 0; i < s.length; i++) d[i] = s[i] > thresh ? maxval : 0;
  } else {
    for (let i = 0; i < s.length; i++) d[i] = s[i] > thresh ? 0 : maxval;
  }
  return dst;
}

export function bitwiseNot(src: GrayImage): GrayImage {
  const dst = GrayImage.zeros(src.width, src.height);
  for (let i = 0; i < src.data.length; i++) dst.data[i] = 255 - src.data[i];
  return dst;
}

/** Saturating subtraction, like cv2.subtract on uint8. */
export function subtract(a: GrayImage, b: GrayImage): GrayImage {
  const dst = GrayImage.zeros(a.width, a.height);
  const dd = dst.data;
  for (let i = 0; i < dd.length; i++) {
    const v = a.data[i] - b.data[i];
    dd[i] = v < 0 ? 0 : v;
  }
  return dst;
}

/** dst = src where mask != 0, else 0 (cv2.bitwise_and with mask). */
export function bitwiseAndMasked(src: GrayImage, mask: GrayImage): GrayImage {
  const dst = GrayImage.zeros(src.width, src.height);
  const dd = dst.data;
  for (let i = 0; i < dd.length; i++) dd[i] = mask.data[i] !== 0 ? src.data[i] : 0;
  return dst;
}

export function countNonZero(img: GrayImage): number {
  let n = 0;
  const d = img.data;
  for (let i = 0; i < d.length; i++) if (d[i] !== 0) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Structuring elements and morphology
// ---------------------------------------------------------------------------

export type KernelOffsets = Array<readonly [number, number]>;

/**
 * Rectangular kernel offsets, like cv2.getStructuringElement(MORPH_RECT).
 */
export function rectKernel(w: number, h: number): KernelOffsets {
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  const out: Array<readonly [number, number]> = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out.push([x - cx, y - cy] as const);
  }
  return out;
}

/**
 * Elliptical kernel offsets, matching cv2.getStructuringElement(MORPH_ELLIPSE):
 * pixels with ((x-cx)/rx)^2 + ((y-cy)/ry)^2 <= 1, where rx = cols/2,
 * ry = rows/2 and the centre is ((cols-1)/2, (rows-1)/2).
 */
export function ellipseKernel(cols: number, rows: number): KernelOffsets {
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  const rx = cols / 2;
  const ry = rows / 2;
  const out: Array<readonly [number, number]> = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1.0) out.push([x - Math.floor(cols / 2), y - Math.floor(rows / 2)] as const);
    }
  }
  return out;
}

function morph(
  src: GrayImage,
  kernel: KernelOffsets,
  iterations: number,
  isDilate: boolean,
): GrayImage {
  let cur = src;
  for (let it = 0; it < iterations; it++) {
    const dst = GrayImage.zeros(cur.width, cur.height);
    const { width: w, height: h } = cur;
    const sd = cur.data;
    const dd = dst.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let best = isDilate ? 0 : 255;
        for (let k = 0; k < kernel.length; k++) {
          const nx = x + kernel[k][0];
          const ny = y + kernel[k][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const v = sd[ny * w + nx];
          if (isDilate) {
            if (v > best) best = v;
          } else if (v < best) {
            best = v;
          }
        }
        dd[y * w + x] = best;
      }
    }
    cur = dst;
  }
  return cur;
}

/**
 * Grayscale dilation (max filter), like cv2.dilate on uint8. For binary 0/1
 * masks this is the OR over the kernel neighbourhood.
 */
export function dilate(src: GrayImage, kernel: KernelOffsets, iterations = 1): GrayImage {
  return morph(src, kernel, iterations, true);
}

/** Grayscale erosion (min filter), like cv2.erode on uint8. */
export function erode(src: GrayImage, kernel: KernelOffsets, iterations = 1): GrayImage {
  return morph(src, kernel, iterations, false);
}

// ---------------------------------------------------------------------------
// Connected components (replaces cv2.findContours where hierarchy is unused)
// ---------------------------------------------------------------------------

export interface Contour {
  /** All foreground pixel coordinates, flat [x0, y0, x1, y1, ...]. */
  pixels: Int32Array;
  /** Foreground pixel count (used like cv2.contourArea for size ranking). */
  area: number;
}

/**
 * Labels 8-connected foreground (non-zero) pixels, like
 * cv2.findContours(RETR_EXTERNAL / RETR_TREE, ...) in the places homr uses
 * it — the contour hierarchy is never consumed by the ported code, so only
 * the per-component pixel sets are returned.
 */
export function findContours(binary: GrayImage): Contour[] {
  const { width: w, height: h } = binary;
  const d = binary.data;
  const labels = new Int32Array(w * h).fill(-1);
  const contours: Contour[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (d[i] === 0 || labels[i] !== -1) continue;
    const id = contours.length;
    const px: number[] = [];
    stack.push(i);
    labels[i] = id;
    while (stack.length > 0) {
      const p = stack.pop() as number;
      const x = p % w;
      const y = (p / w) | 0;
      px.push(x, y);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const np = ny * w + nx;
          if (d[np] !== 0 && labels[np] === -1) {
            labels[np] = id;
            stack.push(np);
          }
        }
      }
    }
    contours.push({ pixels: new Int32Array(px), area: px.length / 2 });
  }
  return contours;
}

// ---------------------------------------------------------------------------
// Rotated rectangles (replaces cv2.minAreaRect / cv2.boxPoints)
// ---------------------------------------------------------------------------

export interface RotatedRect {
  cx: number;
  cy: number;
  /** Long/short side lengths as returned by OpenCV (see angle convention). */
  w: number;
  h: number;
  /** Degrees, in [-90, 0] following cv2.minAreaRect. */
  angle: number;
}

function convexHull(points: Array<readonly [number, number]>): Array<[number, number]> {
  const pts = points.map((p) => [p[0], p[1]] as [number, number]);
  pts.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const cross = (o: number[], a: number[], b: number[]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Minimum-area enclosing rectangle via rotating calipers over the convex
 * hull (O(h^2), h = hull size). Returns the OpenCV convention: angle in
 * [-90, 0], with width >= height enforced by an angle shift, matching
 * cv2.minAreaRect.
 */
export function minAreaRect(points: Array<readonly [number, number]>): RotatedRect {
  if (points.length === 0) return { cx: 0, cy: 0, w: 0, h: 0, angle: 0 };
  if (points.length === 1) {
    return { cx: points[0][0], cy: points[0][1], w: 0, h: 0, angle: 0 };
  }
  const hull = convexHull(points);
  if (hull.length === 1) {
    return { cx: hull[0][0], cy: hull[0][1], w: 0, h: 0, angle: 0 };
  }
  if (hull.length === 2) {
    const [ax, ay] = hull[0];
    const [bx, by] = hull[1];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let theta = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (theta < 0) theta += 180;
    const angle = theta < 90 ? theta - 90 : theta - 180;
    const w = theta < 90 ? 0 : len;
    const h = theta < 90 ? len : 0;
    return { cx: (ax + bx) / 2, cy: (ay + by) / 2, w, h, angle };
  }

  let best = { area: Infinity, cx: 0, cy: 0, w: 0, h: 0, angle: 0 };
  const n = hull.length;
  for (let i = 0; i < n; i++) {
    const p1 = hull[i];
    const p2 = hull[(i + 1) % n];
    const ex = p2[0] - p1[0];
    const ey = p2[1] - p1[1];
    const elen = Math.hypot(ex, ey);
    if (elen === 0) continue;
    const ux = ex / elen;
    const uy = ey / elen;
    const vx = -uy;
    const vy = ux;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let j = 0; j < n; j++) {
      const pu = hull[j][0] * ux + hull[j][1] * uy;
      const pv = hull[j][0] * vx + hull[j][1] * vy;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv;
      if (pv > maxV) maxV = pv;
    }
    const along = maxU - minU;
    const perp = maxV - minV;
    const area = along * perp;
    if (area < best.area) {
      // Calibrated against cv2.minAreaRect: for the winning hull edge with
      // direction theta in [0, 180), OpenCV reports the width axis at
      // angle = theta - 90 (theta < 90) or theta - 180 (theta >= 90).
      let theta = (Math.atan2(ey, ex) * 180) / Math.PI;
      if (theta < 0) theta += 180;
      let angle: number;
      let w: number;
      let h: number;
      if (theta < 90) {
        angle = theta - 90;
        w = perp;
        h = along;
      } else {
        angle = theta - 180;
        w = along;
        h = perp;
      }
      best = {
        area,
        cx: ((minU + maxU) / 2) * ux + ((minV + maxV) / 2) * vx,
        cy: ((minU + maxU) / 2) * uy + ((minV + maxV) / 2) * vy,
        w,
        h,
        angle,
      };
    }
  }
  if (!isFinite(best.area)) return { cx: 0, cy: 0, w: 0, h: 0, angle: 0 };
  return best;
}

/**
 * Four corners of a rotated rect, returned as a closed polygon loop
 * (counter-clockwise). Equivalent to cv2.boxPoints up to vertex order.
 */
export function boxPoints(r: RotatedRect): Array<[number, number]> {
  const rad = (r.angle * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const hw = r.w / 2;
  const hh = r.h / 2;
  const corners: Array<[number, number]> = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  return corners.map(([x, y]) => [r.cx + x * c - y * s, r.cy + x * s + y * c]);
}

/** Axis-aligned bounding box of a point set: [x, y, w, h] (cv2.boundingRect). */
export function boundingRect(points: Array<readonly [number, number]>): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const ix = Math.floor(minX);
  const iy = Math.floor(minY);
  return [ix, iy, Math.ceil(maxX) - ix + 1, Math.ceil(maxY) - iy + 1];
}

/**
 * Ellipse fit for notehead blobs. OpenCV's fitEllipse solves a constrained
 * least-squares problem; here we use the covariance (PCA) of the filled
 * pixel blob, which recovers the axes of a uniform ellipse exactly
 * (eigenvalue lambda_i = axis_i^2 / 4) and is robust for small blobs.
 * Returns ((cx, cy), (w, h), angleDeg) with angle in [0, 180).
 */
export function fitEllipse(points: Array<readonly [number, number]>): {
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
} {
  const n = points.length;
  if (n === 0) return { cx: 0, cy: 0, w: 0, h: 0, angle: 0 };
  let mx = 0;
  let my = 0;
  for (const [x, y] of points) {
    mx += x;
    my += y;
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    const dx = x - mx;
    const dy = y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  sxx /= n;
  sxy /= n;
  syy /= n;
  // Closed-form 2x2 eigendecomposition.
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr / 2) * (tr / 2) - det));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(0, tr / 2 - disc);
  const a = 2 * Math.sqrt(Math.max(0, l1));
  const b = 2 * Math.sqrt(Math.max(0, l2));
  let angle = (Math.atan2(2 * sxy, sxx - syy) / 2) * (180 / Math.PI);
  if (angle < 0) angle += 180;
  // OpenCV reports the angle of the *long* axis; atan2 above gives the
  // angle of the largest-variance axis already, but keep w >= h explicit.
  if (a >= b) {
    return { cx: mx, cy: my, w: 2 * a, h: 2 * b, angle };
  }
  return { cx: mx, cy: my, w: 2 * b, h: 2 * a, angle: (angle + 90) % 180 };
}

// ---------------------------------------------------------------------------
// Polygon utilities (replaces cv2.pointPolygonTest /
// cv2.rotatedRectangleIntersection / fillConvexPoly)
// ---------------------------------------------------------------------------

/** Ray-casting point-in-polygon; points on the edge count as inside. */
export function pointInPolygon(x: number, y: number, poly: Array<readonly [number, number]>): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    // On-edge test (within epsilon).
    const cross = (xj - xi) * (y - yi) - (yj - yi) * (x - xi);
    const dot = (x - xi) * (x - xj) + (y - yi) * (y - yj);
    if (Math.abs(cross) < 1e-9 && dot <= 1e-9) return true;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function polygonArea(poly: Array<readonly [number, number]>): number {
  let a = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/**
 * Intersection polygon of two convex polygons (Sutherland-Hodgman).
 * `clip` must be counter-clockwise... handled for either winding here.
 */
export function convexIntersect(
  subject: Array<readonly [number, number]>,
  clip: Array<readonly [number, number]>,
): Array<[number, number]> {
  let output: Array<[number, number]> = subject.map((p) => [p[0], p[1]]);
  const ccw = polygonArea(clip) > 0 !== isClockwise(clip);
  void ccw;
  for (let e = 0; e < clip.length; e++) {
    const a = clip[e];
    const b = clip[(e + 1) % clip.length];
    const input = output;
    output = [];
    if (input.length === 0) break;
    // Inside = left of edge a->b for CCW clip; compute orientation once.
    const orient = signedArea2(clip) > 0;
    let s = input[input.length - 1];
    for (const p of input) {
      const pIn = insideHalfPlane(p, a, b, orient);
      const sIn = insideHalfPlane(s, a, b, orient);
      if (pIn) {
        if (!sIn) output.push(lineIntersect(s, p, a, b));
        output.push(p);
      } else if (sIn) {
        output.push(lineIntersect(s, p, a, b));
      }
      s = p;
    }
  }
  return output;
}

function isClockwise(poly: Array<readonly [number, number]>): boolean {
  return signedArea2(poly) < 0;
}

function signedArea2(poly: Array<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a;
}

function insideHalfPlane(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
  ccw: boolean,
): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  return ccw ? cross >= -1e-9 : cross <= 1e-9;
}

function lineIntersect(
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  p4: readonly [number, number],
): [number, number] {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-12) return [p2[0], p2[1]];
  const t =
    ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
}

/**
 * Overlap test for two rotated rects, mirroring
 * cv2.rotatedRectangleIntersection(...) != INTERSECT_NONE (any touch counts)
 * plus homr's point-in-polygon fallback for touching boxes.
 */
export function rotatedRectsOverlap(a: RotatedRect, b: RotatedRect): boolean {
  const pa = boxPoints(a);
  const pb = boxPoints(b);
  if (polygonArea(convexIntersect(pa, pb)) > 1e-9) return true;
  for (const [x, y] of pa) if (pointInPolygon(x, y, pb)) return true;
  for (const [x, y] of pb) if (pointInPolygon(x, y, pa)) return true;
  return false;
}

/** Scanline fill of a convex polygon (replaces cv2.fillConvexPoly). */
export function fillConvexPoly(img: GrayImage, poly: Array<readonly [number, number]>, value: number): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of poly) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const y0 = Math.max(0, Math.ceil(minY));
  const y1 = Math.min(img.height - 1, Math.floor(maxY));
  const n = poly.length;
  for (let y = y0; y <= y1; y++) {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const [x1, y1p] = poly[i];
      const [x2, y2p] = poly[(i + 1) % n];
      if ((y1p <= y && y2p > y) || (y2p <= y && y1p > y)) {
        xs.push(x1 + ((y - y1p) / (y2p - y1p)) * (x2 - x1));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k]));
      const x1 = Math.min(img.width - 1, Math.floor(xs[k + 1]));
      for (let x = x0; x <= x1; x++) img.data[y * img.width + x] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Affine warps and resizing (replaces cv2.warpAffine / cv2.resize / PIL)
// ---------------------------------------------------------------------------

export type Affine2x3 = [number, number, number, number, number, number];

/**
 * 2x3 affine matrix mapping *source* coordinates to *destination*
 * coordinates, like the M argument of cv2.warpAffine / cv2.getRotationMatrix2D.
 * warpAffine inverts it internally, exactly as OpenCV does.
 */
export function invertAffine(m: Affine2x3): Affine2x3 {
  const [a, b, c, d, e, f] = m;
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0];
  const id = 1 / det;
  return [e * id, -b * id, (b * f - e * c) * id, -d * id, a * id, (d * c - a * f) * id];
}

/** Like cv2.getRotationMatrix2D(center, angleDeg, scale). */
export function getRotationMatrix2D(
  cx: number,
  cy: number,
  angleDeg: number,
  scale = 1,
): Affine2x3 {
  const rad = (angleDeg * Math.PI) / 180;
  const alpha = scale * Math.cos(rad);
  const beta = scale * Math.sin(rad);
  return [alpha, beta, (1 - alpha) * cx - beta * cy, -beta, alpha, beta * cx + (1 - alpha) * cy];
}

export interface WarpOptions {
  interpolation?: "nearest" | "bilinear";
  borderValue?: number;
}

/**
 * Affine warp with OpenCV semantics: M maps source -> destination pixels,
 * output has size (dstW, dstH). Bilinear matches cv2.INTER_LINEAR,
 * nearest matches cv2.INTER_NEAREST.
 */
export function warpAffine(
  src: GrayImage,
  m: Affine2x3,
  dstW: number,
  dstH: number,
  opts: WarpOptions = {},
): GrayImage {
  const { interpolation = "bilinear", borderValue = 0 } = opts;
  const inv = invertAffine(m);
  const [a, b, c, d, e, f] = inv;
  const dst = GrayImage.zeros(dstW, dstH);
  const sd = src.data;
  const sw = src.width;
  const sh = src.height;
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx = a * x + b * y + c;
      const sy = d * x + e * y + f;
      let v: number;
      if (interpolation === "nearest") {
        const ix = Math.round(sx);
        const iy = Math.round(sy);
        v = ix < 0 || iy < 0 || ix >= sw || iy >= sh ? borderValue : sd[iy * sw + ix];
      } else {
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const fx = sx - x0;
        const fy = sy - y0;
        const at = (ix: number, iy: number): number =>
          ix < 0 || iy < 0 || ix >= sw || iy >= sh ? borderValue : sd[iy * sw + ix];
        const v00 = at(x0, y0);
        const v10 = at(x0 + 1, y0);
        const v01 = at(x0, y0 + 1);
        const v11 = at(x0 + 1, y0 + 1);
        v = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
      }
      dst.data[y * dstW + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return dst;
}

function sampleBilinear(src: GrayImage, sx: number, sy: number, borderValue: number): number {
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const fx = sx - x0;
  const fy = sy - y0;
  const at = (ix: number, iy: number): number =>
    ix < 0 || iy < 0 || ix >= src.width || iy >= src.height ? borderValue : src.data[iy * src.width + ix];
  const v00 = at(x0, y0);
  const v10 = at(x0 + 1, y0);
  const v01 = at(x0, y0 + 1);
  const v11 = at(x0 + 1, y0 + 1);
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
}

export interface ResizeOptions {
  interpolation?: "nearest" | "bilinear";
}

/**
 * Resize to (w, h). Bilinear matches cv2.resize default (INTER_LINEAR);
 * nearest matches PIL.Image.resize's default (NEAREST), which homr uses
 * for the initial 1920-wide page resize.
 */
export function resize(src: GrayImage, w: number, h: number, opts: ResizeOptions = {}): GrayImage {
  const { interpolation = "bilinear" } = opts;
  if (w === src.width && h === src.height) return src.clone();
  const dst = GrayImage.zeros(w, h);
  const sx = src.width / w;
  const sy = src.height / h;
  if (interpolation === "nearest") {
    for (let y = 0; y < h; y++) {
      const iy = Math.min(src.height - 1, Math.floor((y + 0.5) * sy));
      for (let x = 0; x < w; x++) {
        const ix = Math.min(src.width - 1, Math.floor((x + 0.5) * sx));
        dst.data[y * w + x] = src.data[iy * src.width + ix];
      }
    }
    return dst;
  }
  // cv2.INTER_LINEAR samples at ((x + 0.5) * scale - 0.5).
  for (let y = 0; y < h; y++) {
    const syy = (y + 0.5) * sy - 0.5;
    for (let x = 0; x < w; x++) {
      const sxx = (x + 0.5) * sx - 0.5;
      dst.data[y * w + x] = Math.max(0, Math.min(255, Math.round(sampleBilinear(src, sxx, syy, 0))));
    }
  }
  return dst;
}

/**
 * Crop the rectangle (x, y, w, h), clipping to the image bounds
 * (like numpy slicing).
 */
export function crop(src: GrayImage, x: number, y: number, w: number, h: number): GrayImage {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(src.width, x + w);
  const y1 = Math.min(src.height, y + h);
  const dst = GrayImage.zeros(Math.max(0, x1 - x0), Math.max(0, y1 - y0));
  for (let yy = y0; yy < y1; yy++) {
    dst.data.set(src.data.subarray(yy * src.width + x0, yy * src.width + x1), (yy - y0) * dst.width);
  }
  return dst;
}

// ---------------------------------------------------------------------------
// Histogram / CLAHE (replaces cv2.calcHist / cv2.createCLAHE)
// ---------------------------------------------------------------------------

export function calcHist(src: GrayImage): number[] {
  const hist = new Array<number>(256).fill(0);
  const d = src.data;
  for (let i = 0; i < d.length; i++) hist[d[i]]++;
  return hist;
}

function clipHistogram(hist: number[], clipLimit: number): void {
  let excess = 0;
  for (let i = 0; i < 256; i++) {
    if (hist[i] > clipLimit) {
      excess += hist[i] - clipLimit;
      hist[i] = clipLimit;
    }
  }
  const redist = excess / 256;
  for (let i = 0; i < 256; i++) hist[i] += redist;
}

/**
 * Contrast Limited Adaptive Histogram Equalization, matching
 * cv2.createCLAHE(clipLimit=1.0, tileGridSize=(8, 8)).apply(gray).
 * OpenCV's clipLimit is scaled by tile area / 256 internally.
 */
export function clahe(src: GrayImage, clipLimit = 1.0, tilesX = 8, tilesY = 8): GrayImage {
  const { width: w, height: h } = src;
  const tileW = Math.max(1, Math.floor(w / tilesX));
  const tileH = Math.max(1, Math.floor(h / tilesY));
  const nx = Math.ceil(w / tileW);
  const ny = Math.ceil(h / tileH);
  // Per-tile LUTs.
  const luts: Uint8Array[] = [];
  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      const x0 = tx * tileW;
      const y0 = ty * tileH;
      const x1 = Math.min(w, x0 + tileW);
      const y1 = Math.min(h, y0 + tileH);
      const hist = new Array<number>(256).fill(0);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) hist[src.data[y * w + x]]++;
      }
      const area = (x1 - x0) * (y1 - y0);
      clipHistogram(hist, Math.max(1, (clipLimit * area) / 256));
      const lut = new Uint8Array(256);
      let sum = 0;
      const scale = 255 / area;
      for (let i = 0; i < 256; i++) {
        sum += hist[i];
        lut[i] = Math.max(0, Math.min(255, Math.round(sum * scale)));
      }
      luts.push(lut);
    }
  }
  const dst = GrayImage.zeros(w, h);
  for (let y = 0; y < h; y++) {
    // Bilinear blend between neighbouring tile LUTs (OpenCV semantics).
    const tyf = (y / tileH) - 0.5;
    let ty0 = Math.floor(tyf);
    let fy = tyf - ty0;
    if (ty0 < 0) {
      ty0 = 0;
      fy = 0;
    }
    if (ty0 >= ny - 1) {
      ty0 = ny - 2;
      fy = 1;
    }
    if (ny === 1) {
      ty0 = 0;
      fy = 0;
    }
    for (let x = 0; x < w; x++) {
      const txf = (x / tileW) - 0.5;
      let tx0 = Math.floor(txf);
      let fx = txf - tx0;
      if (tx0 < 0) {
        tx0 = 0;
        fx = 0;
      }
      if (tx0 >= nx - 1) {
        tx0 = nx - 2;
        fx = 1;
      }
      if (nx === 1) {
        tx0 = 0;
        fx = 0;
      }
      const v = src.data[y * w + x];
      const l00 = luts[ty0 * nx + tx0][v];
      const l10 = luts[ty0 * nx + tx0 + 1][v];
      const l01 = luts[(ty0 + 1) * nx + tx0][v];
      const l11 = luts[(ty0 + 1) * nx + tx0 + 1][v];
      const val = l00 * (1 - fx) * (1 - fy) + l10 * fx * (1 - fy) + l01 * (1 - fx) * fy + l11 * fx * fy;
      dst.data[y * w + x] = Math.max(0, Math.min(255, Math.round(val)));
    }
  }
  return dst;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** 2D convolution with a 3x3 kernel (replaces cv2.filter2D for estimate_noise). */
export function filter2DFloat(src: GrayImage, kernel: number[][]): FloatImage {
  const dst = FloatImage.zeros(src.width, src.height);
  const { width: w, height: h } = src;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let ky = -1; ky <= 1; ky++) {
        const iy = y + ky;
        if (iy < 0 || iy >= h) continue;
        for (let kx = -1; kx <= 1; kx++) {
          const ix = x + kx;
          if (ix < 0 || ix >= w) continue;
          acc += src.data[iy * w + ix] * kernel[ky + 1][kx + 1];
        }
      }
      dst.data[y * w + x] = acc;
    }
  }
  return dst;
}

export function meanGray(img: GrayImage): number {
  let s = 0;
  const d = img.data;
  for (let i = 0; i < d.length; i++) s += d[i];
  return s / d.length;
}

/** Mean of pixels where mask != 0 (replaces cv2.mean with mask). */
export function meanMasked(img: GrayImage, mask: GrayImage): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < img.data.length; i++) {
    if (mask.data[i] !== 0) {
      s += img.data[i];
      n++;
    }
  }
  return n === 0 ? 0 : s / n;
}

export function argmax(arr: number[] | Uint8Array | Float32Array | Float64Array): number {
  let best = 0;
  let bestV = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > bestV) {
      bestV = arr[i];
      best = i;
    }
  }
  return best;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
