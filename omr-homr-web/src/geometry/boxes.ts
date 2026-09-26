/**
 * Bounding-box primitives: TypeScript port of homr's bounding_boxes.py.
 *
 * Faithful details preserved from the Python:
 * - RotatedBoundingBox normalises the minAreaRect angle into [-45, 45].
 * - top_left/bottom_left/top_right/bottom_right are the *axis-aligned*
 *   extent corners (homr's calculate_edges_of_rotated_rectangle ignores the
 *   angle), while `polygon` holds the true rotated corners for overlap.
 * - is_overlapping / is_intersecting use the _can_shapes_possibly_touch
 *   distance precheck, then convex-polygon intersection with a touching
 *   fallback (homr's do_polygons_overlap).
 * - Merging refits minAreaRect over the concatenated contour points.
 */

import {
  Contour,
  GrayImage,
  RotatedRect,
  boxPoints,
  convexIntersect,
  findContours,
  minAreaRect,
  pointInPolygon,
  polygonArea,
  fitEllipse,
} from "./image.ts";
import { STAFF_LINE_SEGMENT_X_TOLERANCE } from "./staff-model.ts";

// ---------------------------------------------------------------------------
// Polygon overlap (homr's do_polygons_overlap)
// ---------------------------------------------------------------------------

/**
 * True when two convex polygons overlap with positive area, or merely touch
 * (shared edge/corner, boundary-inclusive vertex check).
 */
export function doPolygonsOverlap(
  poly1: Array<readonly [number, number]>,
  poly2: Array<readonly [number, number]>,
): boolean {
  if (polygonArea(convexIntersect(poly1, poly2)) > 0) return true;
  for (const [x, y] of poly1) if (pointInPolygon(x, y, poly2)) return true;
  for (const [x, y] of poly2) if (pointInPolygon(x, y, poly1)) return true;
  return false;
}

/** Axis-aligned extent corners, ignoring rotation (homr's convention). */
export function extentCorners(rect: RotatedRect): {
  topLeft: [number, number];
  bottomLeft: [number, number];
  topRight: [number, number];
  bottomRight: [number, number];
} {
  const hw = rect.w / 2;
  const hh = rect.h / 2;
  return {
    topLeft: [rect.cx - hw, rect.cy - hh],
    bottomLeft: [rect.cx - hw, rect.cy + hh],
    topRight: [rect.cx + hw, rect.cy - hh],
    bottomRight: [rect.cx + hw, rect.cy + hh],
  };
}

export type AnyBox = RotatedBoundingBox | BoundingEllipse;

function canShapesPossiblyTouch(a: AnyBox, b: AnyBox): boolean {
  const major1 = Math.max(a.rect.w, a.rect.h);
  const major2 = Math.max(b.rect.w, b.rect.h);
  const dx = a.rect.cx - b.rect.cx;
  const dy = a.rect.cy - b.rect.cy;
  return Math.hypot(dx, dy) <= major1 + major2;
}

function contourPoints(c: Contour): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < c.pixels.length; i += 2) pts.push([c.pixels[i], c.pixels[i + 1]]);
  return pts;
}

// ---------------------------------------------------------------------------
// RotatedBoundingBox
// ---------------------------------------------------------------------------

export class RotatedBoundingBox {
  readonly rect: RotatedRect;
  /** Contour pixel points, kept so merges can refit over concatenated points. */
  readonly points: Array<[number, number]>;
  readonly polygon: Array<[number, number]>;
  readonly topLeft: [number, number];
  readonly bottomLeft: [number, number];
  readonly topRight: [number, number];
  readonly bottomRight: [number, number];
  readonly debugId: number;

  constructor(rect: RotatedRect, points: Array<[number, number]> = [], debugId = 0) {
    let { cx, cy, w, h, angle } = rect;
    if (angle > 135) {
      angle -= 180;
    } else if (angle < -135) {
      angle += 180;
    } else if (angle > 45) {
      angle = angle - 90;
      [w, h] = [h, w];
    } else if (angle < -45) {
      angle = angle + 90;
      [w, h] = [h, w];
    }
    this.rect = { cx, cy, w, h, angle };
    this.points = points;
    this.polygon = boxPoints(this.rect);
    const e = extentCorners(this.rect);
    this.topLeft = e.topLeft;
    this.bottomLeft = e.bottomLeft;
    this.topRight = e.topRight;
    this.bottomRight = e.bottomRight;
    this.debugId = debugId;
  }

  /** ((cx, cy), (w, h), angle) tuple form. */
  get box(): RotatedRect {
    return this.rect;
  }

  get center(): [number, number] {
    return [this.rect.cx, this.rect.cy];
  }

  get size(): [number, number] {
    return [this.rect.w, this.rect.h];
  }

  get angle(): number {
    return this.rect.angle;
  }

  get area(): number {
    return this.rect.w * this.rect.h;
  }

  isOverlapping(other: AnyBox): boolean {
    if (!canShapesPossiblyTouch(this, other)) return false;
    return doPolygonsOverlap(this.polygon, other.polygon);
  }

  isOverlappingWithAny(others: AnyBox[]): boolean {
    for (const o of others) if (this.isOverlapping(o)) return true;
    return false;
  }

  /** Like cv2.rotatedRectangleIntersection(...) != INTERSECT_NONE. */
  isIntersecting(other: RotatedBoundingBox): boolean {
    if (!canShapesPossiblyTouch(this, other)) return false;
    return doPolygonsOverlap(this.polygon, other.polygon);
  }

  makeBoxThicker(thickness: number): RotatedBoundingBox {
    if (thickness <= 0) return this;
    const r = this.rect;
    return new RotatedBoundingBox(
      { cx: r.cx, cy: r.cy, w: r.w + thickness, h: r.h + thickness, angle: r.angle },
      this.points,
      this.debugId,
    );
  }

  makeBoxTaller(thickness: number): RotatedBoundingBox {
    const r = this.rect;
    return new RotatedBoundingBox(
      { cx: r.cx, cy: r.cy, w: r.w, h: r.h + thickness, angle: r.angle },
      this.points,
      this.debugId,
    );
  }

  makeBoxTallerKeepCenter(thickness: number): RotatedBoundingBox {
    const r = this.rect;
    return new RotatedBoundingBox(
      { cx: r.cx, cy: r.cy - Math.floor(thickness / 2), w: r.w, h: r.h + thickness, angle: r.angle },
      this.points,
      this.debugId,
    );
  }

  moveToXHorizontalBy(xDelta: number): RotatedBoundingBox {
    const r = this.rect;
    return new RotatedBoundingBox(
      { cx: r.cx + xDelta, cy: r.cy, w: r.w, h: r.h, angle: r.angle },
      this.points,
      this.debugId,
    );
  }

  ensureMinDimension(minWidth: number, minHeight: number): RotatedBoundingBox {
    const r = this.rect;
    return new RotatedBoundingBox(
      {
        cx: r.cx,
        cy: r.cy,
        w: Math.max(r.w, minWidth),
        h: Math.max(r.h, minHeight),
        angle: r.angle,
      },
      this.points,
      this.debugId,
    );
  }

  /** y of the box's angled centre line at x (extrapolated). */
  getCenterExtrapolated(x: number): number {
    const r = this.rect;
    return (x - r.cx) * Math.tan((r.angle / 180) * Math.PI) + r.cy;
  }

  /**
   * Whether two fragments plausibly continue the same staff line:
   * their extrapolated centres meet near the midpoint within tolerance.
   */
  isOverlappingExtrapolated(other: RotatedBoundingBox, unitSize: number): boolean {
    const left = this.rect.cx > other.rect.cx ? other : this;
    const right = left === this ? other : this;
    const centerX = (left.rect.cx + right.rect.cx) * 0.5;
    const tolerance = unitSize / 3;
    const maxGap = 5 * unitSize;
    if (
      centerX - left.rect.cx - Math.floor(left.rect.w / 2) > maxGap ||
      right.rect.cx - centerX - Math.floor(right.rect.w / 2) > maxGap
    ) {
      return false;
    }
    const leftY = left.getCenterExtrapolated(centerX);
    const rightY = right.getCenterExtrapolated(centerX);
    return Math.abs(leftY - rightY) <= tolerance;
  }

  toBoundingBox(): { x: number; y: number; w: number; h: number } {
    return {
      x: Math.floor(this.topLeft[0]),
      y: Math.floor(this.topLeft[1]),
      w: Math.ceil(this.bottomRight[0]) - Math.floor(this.topLeft[0]),
      h: Math.ceil(this.bottomRight[1]) - Math.floor(this.topLeft[1]),
    };
  }

  /** Split the box in two along its long axis (for wide staff fragments). */
  splitBox(): [RotatedBoundingBox, RotatedBoundingBox] {
    const { cx, cy, w, h, angle } = this.rect;
    const rad = (angle * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    if (w >= h) {
      const q = w / 4;
      const mk = (s: number): RotatedBoundingBox =>
        new RotatedBoundingBox(
          { cx: cx + s * q * dx, cy: cy + s * q * dy, w: w / 2, h, angle },
          this.points,
          this.debugId,
        );
      return [mk(-1), mk(1)];
    }
    const q = h / 4;
    const mk = (s: number): RotatedBoundingBox =>
      new RotatedBoundingBox(
        { cx: cx + s * q * dx, cy: cy + s * q * dy, w, h: h / 2, angle },
        this.points,
        this.debugId,
      );
    return [mk(-1), mk(1)];
  }
}

// ---------------------------------------------------------------------------
// BoundingEllipse (noteheads)
// ---------------------------------------------------------------------------

/** Sampled ellipse polygon, like cv2.ellipse2Poly(..., delta=1). */
export function ellipsePolygon(
  cx: number,
  cy: number,
  w: number,
  h: number,
  angleDeg: number,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  const rad = (angleDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const a = w / 2;
  const b = h / 2;
  const steps = 36;
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const x = a * Math.cos(t);
    const y = b * Math.sin(t);
    pts.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return pts;
}

export class BoundingEllipse {
  readonly rect: RotatedRect;
  readonly polygon: Array<[number, number]>;
  readonly points: Array<[number, number]>;
  readonly debugId: number;
  readonly topLeft: [number, number];
  readonly bottomLeft: [number, number];
  readonly topRight: [number, number];
  readonly bottomRight: [number, number];

  constructor(rect: RotatedRect, points: Array<[number, number]> = [], debugId = 0) {
    let { cx, cy, w, h, angle } = rect;
    if (angle > 135) {
      angle -= 180;
    } else if (angle < -135) {
      angle += 180;
    } else if (angle > 45) {
      angle = angle - 90;
      [w, h] = [h, w];
    } else if (angle < -45) {
      angle = angle + 90;
      [w, h] = [h, w];
    }
    this.rect = { cx, cy, w, h, angle };
    this.polygon = ellipsePolygon(cx, cy, w, h, angle);
    this.points = points;
    this.debugId = debugId;
    const e = extentCorners(this.rect);
    this.topLeft = e.topLeft;
    this.bottomLeft = e.bottomLeft;
    this.topRight = e.topRight;
    this.bottomRight = e.bottomRight;
  }

  get center(): [number, number] {
    return [this.rect.cx, this.rect.cy];
  }

  get size(): [number, number] {
    return [this.rect.w, this.rect.h];
  }

  isOverlapping(other: AnyBox): boolean {
    if (!canShapesPossiblyTouch(this, other)) return false;
    return doPolygonsOverlap(this.polygon, other.polygon);
  }

  isOverlappingWithAny(others: AnyBox[]): boolean {
    for (const o of others) if (this.isOverlapping(o)) return true;
    return false;
  }

  makeBoxThicker(thickness: number): BoundingEllipse {
    const r = this.rect;
    return new BoundingEllipse(
      { cx: r.cx, cy: r.cy, w: r.w + thickness, h: r.h + thickness, angle: r.angle },
      this.points,
      this.debugId,
    );
  }

  makeBoxTaller(thickness: number): RotatedBoundingBox {
    const r = this.rect;
    return new RotatedBoundingBox(
      { cx: r.cx, cy: r.cy, w: r.w, h: r.h + thickness, angle: r.angle },
      this.points,
      this.debugId,
    );
  }
}

// ---------------------------------------------------------------------------
// Creators
// ---------------------------------------------------------------------------

export interface RotatedBoxOptions {
  skipMerging?: boolean;
  minSize?: [number, number];
  maxSize?: [number, number];
  thickenBoxes?: number;
}

function hasBoxValidSize(r: RotatedRect): boolean {
  return !Number.isNaN(r.w) && !Number.isNaN(r.h) && r.w > 0 && r.h > 0;
}

function passesSizeFilter(w: number, h: number, minSize?: [number, number], maxSize?: [number, number]): boolean {
  if (minSize && (w < minSize[0] || h < minSize[1])) return false;
  // homr treats a non-positive max_size entry as "no limit".
  if (maxSize && maxSize[0] > 0 && w > maxSize[0]) return false;
  if (maxSize && maxSize[1] > 0 && h > maxSize[1]) return false;
  return true;
}

/** Union-find merge of overlapping boxes, refit over concatenated points. */
function mergeOverlaying<T extends AnyBox>(
  boxes: T[],
  refit: (group: T[]) => T,
): T[] {
  const parent = boxes.map((_, i) => i);
  const rank = new Array<number>(boxes.length).fill(0);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] > rank[rb]) parent[rb] = ra;
    else if (rank[ra] < rank[rb]) parent[ra] = rb;
    else {
      parent[rb] = ra;
      rank[ra]++;
    }
  };
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxes[i].isOverlapping(boxes[j])) union(i, j);
    }
  }
  const groups = new Map<number, T[]>();
  for (let i = 0; i < boxes.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(boxes[i]);
  }
  return [...groups.values()].map(refit);
}

/**
 * Port of homr's create_rotated_bounding_boxes: findContours on the mask,
 * one normalised box per contour, size filters, then overlap-merge with
 * minAreaRect refit over the concatenated contour points.
 */
export function createRotatedBoundingBoxes(
  img: GrayImage,
  opts: RotatedBoxOptions = {},
): RotatedBoundingBox[] {
  const { skipMerging = false, minSize, maxSize, thickenBoxes } = opts;
  const contours = findContours(img);
  let boxes: RotatedBoundingBox[] = [];
  for (let i = 0; i < contours.length; i++) {
    const pts = contourPoints(contours[i]);
    const fit = minAreaRect(pts);
    if (!hasBoxValidSize(fit)) continue;
    const box = new RotatedBoundingBox(fit, pts, i);
    if (!passesSizeFilter(box.size[0], box.size[1], minSize, maxSize)) continue;
    boxes.push(box);
  }
  if (skipMerging) return boxes;
  if (thickenBoxes !== undefined) boxes = boxes.map((b) => b.makeBoxThicker(thickenBoxes));
  return mergeOverlaying(boxes, (group) => {
    const pts: Array<[number, number]> = [];
    for (const b of group) pts.push(...b.points);
    return new RotatedBoundingBox(minAreaRect(pts), pts, group[0].debugId);
  });
}

/** Port of homr's create_rotated_bounding_box (singular, for fragments). */
export function createRotatedBoundingBox(
  points: Array<[number, number]>,
  debugId = 0,
): RotatedBoundingBox {
  return new RotatedBoundingBox(minAreaRect(points), points, debugId);
}

export interface EllipseOptions {
  skipMerging?: boolean;
  minSize?: [number, number];
  maxSize?: [number, number];
}

/**
 * Port of homr's create_bounding_ellipses: fitEllipse per contour (needs at
 * least 5 points), size filters, then the same overlap-merge — with the
 * merged group refit via minAreaRect, like the Python.
 */
export function createBoundingEllipses(img: GrayImage, opts: EllipseOptions = {}): BoundingEllipse[] {
  const { skipMerging = false, minSize, maxSize } = opts;
  const contours = findContours(img);
  let boxes: BoundingEllipse[] = [];
  for (let i = 0; i < contours.length; i++) {
    const pts = contourPoints(contours[i]);
    if (pts.length < 5) continue;
    const e = fitEllipse(pts);
    if (!hasBoxValidSize(e)) continue;
    const box = new BoundingEllipse({ cx: e.cx, cy: e.cy, w: e.w, h: e.h, angle: e.angle }, pts, i);
    if (!passesSizeFilter(box.size[0], box.size[1], minSize, maxSize)) continue;
    boxes.push(box);
  }
  if (skipMerging) return boxes;
  return mergeOverlaying(boxes, (group) => {
    const pts: Array<[number, number]> = [];
    for (const b of group) pts.push(...b.points);
    const r = minAreaRect(pts);
    return new BoundingEllipse(r, pts, group[0].debugId);
  });
}

/**
 * x-tolerance lookup for StaffLineSegment.get_at
 * (homr/constants.py: staff_line_segment_x_tolerance = 10).
 */
export const STAFF_LINE_SEGMENT_X_TOL = STAFF_LINE_SEGMENT_X_TOLERANCE;
