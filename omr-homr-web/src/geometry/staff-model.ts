/**
 * Staff geometry model: TypeScript port of homr's model.py (StaffPoint,
 * Staff, MultiStaff, Note, SymbolOnStaff, StemDirection), staff_regions.py
 * (StaffRegions) and the constants used by staff detection.
 */

import type { BoundingEllipse, RotatedBoundingBox } from "./boxes.ts";

// ---------------------------------------------------------------------------
// Constants (homr/constants.py and staff_detection.py module constants)
// ---------------------------------------------------------------------------

export const STAFF_LINE_COUNT = 5;
/** x-distance tolerance for staff grid lookups (homr staff_position_tolerance). */
export const STAFF_POSITION_TOLERANCE = 50;
/** x-distance tolerance when asking a StaffLineSegment for a fragment at x. */
export const STAFF_LINE_SEGMENT_X_TOLERANCE = 10;
/** Max parallel-angle deviation for staff line fragments (degrees). */
export const MAX_ANGLE_FOR_LINES_TO_BE_PARALLEL = 10;
/** Ledger-line tolerance for Staff.isOnStaffZone, in unit sizes. */
export const MAX_NUMBER_OF_LEDGER_LINES = 4;
/** Ledger lines used for the StaffAnchor search zone. */
export const ANCHOR_LEDGER_LINES = 5;
/** Minimum connections to merge two staffs into a combined staff. */
export const MINIMUM_CONNECTIONS_TO_FORM_COMBINED_STAFF = 1;
/** Threshold below which a connected line counts as "short". */
export function isShortConnectedLine(unitSize: number): number {
  return 2 * unitSize;
}
/** Notehead width/height ratio used when splitting clumped noteheads. */
export const NOTEHEAD_SIZE_RATIO = 1.285714;
/** Grand-staff brace scoring factors. */
export const GRANDSTAFF_X_DISTANCE_THRESHOLD_FACTOR = 5;
export const GRANDSTAFF_Y_OVERLAP_THRESHOLD_FACTOR = 0.5;
/** Transformer canvas size (width x height). */
export const TR_OMR_MAX_WIDTH = 1280;
export const TR_OMR_MAX_HEIGHT = 256;

// ---------------------------------------------------------------------------
// Symbols on a staff
// ---------------------------------------------------------------------------

export enum StemDirection {
  UP = 1,
  DOWN = 2,
}

/** Base class for symbols placed on a staff (homr's SymbolOnStaff). */
export abstract class SymbolOnStaff {
  constructor(public center: [number, number]) {}

  transformCoordinates(fn: (p: [number, number]) => [number, number]): this {
    const copy = this.copy();
    copy.center = fn(this.center);
    return copy;
  }

  protected abstract copy(): this;
}

/** A detected notehead with its staff position, stem and stem direction. */
export class Note extends SymbolOnStaff {
  hasDot = false;
  circleOfFifth = 0;
  beams: RotatedBoundingBox[] = [];
  flags: RotatedBoundingBox[] = [];

  constructor(
    public box: BoundingEllipse,
    public position: number,
    public stem: RotatedBoundingBox | null,
    public stemDirection: StemDirection | null,
  ) {
    super([box.rect.cx, box.rect.cy]);
  }

  protected copy(): this {
    const note = new Note(this.box, this.position, this.stem, this.stemDirection);
    note.hasDot = this.hasDot;
    note.circleOfFifth = this.circleOfFifth;
    note.center = [...this.center] as [number, number];
    return note as this;
  }
}

// ---------------------------------------------------------------------------
// StaffPoint / Staff
// ---------------------------------------------------------------------------

/**
 * One sampled vertical slice of a staff: x plus the y positions of the
 * staff lines at that x (ascending: y[0] is the TOP line) and the local
 * staff angle in degrees.
 */
export class StaffPoint {
  readonly averageUnitSize: number;

  constructor(
    readonly x: number,
    readonly y: number[],
    readonly angle: number,
  ) {
    if (y.length % STAFF_LINE_COUNT !== 0) {
      throw new Error("A staff must consist of 5, 10, ... lines");
    }
    let sum = 0;
    for (let i = 1; i < y.length; i++) sum += y[i] - y[i - 1];
    this.averageUnitSize = y.length > 1 ? sum / (y.length - 1) : 0;
  }

  merge(other: StaffPoint): StaffPoint {
    if (Math.abs(this.x - other.x) > 1e-3) {
      throw new Error("Can't merge points at different positions");
    }
    const y = [...this.y, ...other.y].sort((a, b) => a - b);
    return new StaffPoint(this.x, y, (this.angle + other.angle) / 2);
  }

  /**
   * Staff position of a symbol box in half-unit steps, counting from the
   * bottom line (bottom line = 1, space above = 2, ...).
   */
  findPositionInUnitSizes(box: { rect: { cx: number; cy: number } }): number {
    const cy = box.rect.cy;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.y.length; i++) {
      const d = Math.abs(this.y[i] - cy);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    const distance = this.y[best] - cy;
    const distanceInUnitSizes = Math.round((2 * distance) / this.averageUnitSize);
    return 2 * (this.y.length - best) + distanceInUnitSizes - 1;
  }

  transformCoordinates(fn: (p: [number, number]) => [number, number]): StaffPoint {
    const xy = this.y.map((yValue) => fn([this.x, yValue]));
    const averageX = xy.reduce((s, p) => s + p[0], 0) / xy.length;
    return new StaffPoint(averageX, xy.map((p) => p[1]), this.angle);
  }

  /** Zero-width vertical box spanning the staff lines (homr's to_bounding_box). */
  toBoundingBox(): { x: number; y: number; w: number; h: number } {
    return {
      x: Math.trunc(this.x),
      y: Math.trunc(this.y[0]),
      w: 1,
      h: Math.ceil(this.y[this.y.length - 1] - this.y[0]),
    };
  }
}

/** A detected staff: resampled grid of StaffPoints plus note symbols. */
export class Staff {
  symbols: SymbolOnStaff[] = [];
  isGrandstaff = false;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly averageUnitSize: number;
  private readonly yTolerance: number;

  constructor(public grid: StaffPoint[]) {
    this.minX = grid[0].x;
    this.maxX = grid[grid.length - 1].x;
    let minY = Infinity;
    let maxY = -Infinity;
    const unitSizes: number[] = [];
    for (const p of grid) {
      for (const y of p.y) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      unitSizes.push(p.averageUnitSize);
    }
    this.minY = minY;
    this.maxY = maxY;
    unitSizes.sort((a, b) => a - b);
    const mid = Math.floor(unitSizes.length / 2);
    this.averageUnitSize =
      unitSizes.length % 2 === 1
        ? unitSizes[mid]
        : (unitSizes[mid - 1] + unitSizes[mid]) / 2;
    this.yTolerance = MAX_NUMBER_OF_LEDGER_LINES * this.averageUnitSize;
  }

  addSymbol(symbol: SymbolOnStaff): void {
    this.symbols.push(symbol);
  }

  getNotes(): Note[] {
    return this.symbols.filter((s): s is Note => s instanceof Note);
  }

  getAt(x: number): StaffPoint | null {
    let closest: StaffPoint | null = null;
    let closestDist = Infinity;
    for (const p of this.grid) {
      const d = Math.abs(p.x - x);
      if (d < closestDist) {
        closestDist = d;
        closest = p;
      }
    }
    if (closest === null || Math.abs(closest.x - x) > STAFF_POSITION_TOLERANCE) return null;
    return closest;
  }

  /** Vertical distance from a point to the nearest staff line. */
  yDistanceTo(point: [number, number]): number {
    const staffPoint = this.getAt(point[0]);
    if (staffPoint === null) return 1e10;
    let best = Infinity;
    for (const y of staffPoint.y) best = Math.min(best, Math.abs(y - point[1]));
    return best;
  }

  /** Whether a symbol box centre lies within the staff zone (incl. ledger lines). */
  isOnStaffZone(box: { rect: { cx: number; cy: number } }): boolean {
    const point = this.getAt(box.rect.cx);
    if (point === null) return false;
    if (box.rect.cy > point.y[point.y.length - 1] + this.yTolerance) return false;
    if (box.rect.cy < point.y[0] - this.yTolerance) return false;
    return true;
  }

  /** Merges two staffs of a grand staff into one 10-line staff. */
  merge(other: Staff): Staff {
    const gridA = new Map<number, StaffPoint>();
    for (const p of this.grid) gridA.set(Math.round(p.x), p);
    const gridB = new Map<number, StaffPoint>();
    for (const p of other.grid) gridB.set(Math.round(p.x), p);
    const xs = [...gridA.keys()].filter((x) => gridB.has(x)).sort((a, b) => a - b);
    const grid = xs.map((x) => gridA.get(x)!.merge(gridB.get(x)!));
    const result = new Staff(grid);
    result.symbols = [...this.symbols, ...other.symbols];
    result.isGrandstaff = true;
    return result;
  }

  extendToXRange(minX: number, maxX: number): Staff {
    const grid = [...this.grid];
    if (minX >= 0 && minX < grid[0].x) {
      grid.unshift(new StaffPoint(minX, [...grid[0].y], grid[0].angle));
    }
    if (maxX >= 0 && maxX > grid[grid.length - 1].x) {
      const last = grid[grid.length - 1];
      grid.push(new StaffPoint(maxX, [...last.y], last.angle));
    }
    return new Staff(grid);
  }

  transformCoordinates(fn: (p: [number, number]) => [number, number]): Staff {
    const copy = new Staff(this.grid.map((p) => p.transformCoordinates(fn)));
    copy.symbols = this.symbols.map((s) => s.transformCoordinates(fn));
    copy.isGrandstaff = this.isGrandstaff;
    return copy;
  }
}

/** A grand staff or a staff with multiple voices. */
export class MultiStaff {
  readonly staffs: Staff[];

  constructor(
    staffs: Staff[],
    public connections: RotatedBoundingBox[] = [],
  ) {
    this.staffs = [...staffs].sort((a, b) => a.minY - b.minY);
  }

  get minY(): number {
    return Math.min(...this.staffs.map((s) => s.minY));
  }

  get maxY(): number {
    return Math.max(...this.staffs.map((s) => s.maxY));
  }

  get averageUnitSize(): number {
    return this.staffs.length > 0 ? this.staffs[0].averageUnitSize : 0;
  }

  merge(other: MultiStaff): MultiStaff {
    const staffs: Staff[] = [];
    for (const s of [...this.staffs, ...other.staffs]) {
      if (!staffs.includes(s)) staffs.push(s);
    }
    const connections: RotatedBoundingBox[] = [];
    for (const c of [...this.connections, ...other.connections]) {
      if (!connections.includes(c)) connections.push(c);
    }
    return new MultiStaff(staffs, connections);
  }

  breakApart(): MultiStaff[] {
    return this.staffs.map((s) => new MultiStaff([s], []));
  }

  // -- grand-staff grouping (homr model.py: _score_brace_with_staff_pair,
  // _select_grandstaffs, _merge_selected_pairs, create_grandstaffs) --------

  private scoreBraceWithStaffPair(
    symbol: RotatedBoundingBox,
    upperStaff: Staff,
    lowerStaff: Staff,
    staffAbove: Staff | null,
    staffBelow: Staff | null,
  ): number {
    const unitSize =
      (upperStaff.averageUnitSize + lowerStaff.averageUnitSize) / 2;
    const xDistanceThreshold = GRANDSTAFF_X_DISTANCE_THRESHOLD_FACTOR * unitSize;
    const yOverlapThreshold = GRANDSTAFF_Y_OVERLAP_THRESHOLD_FACTOR * symbol.rect.h;

    const symbolMinY = symbol.rect.cy - symbol.rect.h / 2;
    const symbolMaxY = symbol.rect.cy + symbol.rect.h / 2;

    if (staffAbove !== null) {
      const midpointAbove = (staffAbove.maxY + upperStaff.minY) / 2;
      if (symbolMinY < midpointAbove) return 0;
    }
    if (staffBelow !== null) {
      const midpointBelow = (lowerStaff.maxY + staffBelow.minY) / 2;
      if (symbolMaxY > midpointBelow) return 0;
    }

    const symbolMinX = symbol.rect.cx;
    const xDistance = Math.min(
      Math.abs(upperStaff.minX - symbolMinX),
      Math.abs(lowerStaff.minX - symbolMinX),
    );

    const yOverlap =
      Math.min(symbolMaxY, lowerStaff.maxY) - Math.max(symbolMinY, upperStaff.minY);

    if (!(xDistance < xDistanceThreshold && yOverlap > yOverlapThreshold && yOverlap > xDistance)) {
      return 0;
    }

    const union =
      Math.max(symbolMaxY, lowerStaff.maxY) - Math.min(symbolMinY, upperStaff.minY);
    const iou = union > 0 ? yOverlap / union : 0;
    return iou - xDistance / xDistanceThreshold;
  }

  private selectGrandstaffs(braceDots: RotatedBoundingBox[]): Array<{ pair: [number, number]; score: number }> {
    const pairScores: Array<{ pair: [number, number]; score: number }> = [];
    for (let i = 0; i < this.staffs.length - 1; i++) {
      const staffAbove = i > 0 ? this.staffs[i - 1] : null;
      const staffBelow = i + 2 < this.staffs.length ? this.staffs[i + 2] : null;
      let bestScore = 0;
      for (const symbol of braceDots) {
        const score = this.scoreBraceWithStaffPair(
          symbol,
          this.staffs[i],
          this.staffs[i + 1],
          staffAbove,
          staffBelow,
        );
        if (score > bestScore) bestScore = score;
      }
      if (bestScore > 0) pairScores.push({ pair: [i, i + 1], score: bestScore });
    }
    pairScores.sort((a, b) => b.score - a.score);
    const result: Array<{ pair: [number, number]; score: number }> = [];
    const used = new Set<number>();
    for (const p of pairScores) {
      if (used.has(p.pair[0]) || used.has(p.pair[1])) continue;
      result.push(p);
      used.add(p.pair[0]);
      used.add(p.pair[1]);
    }
    return result;
  }

  private mergeSelectedPairs(pairs: Array<{ pair: [number, number]; score: number }>): Staff[] {
    const result: Staff[] = [];
    let i = 0;
    while (i < this.staffs.length) {
      if (pairs.some((p) => p.pair[0] === i)) {
        result.push(this.staffs[i].merge(this.staffs[i + 1]));
        i += 2;
        continue;
      }
      result.push(this.staffs[i]);
      i += 1;
    }
    return result;
  }

  /** Groups adjacent staff pairs joined by a brace/bracket into grand staffs. */
  createGrandstaffs(braceDots: RotatedBoundingBox[]): MultiStaff {
    if (this.staffs.length < 2) return this;
    const pairs = this.selectGrandstaffs(braceDots);
    if (pairs.length === 0) return this;
    return new MultiStaff(this.mergeSelectedPairs(pairs), this.connections);
  }
}

// ---------------------------------------------------------------------------
// StaffRegions (homr/staff_regions.py)
// ---------------------------------------------------------------------------

/**
 * Vertical regions owned by each staff, used to clip the dewarp crop so
 * neighbouring staffs do not bleed into each other.
 */
export class StaffRegions {
  private readonly centers: Array<[number, number]>;

  constructor(staffs: MultiStaff[]) {
    this.centers = [];
    for (const ms of staffs) {
      for (const s of ms.staffs) this.centers.push([s.minY, s.maxY]);
    }
  }

  getStartOfClosestStaffAbove(y: number): number {
    const above = this.centers.filter((c) => c[0] < y).map((c) => c[1]);
    if (above.length === 0) return 0;
    return Math.max(...above);
  }

  getStartOfClosestStaffBelow(y: number): number {
    const below = this.centers.filter((c) => c[1] > y).map((c) => c[0]);
    if (below.length === 0) return 1e12;
    return Math.min(...below);
  }
}
