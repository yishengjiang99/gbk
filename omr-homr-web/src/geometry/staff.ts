/**
 * Staff detection and symbol-detection glue: TypeScript port of homr's
 * staff_detection.py, note_detection.py, bar_line_detection.py,
 * brace_dot_detection.py, noise_filtering.py and find_peaks.py.
 *
 * The pipeline detects staff-line fragments from the SegNet staff mask,
 * finds anchors where five parallel lines cross a bar line or clef, connects
 * fragments into staff lines, resamples them into Staff grids ordered
 * top-to-bottom, and groups grand staffs via braces/brackets.
 */

import {
  BoundingEllipse,
  RotatedBoundingBox,
  createBoundingEllipses,
  createRotatedBoundingBox,
  createRotatedBoundingBoxes,
} from "./boxes.ts";
import {
  GrayImage,
  calcHist,
  crop,
  dilate,
  ellipseKernel,
  erode,
  filter2DFloat,
  findContours,
  meanGray,
  median,
  minAreaRect,
  rectKernel,
  resize,
  subtract,
  threshold,
} from "./image.ts";
import {
  ANCHOR_LEDGER_LINES,
  GRANDSTAFF_X_DISTANCE_THRESHOLD_FACTOR,
  GRANDSTAFF_Y_OVERLAP_THRESHOLD_FACTOR,
  MAX_ANGLE_FOR_LINES_TO_BE_PARALLEL,
  MAX_NUMBER_OF_LEDGER_LINES,
  MINIMUM_CONNECTIONS_TO_FORM_COMBINED_STAFF,
  NOTEHEAD_SIZE_RATIO,
  STAFF_LINE_COUNT,
  STAFF_LINE_SEGMENT_X_TOLERANCE,
  STAFF_POSITION_TOLERANCE,
  MultiStaff,
  Note,
  Staff,
  StaffPoint,
  StemDirection,
  isShortConnectedLine,
} from "./staff-model.ts";
import type { SegNetMasks } from "./segnet.ts";

/** Maximum gap when connecting staff line fragments, in unit sizes. */
function maxLineGapSize(unitSize: number): number {
  return 5 * unitSize;
}

// ---------------------------------------------------------------------------
// find_peaks (homr/find_peaks.py — scipy-free peak finder)
// ---------------------------------------------------------------------------

/**
 * Find local maxima with optional height/distance/prominence filters.
 * Direct port of homr's find_peaks (which mirrors scipy.signal.find_peaks).
 */
export function findPeaks(
  x: number[],
  opts: { height?: number; distance?: number; prominence?: number } = {},
): number[] {
  const { height, distance, prominence } = opts;
  if (x.length < 3) return [];
  const peaksList: number[] = [];
  let i = 1;
  while (i < x.length - 1) {
    if (x[i] > x[i - 1]) {
      let j = i;
      while (j < x.length - 1 && x[j] === x[j + 1]) j++;
      if (j < x.length - 1 && x[j] > x[j + 1]) {
        peaksList.push(Math.floor((i + j) / 2));
      }
      i = j + 1;
    } else if (x[i] === x[i - 1]) {
      let j = i;
      while (j < x.length - 1 && x[j] === x[j + 1]) j++;
      if (j < x.length - 1 && x[j] > x[j + 1]) {
        peaksList.push(Math.floor((i + j) / 2));
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  let peaks = peaksList;
  if (peaks.length === 0) return [];
  if (height !== undefined) peaks = peaks.filter((p) => x[p] >= height);
  if (peaks.length === 0) return [];
  if (prominence !== undefined) {
    const valid: number[] = [];
    for (const peak of peaks) {
      let leftMin = x[peak];
      for (let k = peak - 1; k >= 0; k--) {
        if (x[k] > x[peak]) break;
        leftMin = Math.min(leftMin, x[k]);
      }
      let rightMin = x[peak];
      for (let k = peak + 1; k < x.length; k++) {
        if (x[k] > x[peak]) break;
        rightMin = Math.min(rightMin, x[k]);
      }
      if (x[peak] - Math.max(leftMin, rightMin) >= prominence) valid.push(peak);
    }
    peaks = valid;
  }
  if (peaks.length === 0) return [];
  if (distance !== undefined && peaks.length > 1) {
    const sorted = [...peaks].sort((a, b) => x[b] - x[a]);
    const keep: number[] = [];
    for (const peak of sorted) {
      if (keep.length === 0 || keep.every((k) => Math.abs(k - peak) >= distance)) {
        keep.push(peak);
      }
    }
    peaks = keep.sort((a, b) => a - b);
  }
  return peaks;
}

// ---------------------------------------------------------------------------
// Noise filtering (homr/noise_filtering.py)
// ---------------------------------------------------------------------------

const NOISE_KERNEL = [
  [1, -2, 1],
  [-2, 4, -2],
  [1, -2, 1],
];

/**
 * Mean absolute convolution response. Port of homr's estimate_noise:
 * cv2.filter2D with CV_64F keeps the raw signed response (no saturation),
 * then the mean of absolute values is taken. Edge handling differs slightly
 * (zero padding here vs OpenCV's default border reflection).
 */
export function estimateNoise(image: GrayImage): number {
  const conv = filter2DFloat(image, NOISE_KERNEL);
  const d = conv.data;
  let sum = 0;
  for (let i = 0; i < d.length; i++) sum += Math.abs(d[i]);
  return sum / d.length;
}

/**
 * Noise filtering. Direct port of homr's filter_predictions: build a 20x20
 * grid of noise estimates over the staff prediction; a cell is masked out
 * when its noise exceeds the limit AND a 4-neighbor also exceeds it. The
 * resulting keep-mask is ANDed into every prediction mask. Filtering is
 * skipped when it would remove more than half the image, or nothing.
 */
export function filterPredictions(masks: SegNetMasks, noiseLimit: number): void {
  const gray = GrayImage.zeros(masks.staff.width, masks.staff.height);
  for (let i = 0; i < gray.data.length; i++) gray.data[i] = masks.staff.data[i] ? 255 : 0;
  const { width: w, height: h } = gray;
  const M = Math.floor(h / 20);
  const N = Math.floor(w / 20);
  if (M === 0 || N === 0) return;
  const rows = Math.ceil(h / M);
  const cols = Math.ceil(w / N);
  const grid: number[][] = [];
  for (let i = 0; i < rows; i++) {
    const row: number[] = [];
    for (let j = 0; j < cols; j++) {
      row.push(estimateNoise(crop(gray, j * N, i * M, N, M)));
    }
    grid.push(row);
  }
  const neighborAbove = (i: number, j: number): boolean => {
    if (i > 0 && grid[i - 1][j] > noiseLimit) return true;
    if (j > 0 && grid[i][j - 1] > noiseLimit) return true;
    if (i < rows - 1 && grid[i + 1][j] > noiseLimit) return true;
    if (j < cols - 1 && grid[i][j + 1] > noiseLimit) return true;
    return false;
  };
  const keep = new Uint8Array(w * h);
  let filteredCells = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const y1 = i * M;
      const x1 = j * N;
      if (grid[i][j] > noiseLimit && neighborAbove(i, j)) {
        filteredCells += 1;
      } else {
        const y2 = Math.min(y1 + M, h);
        const x2 = Math.min(x1 + N, w);
        for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) keep[y * w + x] = 1;
      }
    }
  }
  const totalCells = rows * cols;
  if (filteredCells / totalCells > 0.5) return;
  if (filteredCells === 0) return;
  for (const m of [masks.staff, masks.symbols, masks.stemsRest, masks.notehead, masks.clefsKeys]) {
    for (let i = 0; i < m.data.length; i++) if (!keep[i]) m.data[i] = 0;
  }
}

/** Dilate staff lines so thin predictions survive (homr's make_lines_stronger). */
export function makeLinesStronger(img: GrayImage, kernelCols: number, kernelRows: number): GrayImage {
  const dilated = dilate(img, ellipseKernel(kernelCols, kernelRows));
  return threshold(dilated, 0.1, 1);
}

// ---------------------------------------------------------------------------
// StaffLineSegment / StaffAnchor / RawStaff (staff_detection.py)
// ---------------------------------------------------------------------------

/** A connected run of staff-line fragments, left to right. */
export class StaffLineSegment {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly staffFragments: RotatedBoundingBox[];

  constructor(
    readonly debugId: number,
    staffFragments: RotatedBoundingBox[],
  ) {
    this.staffFragments = [...staffFragments].sort((a, b) => a.rect.cx - b.rect.cx);
    this.minX = Math.min(...staffFragments.map((l) => l.rect.cx - l.rect.w / 2));
    this.maxX = Math.max(...staffFragments.map((l) => l.rect.cx + l.rect.w / 2));
    this.minY = Math.min(...staffFragments.map((l) => l.rect.cy - l.rect.h / 2));
    this.maxY = Math.max(...staffFragments.map((l) => l.rect.cy + l.rect.h / 2));
  }

  merge(other: StaffLineSegment): StaffLineSegment {
    const fragments = [...this.staffFragments];
    for (const f of other.staffFragments) {
      if (!fragments.includes(f)) fragments.push(f);
    }
    return new StaffLineSegment(this.debugId, fragments);
  }

  getAt(x: number): RotatedBoundingBox | null {
    const tol = STAFF_LINE_SEGMENT_X_TOLERANCE;
    for (const f of this.staffFragments) {
      if (x >= f.rect.cx - f.rect.w / 2 - tol && x <= f.rect.cx + f.rect.w / 2 + tol) {
        return f;
      }
    }
    return null;
  }

  isOverlapping(other: StaffLineSegment): boolean {
    for (const a of this.staffFragments) {
      for (const b of other.staffFragments) {
        if (a.isOverlapping(b)) return true;
      }
    }
    return false;
  }
}

/**
 * Five parallel staff lines crossing a bar line or clef — a reliable
 * landmark used to grow the full staff.
 */
export class StaffAnchor {
  readonly unitSizes: number[];
  readonly averageUnitSize: number;
  readonly minY: number;
  readonly maxY: number;
  /** y range of the five lines at the symbol. */
  readonly yRange: { start: number; stop: number };
  /** Search zone for fragments belonging to this staff (incl. ledger lines). */
  readonly zone: { start: number; stop: number };

  constructor(
    readonly staffLines: StaffLineSegment[],
    readonly symbol: RotatedBoundingBox,
  ) {
    const yPositions = staffLines
      .map((line) => line.staffFragments[0].getCenterExtrapolated(symbol.rect.cx))
      .sort((a, b) => a - b);
    const deltas: number[] = [];
    for (let i = 1; i < yPositions.length; i++) deltas.push(Math.abs(yPositions[i] - yPositions[i - 1]));
    this.unitSizes = deltas;
    this.averageUnitSize = deltas.length === 0 ? 0 : deltas.reduce((s, v) => s + v, 0) / deltas.length;
    this.minY = Math.min(...staffLines.map((l) => l.minY));
    this.maxY = Math.max(...staffLines.map((l) => l.maxY));
    this.yRange = { start: Math.trunc(Math.min(...yPositions)), stop: Math.trunc(Math.max(...yPositions)) };
    this.zone = {
      start: Math.trunc(this.minY - ANCHOR_LEDGER_LINES * this.averageUnitSize),
      stop: Math.trunc(this.maxY + ANCHOR_LEDGER_LINES * this.averageUnitSize),
    };
  }
}

/** A staff assembled from line fragments, before resampling. */
export class RawStaff extends RotatedBoundingBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;

  constructor(
    readonly staffId: number,
    readonly lines: StaffLineSegment[],
    readonly anchors: StaffAnchor[],
    debugId?: number,
  ) {
    const pts: Array<[number, number]> = [];
    for (const line of lines) {
      for (const f of line.staffFragments) pts.push(...f.points);
    }
    super(minAreaRect(pts), [], debugId ?? staffId);
    this.minX = this.rect.cx - this.rect.w / 2;
    this.maxX = this.rect.cx + this.rect.w / 2;
    this.minY = this.rect.cy - this.rect.h / 2;
    this.maxY = this.rect.cy + this.rect.h / 2;
  }

  merge(other: RawStaff): RawStaff {
    const lines = this.lines.map((line, i) => other.lines[i].merge(line));
    return new RawStaff(this.staffId, lines, [...this.anchors, ...other.anchors]);
  }
}

// ---------------------------------------------------------------------------
// Fragment connection (staff_detection.py)
// ---------------------------------------------------------------------------

/**
 * Sweep-line connection of staff fragments into line segments. Direct port
 * of homr's connect_staff_lines: fragments are consumed left to right and
 * each is appended to the active line whose extrapolated end meets it.
 */
export function connectStaffLines(
  staffLines: RotatedBoundingBox[],
  unitSize: number,
): StaffLineSegment[] {
  const sortedByRightToLeft = [...staffLines].sort((a, b) => b.bottomLeft[0] - a.bottomLeft[0]);
  const result: RotatedBoundingBox[][] = [];
  let activeLinesToCheck: RotatedBoundingBox[][] = [];
  let lastCleanupAtX = 0;
  while (sortedByRightToLeft.length > 0) {
    const current = sortedByRightToLeft.pop()!;
    const x = current.bottomLeft[0];
    if (x - lastCleanupAtX > maxLineGapSize(unitSize)) {
      activeLinesToCheck = activeLinesToCheck.filter(
        (item) => x - item[item.length - 1].bottomRight[0] < maxLineGapSize(unitSize),
      );
      lastCleanupAtX = x;
    }
    const isShortLine = current.rect.w < unitSize / 5;
    if (isShortLine) continue;
    let connected = false;
    for (const activeLine of activeLinesToCheck) {
      if (activeLine[activeLine.length - 1].isOverlappingExtrapolated(current, unitSize)) {
        activeLine.push(current);
        connected = true;
      }
    }
    if (!connected) {
      const fresh = [current];
      result.push(fresh);
      activeLinesToCheck.push(fresh);
    }
  }
  const resultTopToBottom = [...result].sort((a, b) => a[0].rect.cy - b[0].rect.cy);
  return resultTopToBottom.map((lines, i) => new StaffLineSegment(i, lines));
}

/** y of a staff line at x via its fragment (or the first fragment). */
function extrapolatedLineY(line: StaffLineSegment, x: number): number {
  const fragment = line.getAt(x) ?? line.staffFragments[0];
  return fragment.getCenterExtrapolated(x);
}

/**
 * Two staff lines cross if their relative vertical order flips somewhere
 * across their shared x-range.
 */
export function areLinesCrossing(lines: StaffLineSegment[]): boolean {
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const overlapStart = Math.max(lines[i].minX, lines[j].minX);
      const overlapStop = Math.min(lines[i].maxX, lines[j].maxX);
      if (overlapStart >= overlapStop) continue;
      const deltaStart = extrapolatedLineY(lines[i], overlapStart) - extrapolatedLineY(lines[j], overlapStart);
      const deltaStop = extrapolatedLineY(lines[i], overlapStop) - extrapolatedLineY(lines[j], overlapStop);
      if (deltaStart === 0 || deltaStop === 0 || deltaStart > 0 !== deltaStop > 0) {
        return true;
      }
    }
  }
  return false;
}

/** All fragments' angles agree within the parallel tolerance. */
export function areLinesParallel(lines: StaffLineSegment[], unitSize: number): boolean {
  const allAngles: number[] = [];
  const allFragments: RotatedBoundingBox[] = [];
  for (const line of lines) {
    for (const fragment of line.staffFragments) {
      allAngles.push(fragment.rect.angle);
      allFragments.push(fragment);
    }
  }
  if (allAngles.length === 0) return false;
  const averageAngle = allAngles.reduce((s, v) => s + v, 0) / allAngles.length;
  for (const fragment of allFragments) {
    if (
      Math.abs(fragment.rect.angle - averageAngle) > MAX_ANGLE_FOR_LINES_TO_BE_PARALLEL &&
      fragment.rect.w > isShortConnectedLine(unitSize)
    ) {
      return false;
    }
  }
  return true;
}

/** A bar line should begin or end on one of the staff lines. */
export function beginsOrEndsOnOneStaffLine(
  line: RotatedBoundingBox,
  staffLines: StaffLineSegment[],
  unitSize: number,
): boolean {
  for (const staffLine of staffLines) {
    const fragment = staffLine.getAt(line.rect.cx);
    if (fragment === null) continue;
    const staffY = fragment.getCenterExtrapolated(line.rect.cx);
    if (Math.abs(staffY - line.rect.cy) < unitSize) return true;
  }
  return false;
}

/**
 * Finds anchors: five parallel non-crossing staff lines crossing a clef or
 * bar-line-like symbol. Direct port of find_staff_anchors.
 */
export function findStaffAnchors(
  staffLines: RotatedBoundingBox[],
  anchorSymbols: RotatedBoundingBox[],
  areClefs = false,
): StaffAnchor[] {
  const result: StaffAnchor[] = [];
  for (const centerSymbol of anchorSymbols) {
    // The symbol disconnects the staff lines at its centre, so try the
    // lines at the left and right side of the symbol as well.
    const adjacent = areClefs
      ? [
          centerSymbol.moveToXHorizontalBy(-10),
          centerSymbol,
          centerSymbol.moveToXHorizontalBy(10),
          centerSymbol.moveToXHorizontalBy(30),
          centerSymbol.moveToXHorizontalBy(60),
          centerSymbol.moveToXHorizontalBy(80),
        ]
      : [
          centerSymbol.moveToXHorizontalBy(-10),
          centerSymbol.moveToXHorizontalBy(-5),
          centerSymbol,
          centerSymbol.moveToXHorizontalBy(5),
          centerSymbol.moveToXHorizontalBy(10),
        ];
    for (const symbol of adjacent) {
      const estimatedUnitSize = Math.round(symbol.rect.h / (STAFF_LINE_COUNT - 1));
      const thickenedBarLine = symbol.makeBoxTaller(estimatedUnitSize);
      const overlappingStaffLines = staffLines.filter((line) =>
        line.isIntersecting(thickenedBarLine),
      );
      let connectedLines = connectStaffLines(overlappingStaffLines, estimatedUnitSize);
      if (connectedLines.length > STAFF_LINE_COUNT) {
        connectedLines = connectedLines.filter(
          (line) => line.maxX - line.minX > isShortConnectedLine(estimatedUnitSize),
        );
      }
      if (connectedLines.length !== STAFF_LINE_COUNT) continue;
      if (!areLinesParallel(connectedLines, estimatedUnitSize)) continue;
      if (areLinesCrossing(connectedLines)) continue;
      if (
        !areClefs &&
        !beginsOrEndsOnOneStaffLine(symbol, connectedLines, estimatedUnitSize)
      ) {
        continue;
      }
      result.push(new StaffAnchor(connectedLines, symbol));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Raw staff assembly and resampling (staff_detection.py)
// ---------------------------------------------------------------------------

/** Finds the already-built raw staff containing this anchor's fragments. */
export function getStaffForAnchor(anchor: StaffAnchor, staffs: RawStaff[]): RawStaff | null {
  for (const staff of staffs) {
    for (let i = 0; i < anchor.staffLines.length; i++) {
      const anchorLine = anchor.staffLines[i];
      const staffFragments = staff.lines[i].staffFragments;
      if (anchorLine.staffFragments.every((f) => staffFragments.includes(f))) {
        return staff;
      }
    }
  }
  return null;
}

/**
 * Builds raw staffs: for each anchor, connects the fragments inside its
 * zone, then upgrades the anchor's own lines to the connected versions.
 */
export function findRawStaffsByConnectingLineFragments(
  anchors: StaffAnchor[],
  staffFragments: RotatedBoundingBox[],
): RawStaff[] {
  const staffs: RawStaff[] = [];
  let staffId = 0;
  for (const anchor of anchors) {
    const existingStaff = getStaffForAnchor(anchor, staffs);
    const fragments = staffFragments.filter(
      (fragment) =>
        fragment.rect.cy >= anchor.zone.start && fragment.rect.cy <= anchor.zone.stop,
    );
    const connected = connectStaffLines(fragments, anchor.averageUnitSize);
    const staffLines: StaffLineSegment[] = [];
    for (const anchorLine of anchor.staffLines) {
      const requirement = new Set(anchorLine.staffFragments);
      const matching = connected.filter((line) =>
        [...requirement].every((f) => line.staffFragments.includes(f)),
      );
      if (matching.length === 1) {
        staffLines.push(matching[0]);
      } else {
        staffLines.push(anchorLine);
      }
    }
    const raw = new RawStaff(staffId, staffLines, [anchor]);
    if (existingStaff) {
      staffs.splice(staffs.indexOf(existingStaff), 1);
      staffs.push(existingStaff.merge(raw));
    } else {
      staffs.push(raw);
    }
    staffId++;
  }
  return staffs;
}

/**
 * Removes duplicate staffs built from the same anchors: the staff with the
 * most anchors wins.
 */
export function removeDuplicateStaffs(staffs: RawStaff[]): RawStaff[] {
  let result: RawStaff[] = [];
  for (const staff of staffs) {
    const overlapping = result.filter((other) => staff.isOverlapping(other));
    if (overlapping.length === 0) {
      result.push(staff);
      continue;
    }
    if (overlapping.length >= 2) {
      continue;
    }
    if (overlapping[0].anchors.length < staff.anchors.length) {
      result = result.filter((s) => s !== overlapping[0]);
      result.push(staff);
    }
  }
  return result;
}

/**
 * Resamples one anchor's neighbourhood: walks x positions left/right of the
 * anchor, reads each staff line's extrapolated y, repairs gaps from the
 * unit size and yields one StaffPoint per x.
 */
export function* resampleStaffSegment(
  anchor: StaffAnchor,
  staff: RawStaff,
  axisRange: number[],
): Generator<StaffPoint> {
  const x0 = anchor.symbol.rect.cx;
  const lineFragments = anchor.staffLines.map((line) => line.staffFragments[0]);
  const centers = lineFragments.map((line) => line.getCenterExtrapolated(x0));
  const meanAngle =
    lineFragments.reduce((s, l) => s + l.rect.angle, 0) / lineFragments.length;
  let previousPoint = new StaffPoint(x0, centers, meanAngle);
  for (const x of axisRange) {
    const lines = staff.lines.map((line) => line.getAt(x));
    const axisCenter: Array<number | null> = lines.map((line) =>
      line === null ? null : line.getCenterExtrapolated(x),
    );
    const centerValues = axisCenter.filter((c): c is number => c !== null);
    if (centerValues.length === 0) continue;
    const deltas: number[] = [];
    for (let i = 1; i < centerValues.length; i++) deltas.push(centerValues[i] - centerValues[i - 1]);
    for (let i = 0; i < deltas.length; i++) {
      if (deltas[i] < 0.5 * anchor.averageUnitSize) {
        axisCenter[i] = null;
        axisCenter[i + 1] = null;
      }
    }
    for (let i = 0; i < previousPoint.y.length; i++) {
      const centerValue = axisCenter[i];
      if (centerValue !== null && Math.abs(centerValue - previousPoint.y[i]) > 0.5 * anchor.averageUnitSize) {
        axisCenter[i] = null;
      }
    }
    let prevCenter = -1;
    const order = [...Array(axisCenter.length).keys(), ...[...Array(axisCenter.length).keys()].reverse()];
    for (const i of order) {
      if (axisCenter[i] !== null) {
        prevCenter = i;
      } else if (prevCenter >= 0) {
        const centerValue = axisCenter[prevCenter];
        if (centerValue !== null) {
          axisCenter[i] = centerValue + anchor.averageUnitSize * (i - prevCenter);
        }
      }
    }
    if (axisCenter.some((c) => c === null)) continue;
    const nonNullLines = lines.filter((l): l is RotatedBoundingBox => l !== null);
    const angle = nonNullLines.reduce((s, l) => s + l.rect.angle, 0) / nonNullLines.length;
    previousPoint = new StaffPoint(
      x,
      (axisCenter as number[]).slice(),
      angle,
    );
    yield previousPoint;
  }
}

/** Resamples a raw staff onto a 10px grid between its anchors. */
export function resampleStaff(staff: RawStaff): Staff {
  const anchorsLeftToRight = [...staff.anchors].sort(
    (a, b) => a.symbol.rect.cx - b.symbol.rect.cx,
  );
  const density = 10;
  const roundToDensity = (x: number): number => Math.round(x / density) * density;
  const start = Math.floor(staff.minX / density) * density;
  const stop = (Math.floor(staff.maxX / density) + 1) * density;
  const grid: StaffPoint[] = [];
  let x = start;
  for (let i = 0; i < anchorsLeftToRight.length; i++) {
    const anchor = anchorsLeftToRight[i];
    const toLeft: number[] = [];
    for (let v = roundToDensity(x); v < roundToDensity(anchor.symbol.rect.cx); v += density) {
      toLeft.push(v);
    }
    let toRight: number[];
    if (i < anchorsLeftToRight.length - 1) {
      toRight = [];
      const stopX = Math.trunc((anchor.symbol.rect.cx + anchorsLeftToRight[i + 1].symbol.rect.cx) / 2);
      for (let v = Math.trunc(anchor.symbol.rect.cx); v < stopX; v += density) toRight.push(v);
    } else {
      toRight = [];
      for (let v = roundToDensity(anchor.symbol.rect.cx); v < roundToDensity(stop); v += density) {
        toRight.push(v);
      }
    }
    x = toRight.length > 0 ? toRight[toRight.length - 1] + density : x;
    const leftPoints = [...resampleStaffSegment(anchor, staff, [...toLeft].reverse())].reverse();
    grid.push(...leftPoints);
    grid.push(...resampleStaffSegment(anchor, staff, toRight));
  }
  return new Staff(grid);
}

/** Resamples every raw staff. */
export function resampleStaffs(staffs: RawStaff[]): Staff[] {
  return staffs.map((staff) => resampleStaff(staff));
}

/** Drops staffs outside the page or much narrower than usual at an edge. */
export function filterEdgeOfVision(staffs: Staff[], imageWidth: number, imageHeight: number): Staff[] {
  const usualWidth =
    staffs.reduce((s, staff) => s + (staff.maxX - staff.minX), 0) / Math.max(1, staffs.length);
  const result: Staff[] = [];
  for (const staff of staffs) {
    if (staff.maxY >= imageHeight || staff.minY < 0) continue;
    const staffWidth = staff.maxX - staff.minX;
    const shorterThanUsual = staffWidth < usualWidth / 2;
    const beyondLeft = staff.minX < 0.01 * imageWidth;
    const beyondRight = staff.maxX > 0.99 * imageWidth;
    if ((beyondLeft || beyondRight) && shorterThanUsual) continue;
    result.push(staff);
  }
  return result;
}

/** Top-to-bottom staff order. */
export function sortStaffsTopToBottom(staffs: Staff[]): Staff[] {
  return [...staffs].sort((a, b) => a.minY - b.minY);
}

/** Drops anchors whose unit size deviates more than 3 sigma from the mean. */
export function filterUnusualAnchors(anchors: StaffAnchor[]): StaffAnchor[] {
  if (anchors.length === 0) return anchors;
  const unitSizes = anchors.map((a) => a.averageUnitSize);
  const mean = unitSizes.reduce((s, v) => s + v, 0) / unitSizes.length;
  const variance = unitSizes.reduce((s, v) => s + (v - mean) ** 2, 0) / unitSizes.length;
  const std = Math.sqrt(variance);
  return anchors.filter((a) => Math.abs(a.averageUnitSize - mean) <= 3 * std);
}

// ---------------------------------------------------------------------------
// Anchor prediction from clefs (staff_detection.py)
// ---------------------------------------------------------------------------

/** x-ranges right of each clef anchor, merged when overlapping. */
export function initZone(
  clefAnchors: StaffAnchor[],
  imageWidth: number,
): Array<{ start: number; stop: number }> {
  const marginRight = 10;
  const ranges = clefAnchors
    .map((c) => ({
      start: Math.max(Math.trunc(c.symbol.bottomLeft[0]), 0),
      stop: Math.min(Math.trunc(c.symbol.topRight[0] + marginRight), imageWidth),
    }))
    .sort((a, b) => a.start - b.start);
  const result: Array<{ start: number; stop: number }> = [];
  for (const r of ranges) {
    if (result.length === 0) {
      result.push({ ...r });
    } else if (r.start < result[result.length - 1].stop) {
      result[result.length - 1].stop = r.stop;
    } else {
      result.push({ ...r });
    }
  }
  return result;
}

/**
 * Filters peak rows of a vertical staff-line density slice. Returns the
 * validity mask plus the group index of each peak (peaks whose gaps exceed
 * max_gap belong to different groups). Direct port of filter_line_peaks.
 */
export function filterLinePeaks(
  peaks: number[],
  norm: number[],
  maxGapRatio = 1.5,
): { valid: boolean[]; groups: number[] } {
  const valid = new Array(peaks.length).fill(true);
  // Filter by height.
  for (let idx = 0; idx < peaks.length; idx++) {
    if (norm[peaks[idx]] > 15) valid[idx] = false;
  }
  // Filter by x-axis.
  const gaps: number[] = [];
  for (let i = 1; i < peaks.length; i++) gaps.push(peaks[i] - peaks[i - 1]);
  const count = Math.max(5, Math.round(peaks.length * 0.2));
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const approxUnit =
    sortedGaps.slice(0, count).reduce((s, v) => s + v, 0) / Math.max(1, Math.min(count, sortedGaps.length));
  const maxGap = approxUnit * maxGapRatio;

  const extPeaks = [peaks[0] - maxGap - 1, ...peaks];
  const groups: number[] = [];
  let group = -1;
  for (let i = 1; i < extPeaks.length; i++) {
    if (extPeaks[i] - extPeaks[i - 1] > maxGap) group += 1;
    groups.push(group);
  }
  groups.push(groups[groups.length - 1] + 1);
  let curG = groups[0];
  let runCount = 1;
  for (let idx = 1; idx < groups.length; idx++) {
    const g = groups[idx];
    if (g === curG) {
      runCount++;
      continue;
    }
    if (runCount < STAFF_LINE_COUNT) {
      for (let k = idx - runCount; k < idx; k++) valid[k] = false;
    } else if (runCount > STAFF_LINE_COUNT) {
      const candPeaks = peaks.slice(idx - runCount, idx);
      const headPart = candPeaks.slice(0, STAFF_LINE_COUNT);
      const tailPart = candPeaks.slice(-STAFF_LINE_COUNT);
      const headSum = headPart.reduce((s, p) => s + norm[p], 0);
      const tailSum = tailPart.reduce((s, p) => s + norm[p], 0);
      if (headSum > tailSum) {
        for (let k = idx - runCount + STAFF_LINE_COUNT; k < idx; k++) valid[k] = false;
      } else {
        for (let k = idx - runCount; k < idx - STAFF_LINE_COUNT; k++) valid[k] = false;
      }
    }
    curG = g;
    runCount = 1;
  }
  return { valid, groups: groups.slice(0, -1) };
}

/**
 * Finds groups of five horizontal staff lines in a vertical image slice.
 * Direct port of find_horizontal_lines.
 */
export function findHorizontalLines(
  image: GrayImage,
  unitSize: number,
  lineThreshold = 0.0,
): number[][] {
  const { width, height } = image;
  const count = new Array<number>(height).fill(0);
  for (let y = 0; y < height; y++) {
    let c = 0;
    for (let x = 0; x < width; x++) if (image.data[y * width + x] > 0) c++;
    count[y] = c;
  }
  const padded = [0, ...count, 0];
  const mean = padded.reduce((s, v) => s + v, 0) / padded.length;
  const variance = padded.reduce((s, v) => s + (v - mean) ** 2, 0) / padded.length;
  const std = Math.sqrt(variance) || 1;
  const norm = padded.map((v) => (v - mean) / std);
  const centers = findPeaks(norm, { height: lineThreshold, distance: 0.7 * unitSize, prominence: 1 }).map(
    (c) => c - 1,
  );
  const trimmedNorm = norm.slice(1, -1);
  const { groups } = filterLinePeaks(centers, trimmedNorm);
  const groupedCenters = new Map<number, number[]>();
  for (let i = 0; i < centers.length; i++) {
    const groupNumber = groups[i];
    if (!groupedCenters.has(groupNumber)) groupedCenters.set(groupNumber, []);
    groupedCenters.get(groupNumber)!.push(centers[i]);
  }
  const completeGroups: number[][] = [];
  for (const grouped of groupedCenters.values()) {
    if (grouped.length === STAFF_LINE_COUNT) completeGroups.push([...grouped].sort((a, b) => a - b));
  }
  return completeGroups;
}

/**
 * Predicts anchor symbols for staffs that have no clef: scans the columns
 * right of known clefs for horizontal line groups.
 */
export function predictOtherAnchorsFromClefs(
  clefAnchors: StaffAnchor[],
  image: GrayImage,
): RotatedBoundingBox[] {
  if (clefAnchors.length === 0) return [];
  const averageUnitSize =
    clefAnchors.reduce((s, a) => s + a.averageUnitSize, 0) / clefAnchors.length;
  const anchorSymbols = clefAnchors.map((a) => a.symbol);
  const clefZones = initZone(clefAnchors, image.width);
  const result: RotatedBoundingBox[] = [];
  for (const zone of clefZones) {
    const slice = crop(image, zone.start, 0, zone.stop - zone.start, image.height);
    const linesGroups = findHorizontalLines(slice, averageUnitSize);
    for (const group of linesGroups) {
      const minY = Math.min(...group);
      const maxY = Math.max(...group);
      const centerY = (minY + maxY) / 2;
      const centerX = zone.start + (zone.stop - zone.start) / 2;
      const box = new RotatedBoundingBox(
        { cx: centerX, cy: centerY, w: zone.stop - zone.start, h: maxY - minY, angle: 0 },
        [],
        0,
      );
      result.push(box);
    }
  }
  return result.filter((r) => !r.isOverlappingWithAny(anchorSymbols));
}

/**
 * Splits wide fragments into <=100px parts so curved lines are better
 * approximated by their pieces. Direct port of break_wide_fragments.
 */
export function breakWideFragments(
  fragments: RotatedBoundingBox[],
  limit = 100,
): RotatedBoundingBox[] {
  const result: RotatedBoundingBox[] = [];
  for (const fragment of fragments) {
    let remaining: RotatedBoundingBox | null = fragment;
    const parts: RotatedBoundingBox[] = [];
    while (remaining !== null && remaining.rect.w > limit) {
      const minX = Math.min(...remaining.points.map((p) => p[0]));
      const leftPts: Array<[number, number]> = remaining.points.filter((p) => p[0] < minX + limit);
      const rightPts: Array<[number, number]> = remaining.points.filter((p) => p[0] >= minX + limit);
      const leftSorted = [...leftPts].sort((a, b) => a[0] - b[0]);
      const rightSorted = [...rightPts].sort((a, b) => a[0] - b[0]);
      if (leftSorted.length === 0 || rightSorted.length === 0) break;
      leftSorted.push(rightSorted[0]);
      rightSorted.push(leftSorted[leftSorted.length - 1]);
      parts.push(new RotatedBoundingBox(fitRect(leftSorted), leftSorted, remaining.debugId));
      remaining = new RotatedBoundingBox(fitRect(rightSorted), rightSorted, remaining.debugId);
    }
    if (remaining !== null) parts.push(remaining);
    result.push(...parts);
  }
  return result;
}

function fitRect(pts: Array<[number, number]>): import("./image.ts").RotatedRect {
  return minAreaRect(pts);
}

/**
 * Full staff detection: anchors from clefs, predicted anchors, anchors
 * from bar lines; connect fragments; dedupe; resample; filter; sort.
 * Direct port of detect_staff.
 */
export function detectStaff(
  staffMask: GrayImage,
  staffFragments: RotatedBoundingBox[],
  clefsKeys: RotatedBoundingBox[],
  likelyBarOrRestLines: RotatedBoundingBox[],
): Staff[] {
  let staffAnchors = findStaffAnchors(staffFragments, clefsKeys, true);
  const possibleOtherClefs = predictOtherAnchorsFromClefs(staffAnchors, staffMask);
  staffAnchors = staffAnchors.concat(findStaffAnchors(staffFragments, possibleOtherClefs, true));
  staffAnchors = staffAnchors.concat(findStaffAnchors(staffFragments, likelyBarOrRestLines, false));
  staffAnchors = filterUnusualAnchors(staffAnchors);
  const rawStaffsWithDuplicates = findRawStaffsByConnectingLineFragments(staffAnchors, staffFragments);
  const rawStaffs = removeDuplicateStaffs(rawStaffsWithDuplicates);
  let staffs = resampleStaffs(rawStaffs);
  staffs = filterEdgeOfVision(staffs, staffMask.width, staffMask.height);
  staffs = sortStaffsTopToBottom(staffs);
  return staffs;
}

// ---------------------------------------------------------------------------
// Note detection (homr/note_detection.py)
// ---------------------------------------------------------------------------

/** A notehead ellipse paired with its stem (if any) and stem direction. */
export interface NoteheadWithStem {
  notehead: BoundingEllipse;
  stem: RotatedBoundingBox | null;
  stemDirection: StemDirection | null;
}

/**
 * Pairs each notehead with the first overlapping stem box. Direct port of
 * combine_noteheads_with_stems.
 */
export function combineNoteheadsWithStems(
  noteheads: BoundingEllipse[],
  stems: RotatedBoundingBox[],
): NoteheadWithStem[] {
  const sorted = [...noteheads].sort((a, b) => a.rect.cy - b.rect.cy);
  const result: NoteheadWithStem[] = [];
  for (const notehead of sorted) {
    const thickened = notehead.makeBoxThicker(15);
    let foundStem: RotatedBoundingBox | null = null;
    for (const stem of stems) {
      if (stem.isOverlapping(thickened)) {
        foundStem = stem;
        break;
      }
    }
    if (foundStem !== null) {
      const direction =
        foundStem.rect.cy < notehead.rect.cy ? StemDirection.UP : StemDirection.DOWN;
      result.push({ notehead, stem: foundStem, stemDirection: direction });
    } else {
      result.push({ notehead, stem: null, stemDirection: null });
    }
  }
  return result;
}

type Rect = [number, number, number, number]; // x0, y0, x1, y1

function getCenterOfRect(bbox: Rect): [number, number] {
  return [Math.round((bbox[0] + bbox[2]) / 2), Math.round((bbox[1] + bbox[3]) / 2)];
}

/** Shrinks a bbox vertically to the actual notehead ink rows. */
function adjustBbox(bbox: Rect, noteheads: GrayImage): Rect {
  let top = -1;
  let bottom = -1;
  for (let y = bbox[1]; y < bbox[3]; y++) {
    for (let x = bbox[0]; x < bbox[2]; x++) {
      if (noteheads.data[y * noteheads.width + x] > 0) {
        if (top < 0) top = y;
        bottom = y;
        break;
      }
    }
  }
  if (top < 0) return bbox; // Invalid note; eliminated with zero height downstream.
  return [bbox[0], top - 1, bbox[2], bottom + 1];
}

/**
 * Recursively splits a notehead bbox that is wide enough to hold two notes
 * side by side, or tall enough to hold stacked notes. Direct port of
 * check_bbox_size.
 */
export function checkBboxSize(bbox: Rect, noteheads: GrayImage, unitSize: number): Rect[] {
  const w = bbox[2] - bbox[0];
  const h = bbox[3] - bbox[1];
  const [cenX] = getCenterOfRect(bbox);
  const noteW = NOTEHEAD_SIZE_RATIO * unitSize;
  const noteH = unitSize;

  let newBbox: Rect[] = [];
  if (Math.abs(w - noteW) > Math.abs(w - noteW * 2)) {
    // Contains at least two notes, one left and one right.
    let leftBox: Rect = [bbox[0], bbox[1], cenX, bbox[3]];
    let rightBox: Rect = [cenX, bbox[1], bbox[2], bbox[3]];
    leftBox = adjustBbox(leftBox, noteheads);
    rightBox = adjustBbox(rightBox, noteheads);
    newBbox = [...newBbox, ...checkBboxSize(leftBox, noteheads, unitSize)];
    newBbox = [...newBbox, ...checkBboxSize(rightBox, noteheads, unitSize)];
  }

  if (newBbox.length > 0) {
    const tmp: Rect[] = [];
    for (const box of newBbox) tmp.push(...checkBboxSize(box, noteheads, unitSize));
    newBbox = tmp;
  } else {
    const numNotes = Math.round(h / noteH);
    if (numNotes > 0) {
      const subH = Math.floor(h / numNotes);
      for (let i = 0; i < numNotes; i++) {
        newBbox.push([
          bbox[0],
          Math.round(bbox[1] + i * subH),
          bbox[2],
          Math.round(bbox[1] + (i + 1) * subH),
        ]);
      }
    }
  }
  return newBbox;
}

/**
 * Splits clumps of merged noteheads into individual noteheads.
 * Direct port of split_clumps_of_noteheads.
 */
export function splitClumpsOfNoteheads(
  notehead: NoteheadWithStem,
  noteheadMask: GrayImage,
  staff: Staff,
): NoteheadWithStem[] {
  const bbox: Rect = [
    Math.trunc(notehead.notehead.topLeft[0]),
    Math.trunc(notehead.notehead.topLeft[1]),
    Math.trunc(notehead.notehead.bottomRight[0]),
    Math.trunc(notehead.notehead.bottomRight[1]),
  ];
  const splitBoxes = checkBboxSize(bbox, noteheadMask, staff.averageUnitSize);
  if (splitBoxes.length <= 1) return [notehead];
  return splitBoxes.map((box) => {
    const [cx, cy] = getCenterOfRect(box);
    const size: [number, number] = [box[2] - box[0], box[3] - box[1]];
    const ellipse = new BoundingEllipse(
      { cx, cy, w: size[0], h: size[1], angle: 0 },
      notehead.notehead.points,
      notehead.notehead.debugId,
    );
    return { notehead: ellipse, stem: notehead.stem, stemDirection: notehead.stemDirection };
  });
}

/**
 * Assigns noteheads to staffs, splits clumps and computes staff positions.
 * Direct port of add_notes_to_staffs.
 */
export function addNotesToStaffs(
  staffs: Staff[],
  noteheads: NoteheadWithStem[],
  noteheadMask: GrayImage,
): Note[] {
  const result: Note[] = [];
  for (const staff of staffs) {
    for (const noteheadChunk of noteheads) {
      if (!staff.isOnStaffZone(noteheadChunk.notehead)) continue;
      const center = noteheadChunk.notehead.rect;
      let point = staff.getAt(center.cx);
      if (point === null) continue;
      if (
        noteheadChunk.notehead.rect.w < 0.5 * point.averageUnitSize ||
        noteheadChunk.notehead.rect.h < 0.5 * point.averageUnitSize
      ) {
        continue;
      }
      for (const notehead of splitClumpsOfNoteheads(noteheadChunk, noteheadMask, staff)) {
        point = staff.getAt(center.cx);
        if (point === null) continue;
        const w = notehead.notehead.rect.w;
        const h = notehead.notehead.rect.h;
        if (
          w < 0.5 * point.averageUnitSize ||
          w > 3 * point.averageUnitSize ||
          h < 0.5 * point.averageUnitSize ||
          h > 2 * point.averageUnitSize
        ) {
          continue;
        }
        const position = point.findPositionInUnitSizes(notehead.notehead);
        const note = new Note(notehead.notehead, position, notehead.stem, notehead.stemDirection);
        result.push(note);
        staff.addSymbol(note);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Bar line detection (homr/bar_line_detection.py)
// ---------------------------------------------------------------------------

/** Dilates the stems/rest mask so bar lines connect into single components. */
export function prepareBarLineImage(stemsRest: GrayImage): GrayImage {
  return dilate(stemsRest, rectKernel(3, 5));
}

/** Keeps bar-line candidates that are tall and thin relative to noteheads. */
export function detectBarLines(
  barLines: RotatedBoundingBox[],
  averageNoteheadHeight: number,
): RotatedBoundingBox[] {
  return barLines.filter(
    (bar) => bar.rect.h >= 3 * averageNoteheadHeight && bar.rect.w <= 2 * averageNoteheadHeight,
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Brace/bracket detection (homr/brace_dot_detection.py)
// ---------------------------------------------------------------------------

/** Rough unit-size-relative brace candidate thresholds. */
export function minHeightForBraceRough(unitSize: number): number {
  return 2 * unitSize;
}
export function maxWidthForBraceRough(unitSize: number): number {
  return 3 * unitSize;
}
export function minHeightForBrace(unitSize: number): number {
  return 4 * unitSize;
}
export const MIN_WIDTH_FOR_BRACE_DOT_CANDIDATE = 5;
export const BRACE_CORE_WIDTH_RATIO = 0.5;
export function toleranceForTouchingClefs(unitSize: number): number {
  return Math.round(unitSize * 2);
}

/**
 * Removes staff lines from the symbols mask and dilates vertically so
 * braces/brackets form single blobs. Direct port of prepare_brace_dot_image.
 */
export function prepareBraceDotImage(symbols: GrayImage, staff: GrayImage): GrayImage {
  const braceDot = subtract(symbols, staff);
  const eroded = erode(braceDot, ellipseKernel(1, 5));
  return dilate(eroded, ellipseKernel(5, 35));
}

/**
 * Recovers a brace/bracket candidate's true vertical span: keeps only the
 * rows at least half as wide as the blob's widest row. Returns the symbol
 * unchanged when the span cannot be determined.
 */
export function trimSymbolToCoreSpan(symbol: RotatedBoundingBox): RotatedBoundingBox {
  if (symbol.points.length === 0) return symbol;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of symbol.points) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  const baseY = Math.floor(y0);
  const h = Math.ceil(y1) - baseY + 1;
  const w = Math.ceil(x1) - Math.floor(x0) + 1;
  if (h <= 0 || w <= 0) return symbol;
  const rowMin = new Array(h).fill(Infinity);
  const rowMax = new Array(h).fill(-Infinity);
  for (const p of symbol.points) {
    const ry = Math.floor(p[1]) - baseY;
    if (ry < 0 || ry >= h) continue;
    if (p[0] < rowMin[ry]) rowMin[ry] = p[0];
    if (p[0] > rowMax[ry]) rowMax[ry] = p[0];
  }
  const widths = rowMin.map((mn, i) => (mn === Infinity ? 0 : rowMax[i] - mn));
  const maxWidth = Math.max(...widths);
  if (maxWidth === 0) return symbol;
  const coreRows: number[] = [];
  for (let i = 0; i < h; i++) {
    if (widths[i] >= maxWidth * BRACE_CORE_WIDTH_RATIO) coreRows.push(i);
  }
  if (coreRows.length === 0) return symbol;
  const coreMinY = baseY + Math.min(...coreRows);
  const coreMaxY = baseY + Math.max(...coreRows) + 1;
  const coreHeight = coreMaxY - coreMinY;
  if (coreHeight <= 0) return symbol;
  return new RotatedBoundingBox(
    {
      cx: symbol.rect.cx,
      cy: (coreMinY + coreMaxY) / 2,
      w: symbol.rect.w,
      h: coreHeight,
      angle: symbol.rect.angle,
    },
    symbol.points,
    symbol.debugId,
  );
}

/**
 * Two-pass brace candidate filter: a rough unit-size pass, then a precise
 * pass against the closest staff's unit size.
 */
export function filterForTallElements(
  braceDots: RotatedBoundingBox[],
  staffs: Staff[],
): RotatedBoundingBox[] {
  if (staffs.length === 0) return [];
  const roughUnitSize = staffs[0].averageUnitSize;
  const rough = braceDots.filter(
    (symbol) =>
      symbol.rect.h > minHeightForBraceRough(roughUnitSize) &&
      symbol.rect.w < maxWidthForBraceRough(roughUnitSize) &&
      symbol.rect.w >= MIN_WIDTH_FOR_BRACE_DOT_CANDIDATE,
  );
  const result: RotatedBoundingBox[] = [];
  for (const symbol of rough) {
    let closest = staffs[0];
    let closestDist = Infinity;
    for (const s of staffs) {
      const d = s.yDistanceTo([symbol.rect.cx, symbol.rect.cy]);
      if (d < closestDist) {
        closestDist = d;
        closest = s;
      }
    }
    if (symbol.rect.h > minHeightForBrace(closest.averageUnitSize)) result.push(symbol);
  }
  return result;
}

/** Bar-line connections between two staffs (empty: no BarLine symbols exist here). */
function getConnectionsBetweenStaffsAtBarLines(
  _staff1: Staff,
  _staff2: Staff,
  _braceDots: RotatedBoundingBox[],
): RotatedBoundingBox[] {
  return [];
}

/** Clef connections between two staffs (empty: no Clef symbols exist here). */
function getConnectionsBetweenStaffsAtClefs(
  _staff1: Staff,
  _staff2: Staff,
  _braceDots: RotatedBoundingBox[],
): RotatedBoundingBox[] {
  return [];
}

function pointInPolygon(p: [number, number], poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Whether a rotated box overlaps an axis-aligned rectangle. */
function rotatedBoxOverlapsAxisRect(
  a: RotatedBoundingBox,
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
): boolean {
  for (const p of a.polygon) {
    if (p[0] >= bx0 && p[0] <= bx1 && p[1] >= by0 && p[1] <= by1) return true;
  }
  const corners: Array<[number, number]> = [
    [bx0, by0],
    [bx1, by0],
    [bx0, by1],
    [bx1, by1],
  ];
  for (const c of corners) {
    if (pointInPolygon(c, a.polygon)) return true;
  }
  return false;
}

/**
 * Brace/bracket candidates touching both staffs' line spans: the thickened
 * symbol must overlap each staff's vertical line segment at the symbol's x.
 */
function getConnectionsBetweenStaffsAtLines(
  staff1: Staff,
  staff2: Staff,
  braceDots: RotatedBoundingBox[],
): RotatedBoundingBox[] {
  const result: RotatedBoundingBox[] = [];
  for (const symbol of braceDots) {
    const thicker = symbol.makeBoxThicker(toleranceForTouchingClefs(staff1.averageUnitSize));
    const point1 = staff1.getAt(symbol.rect.cx);
    const point2 = staff2.getAt(symbol.rect.cx);
    if (point1 === null || point2 === null) continue;
    const box1 = point1.toBoundingBox();
    const box2 = point2.toBoundingBox();
    if (
      rotatedBoxOverlapsAxisRect(thicker, box1.x, box1.y, box1.x + box1.w, box1.y + box1.h) &&
      rotatedBoxOverlapsAxisRect(thicker, box2.x, box2.y, box2.x + box2.w, box2.y + box2.h)
    ) {
      result.push(symbol);
    }
  }
  return result;
}

/** All brace/bracket connections between two adjacent staffs. */
export function getConnectionsBetweenStaffs(
  staff1: Staff,
  staff2: Staff,
  braceDots: RotatedBoundingBox[],
): RotatedBoundingBox[] {
  return [
    ...getConnectionsBetweenStaffsAtBarLines(staff1, staff2, braceDots),
    ...getConnectionsBetweenStaffsAtClefs(staff1, staff2, braceDots),
    ...getConnectionsBetweenStaffsAtLines(staff1, staff2, braceDots),
  ];
}

/** Merges MultiStaffs that share a staff. */
export function mergeMultiStaffIfTheyShareAStaff(staffs: MultiStaff[]): MultiStaff[] {
  const result: MultiStaff[] = [];
  for (const staff of staffs) {
    let merged = false;
    for (const existing of result) {
      if (staff.staffs.some((s) => existing.staffs.includes(s))) {
        result.splice(result.indexOf(existing), 1);
        result.push(existing.merge(staff));
        merged = true;
        break;
      }
    }
    if (!merged) result.push(staff);
  }
  return result;
}

/**
 * Groups staffs into systems and grand staffs from brace/bracket
 * candidates. Direct port of find_braces_brackets_and_grand_staff_lines.
 */
export function findBracesBracketsAndGrandStaffLines(
  staffs: Staff[],
  braceDots: RotatedBoundingBox[],
): MultiStaff[] {
  const trimmed = braceDots.map((s) => trimSymbolToCoreSpan(s));
  const filtered = filterForTallElements(trimmed, staffs);
  const result: MultiStaff[] = [];
  for (let i = 0; i < staffs.length; i++) {
    const staff = staffs[i];
    const neighbors: Staff[] = [];
    if (i > 0) neighbors.push(staffs[i - 1]);
    if (i < staffs.length - 1) neighbors.push(staffs[i + 1]);
    let anyConnectedNeighbor = false;
    for (const neighbor of neighbors) {
      const connections = getConnectionsBetweenStaffs(staff, neighbor, filtered);
      if (connections.length >= MINIMUM_CONNECTIONS_TO_FORM_COMBINED_STAFF) {
        result.push(new MultiStaff([staff, neighbor], connections));
        anyConnectedNeighbor = true;
      }
    }
    if (!anyConnectedNeighbor) result.push(new MultiStaff([staff], []));
  }
  const merged = mergeMultiStaffIfTheyShareAStaff(result);
  return merged.map((ms) => ms.createGrandstaffs(filtered));
}
// Page preprocessing (homr/main.py: load_and_preprocess_predictions)
// ---------------------------------------------------------------------------

/**
 * Finds the paper bounding box. Direct port of homr's autocrop, except the
 * morphology runs on a 0.25-downscaled binary image for speed (homr runs it
 * full-resolution; the box is coarse either way).
 *
 * homr reads BGR via cv2.imread: the dominant-color histogram uses channel 0
 * (blue), and the grayscale is cv2.COLOR_BGR2GRAY. Pixel buffers here are
 * RGB(A), so blue is channel index 2.
 *
 * Returns the crop box; {x:0,y:0,width,height} means "keep the full image".
 */
export function autocrop(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  format: "rgba" | "rgb" | "gray",
): { x: number; y: number; width: number; height: number } {
  const full = { x: 0, y: 0, width, height };
  const n = width * height;
  const step = format === "gray" ? 1 : format === "rgba" ? 4 : 3;
  const gray = new GrayImage(width, height);
  const blue = new GrayImage(width, height);
  for (let i = 0; i < n; i++) {
    if (format === "gray") {
      gray.data[i] = pixels[i];
      blue.data[i] = pixels[i];
    } else {
      const r = pixels[i * step];
      const g = pixels[i * step + 1];
      const b = pixels[i * step + 2];
      gray.data[i] = Math.round(0.114 * b + 0.587 * g + 0.299 * r);
      blue.data[i] = b;
    }
  }
  const hist = calcHist(blue);
  let dominant = 0;
  for (let i = 1; i < 256; i++) {
    if (hist[i] > hist[dominant]) dominant = i; // np.argmax: first maximum wins
  }
  const binary = threshold(gray, dominant - 30, 255);
  const scale = 0.25;
  const smallW = Math.max(1, Math.floor(width * scale));
  const smallH = Math.max(1, Math.floor(height * scale));
  const small = resize(binary, smallW, smallH, { interpolation: "nearest" });
  const closed = erode(dilate(small, rectKernel(7, 7)), rectKernel(7, 7));
  const morphed = erode(closed, rectKernel(9, 9));
  const components = findContours(morphed);
  if (components.length === 0) return full;
  let best = components[0];
  for (const c of components) {
    if (c.area > best.area) best = c;
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < best.pixels.length; i += 2) {
    const x = best.pixels[i];
    const y = best.pixels[i + 1];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const x = Math.floor(x0 / scale);
  const y = Math.floor(y0 / scale);
  const w = Math.ceil(x1 / scale) - x;
  const h = Math.ceil(y1 / scale) - y;
  if (w <= 0 || h <= 0) return full;
  // If we can't find a large contour, the picture has no page borders.
  if (x < width * 0.25 || y < height * 0.25) return full;
  return { x, y, width: w, height: h };
}

/** Mean grayscale intensity (homr's preprocessed-image noise helper input). */
export function imageMean(image: GrayImage): number {
  return meanGray(image);
}
