const TICKS_PER_QUARTER = 480;
const QUARTER = TICKS_PER_QUARTER;
const WHOLE = TICKS_PER_QUARTER * 4;
const VELOCITY_RH = 62;
const VELOCITY_LH = 50;
// Playback tempo of generated transcriptions; must match the MIDI tempo meta event.
const TRANSCRIPTION_BPM = 46;

const LETTER_BASE: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

export interface ParsedSheetMusicMidi {
  midiData: ArrayBuffer;
  fileName: string;
  warnings: string[];
}

export interface SheetMusicNoteBox {
  /** Notehead bounding box, in pixels of the decoded source image (see imageWidth/imageHeight). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SheetMusicNoteLayout {
  /** MIDI note number. */
  pitch: number;
  /** Note onset in seconds, matching the generated MIDI timeline. */
  startSec: number;
  /** Note end in seconds, matching the generated MIDI timeline. */
  endSec: number;
  bbox: SheetMusicNoteBox;
}

export interface ParsedSheetMusicWithLayout extends ParsedSheetMusicMidi {
  /** Dimensions of the decoded image the OCR analyzed. */
  imageWidth: number;
  imageHeight: number;
  /** One entry per imported MIDI note, aligned with the generated MIDI. */
  noteLayout: SheetMusicNoteLayout[];
}

export interface BinarySheetImage {
  width: number;
  height: number;
  dark: Uint8Array;
  rowCounts: Uint16Array;
}

interface DetectedStaff {
  support?: number;
  lines: number[];
  spacing: number;
  top: number;
  bottom: number;
  slope: number;
  systemIndex: number;
  clef: "treble" | "bass";
}

export interface DetectedSheetNote {
  midi: number;
  startTick: number;
  durationTicks: number;
  velocity: number;
  channel?: number;
}

interface NoteCandidate {
  x: number;
  y: number;
  midi: number;
  area: number;
  staffTop: number;
  staffBottom: number;
  systemIndex: number;
  clef: "treble" | "bass";
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface DetectedSheetNoteLayout {
  midi: number;
  startTick: number;
  durationTicks: number;
  bbox: SheetMusicNoteBox;
}

function note(name: string): number {
  const match = /^([A-G])([#b]?)(-?\d+)$/.exec(name);
  if (!match) throw new Error(`Invalid note name: ${name}`);

  const [, letter, accidental, octaveText] = match;
  const base = LETTER_BASE[letter];
  if (base === undefined) throw new Error(`Invalid note name: ${name}`);
  const shift = accidental === "#" ? 1 : accidental === "b" ? -1 : 0;
  return 12 * (Number(octaveText) + 1) + base + shift;
}

function vlq(value: number): number[] {
  const parts = [value & 0x7f];
  let remaining = value >> 7;

  while (remaining) {
    parts.push((remaining & 0x7f) | 0x80);
    remaining >>= 7;
  }

  return parts.reverse();
}

function u32(value: number): number[] {
  return [(value >> 24) & 255, (value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function u16(value: number): number[] {
  return [(value >> 8) & 255, value & 255];
}

function ascii(text: string): number[] {
  return Array.from(text, (char) => char.charCodeAt(0) & 255);
}

function concatBytes(chunks: Array<number[] | Uint8Array>): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

class MidiTrackBuilder {
  private events: { tick: number; data: number[]; order: number }[] = [];
  private order = 0;

  push(tick: number, data: number[]): void {
    this.events.push({ tick, data, order: this.order });
    this.order += 1;
  }

  meta(tick: number, kind: number, payload: number[]): void {
    this.push(tick, [0xff, kind, ...vlq(payload.length), ...payload]);
  }

  noteOn(tick: number, channel: number, pitch: number, velocity: number): void {
    this.push(tick, [0x90 | channel, pitch, velocity]);
  }

  noteOff(tick: number, channel: number, pitch: number): void {
    this.push(tick, [0x80 | channel, pitch, 0]);
  }

  addNote(tick: number, channel: number, pitch: number, duration: number, velocity: number): void {
    this.noteOn(tick, channel, pitch, velocity);
    this.noteOff(tick + duration, channel, pitch);
  }

  addChord(tick: number, channel: number, pitches: number[], duration: number, velocity: number): void {
    for (const pitch of pitches) this.noteOn(tick, channel, pitch, velocity);
    for (const pitch of pitches) this.noteOff(tick + duration, channel, pitch);
  }

  render(): number[] {
    const body: number[] = [];
    let lastTick = 0;

    const events = [...this.events].sort((a, b) => a.tick - b.tick || a.order - b.order);
    for (const event of events) {
      body.push(...vlq(event.tick - lastTick), ...event.data);
      lastTick = event.tick;
    }

    body.push(0x00, 0xff, 0x2f, 0x00);
    return [...ascii("MTrk"), ...u32(body.length), ...body];
  }
}

function tempoPayload(bpm: number): number[] {
  const microsPerQuarter = Math.round(60000000 / bpm);
  return [(microsPerQuarter >> 16) & 255, (microsPerQuarter >> 8) & 255, microsPerQuarter & 255];
}

function makeMidiArrayBuffer(tracks: number[][]): ArrayBuffer {
  const header = [...ascii("MThd"), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(TICKS_PER_QUARTER)];
  const bytes = concatBytes([header, ...tracks]);
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

export function buildDetectedSheetMusicMidi(notes: DetectedSheetNote[], title = "Scanned sheet music"): ArrayBuffer {
  const conductor = new MidiTrackBuilder();
  const melody = new MidiTrackBuilder();

  conductor.meta(0, 0x03, ascii(title));
  conductor.meta(0, 0x51, tempoPayload(TRANSCRIPTION_BPM));
  conductor.meta(0, 0x58, [4, 2, 24, 8]);

  melody.push(0, [0xc0, 0]);
  melody.push(0, [0xc1, 0]);
  for (const noteEvent of notes) {
    const startTick = Math.max(0, Math.trunc(noteEvent.startTick));
    const midi = Math.max(0, Math.min(127, Math.trunc(noteEvent.midi)));
    const duration = Math.max(QUARTER / 4, Math.trunc(noteEvent.durationTicks));
    const velocity = Math.max(1, Math.min(127, Math.trunc(noteEvent.velocity)));
    const channel = Math.max(0, Math.min(15, Math.trunc(noteEvent.channel ?? 0)));
    if (![startTick, midi, duration, velocity, channel].every(Number.isFinite)) continue;
    melody.addNote(startTick, channel, midi, duration, velocity);
  }
  if (notes.length) {
    const maxNoteEnd = Math.max(...notes.map((noteEvent) => noteEvent.startTick + noteEvent.durationTicks));
    const endTick = Math.ceil(maxNoteEnd / (WHOLE * 4)) * (WHOLE * 4);
    melody.push(endTick, [0xb0, 7, 100]);
  }

  return makeMidiArrayBuffer([conductor.render(), melody.render()]);
}

function basenameWithoutExtension(name: string): string {
  return (name || "sheet-music").replace(/\.[^.]*$/, "") || "sheet-music";
}

export function isSupportedSheetMusicImageFile(file: File): boolean {
  const type = (file.type || "").toLowerCase().trim();
  const name = file.name.toLowerCase();
  const hasSupportedExtension = /\.(?:jpe?g|png)$/.test(name);
  const hasSupportedType =
    type === "image/jpeg" ||
    type === "image/jpg" ||
    type === "image/pjpeg" ||
    type === "image/png" ||
    type === "image/x-png";

  if (hasSupportedType) return true;
  // A declared but unsupported image type (SVG, WebP, GIF, HEIC) wins over the
  // file name. Generic or missing types fall through to the extension, which is
  // what iOS and some desktop pickers send for camera JPEGs.
  if (type.startsWith("image/")) return false;
  return hasSupportedExtension;
}

function canUseBrowserImagePipeline(): boolean {
  return typeof createImageBitmap === "function" && typeof document !== "undefined";
}

function paperLuminance(values: Uint8ClampedArray, offset: number): number {
  const alpha = values[offset + 3] / 255;
  const ink = 0.2126 * values[offset] + 0.7152 * values[offset + 1] + 0.0722 * values[offset + 2];
  return Math.round(alpha * ink + (1 - alpha) * 255);
}

function extractLuminance(pixels: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const luminance = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i += 1) {
    luminance[i] = paperLuminance(pixels, i * 4);
  }
  return luminance;
}

// Local background estimate: the mean luminance in a window much wider than
// a staff line but narrower than typical illumination gradients (shadows,
// vignetting) and paper-texture mottling.
function backgroundMean(
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number
): Float64Array {
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      rowSum += luminance[y * width + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum;
    }
  }
  const background = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const sum =
        integral[(y1 + 1) * stride + x1 + 1] -
        integral[y0 * stride + x1 + 1] -
        integral[(y1 + 1) * stride + x0] +
        integral[y0 * stride + x0];
      background[y * width + x] = sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
    }
  }
  return background;
}

// Local-adaptive binarization: a pixel is ink when it is significantly darker
// than its local background. Unlike a single global threshold, this suppresses
// paper texture and uneven lighting, which otherwise binarize as solid dark
// regions that merge adjacent staff lines into unresolvable blobs.
export function binarizeLuminance(
  luminance: Uint8ClampedArray,
  width: number,
  height: number
): BinarySheetImage {
  const radius = Math.max(8, Math.min(40, Math.round(Math.min(width, height) / 60)));
  const background = backgroundMean(luminance, width, height, radius);
  const contrast = 20;
  const dark = new Uint8Array(width * height);
  const rowCounts = new Uint16Array(height);

  for (let y = 0; y < height; y += 1) {
    let count = 0;
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (luminance[i] < background[i] - contrast) {
        dark[i] = 1;
        count += 1;
      }
    }
    rowCounts[y] = count;
  }

  return { width, height, dark, rowCounts };
}

interface DecodedSheetImage {
  image: BinarySheetImage;
  luminance: Uint8ClampedArray;
  sourceWidth: number;
  sourceHeight: number;
}

async function decodeSheetImage(file: File): Promise<DecodedSheetImage | null> {
  if (!canUseBrowserImagePipeline()) return null;

  const bitmap = await createImageBitmap(file);
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const maxSide = 1800;
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const pixels = ctx.getImageData(0, 0, width, height).data;
  const luminance = extractLuminance(pixels, width, height);
  return { image: binarizeLuminance(luminance, width, height), luminance, sourceWidth, sourceHeight };
}

// Variance of the Laplacian: a sharp image has strong second-derivative
// responses at ink edges, while blur suppresses them. Calibrated on camera
// photos of sheet music: a sharp photo scores ~290, light blur (sigma 1)
// ~44, heavy blur (sigma 2) ~12. Pure function for unit tests.
export function laplacianVariance(luminance: Uint8ClampedArray, width: number, height: number): number {
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const i = y * width + x;
      const laplacian = -4 * luminance[i] + luminance[i - 1] + luminance[i + 1] + luminance[i - width] + luminance[i + width];
      sum += laplacian;
      sumSquares += laplacian * laplacian;
      count += 1;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

// Advisory quality warnings. These never throw: a blurry or small image can
// still transcribe, but the user should know recognition may be degraded.
export function analyzeSheetImageQuality(
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number
): string[] {
  const warnings: string[] = [];
  if (Math.max(sourceWidth, sourceHeight) < 1280) {
    warnings.push(
      `The image is low resolution (${sourceWidth}x${sourceHeight}); small details may be missed. Use a higher-resolution photo for better results.`
    );
  }
  if (laplacianVariance(luminance, width, height) < 30) {
    warnings.push("The image looks blurry; sharper focus would improve recognition.");
  }
  return warnings;
}

export function binarizeSheetPixels(pixels: Uint8ClampedArray, width: number, height: number): BinarySheetImage {
  return binarizeLuminance(extractLuminance(pixels, width, height), width, height);
}

function groupConsecutiveRows(rows: number[]): number[][] {
  const groups: number[][] = [];
  for (const row of rows) {
    const current = groups[groups.length - 1];
    if (current && row - current[current.length - 1] <= 1) {
      current.push(row);
    } else {
      groups.push([row]);
    }
  }
  return groups;
}

// Paper texture can keep the projection valleys between adjacent staff lines
// above the peak threshold, merging several lines into one wide group. Split
// such groups at deep local minima so each staff line becomes its own peak.
// A valley only splits when it dips below 60% of both neighboring maxima, so
// clean single lines (which have no internal valley) are never split.
function splitGroupAtValleys(group: number[], bins: ArrayLike<number>): number[][] {
  if (group.length < 3) return [group];
  let bestIndex = -1;
  let bestDepth = 0;
  let leftPeak = 0;
  for (let i = 1; i < group.length - 1; i += 1) {
    const y = group[i];
    if (bins[y] > leftPeak) leftPeak = bins[y];
    const isValley =
      (bins[y] < bins[y - 1] && bins[y] <= bins[y + 1]) || (bins[y] <= bins[y - 1] && bins[y] < bins[y + 1]);
    if (!isValley) continue;
    let rightPeak = 0;
    for (let j = i + 1; j < group.length; j += 1) {
      if (bins[group[j]] > rightPeak) rightPeak = bins[group[j]];
    }
    const neighborPeak = Math.min(leftPeak, rightPeak);
    if (neighborPeak <= 0) continue;
    if (bins[y] < neighborPeak * 0.6) {
      const depth = neighborPeak - bins[y];
      if (depth > bestDepth) {
        bestDepth = depth;
        bestIndex = i;
      }
    }
  }
  if (bestIndex < 0) return [group];
  return [
    ...splitGroupAtValleys(group.slice(0, bestIndex), bins),
    ...splitGroupAtValleys(group.slice(bestIndex + 1), bins),
  ];
}

function lineYAtX(staff: DetectedStaff, line: number, x: number, width: number): number {
  return line + staff.slope * (x - width / 2);
}

function projectRowsForSlope(image: BinarySheetImage, slope: number): Uint16Array {
  const extra = Math.ceil(Math.abs(slope) * image.width) + 12;
  const bins = new Uint16Array(image.height + extra * 2);
  const offset = extra;

  for (let y = 0; y < image.height; y += 1) {
    if (image.rowCounts[y] === 0) continue;
    for (let x = 0; x < image.width; x += 1) {
      if (!image.dark[y * image.width + x]) continue;
      const projectedY = Math.round(y - slope * (x - image.width / 2)) + offset;
      if (projectedY >= 0 && projectedY < bins.length) bins[projectedY] += 1;
    }
  }

  return bins;
}

function projectBandRowsForSlope(
  image: BinarySheetImage,
  slope: number,
  minY: number,
  maxY: number,
  minX = 0,
  maxX = image.width - 1
): Uint16Array {
  const bandHeight = Math.max(1, maxY - minY + 1);
  const extra = Math.ceil(Math.abs(slope) * image.width) + 12;
  const bins = new Uint16Array(bandHeight + extra * 2);
  const offset = extra;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (!image.dark[y * image.width + x]) continue;
      const projectedY = Math.round(y - minY - slope * (x - image.width / 2)) + offset;
      if (projectedY >= 0 && projectedY < bins.length) bins[projectedY] += 1;
    }
  }

  return bins;
}

function lineCentersFromProjection(bins: Uint16Array, width: number): Array<{ center: number; strength: number }> {
  const peakThreshold = Math.max(18, Math.round(width * 0.09));
  const candidateRows: number[] = [];
  for (let y = 0; y < bins.length; y += 1) {
    if (bins[y] >= peakThreshold) candidateRows.push(y);
  }

  return groupConsecutiveRows(candidateRows)
    .flatMap((group) => splitGroupAtValleys(group, bins))
    .map((group) => {
      let weighted = 0;
      let strength = 0;
      for (const y of group) {
        weighted += y * bins[y];
        strength += bins[y];
      }
      return {
        center: weighted / Math.max(1, strength),
        strength,
      };
    })
    .filter((center, index, all) => index === 0 || center.center - all[index - 1].center > 2);
}

function lineCentersFromRows(rowCounts: Uint16Array, width: number): Array<{ center: number; strength: number }> {
  const peakThreshold = Math.max(14, Math.round(width * 0.055));
  const candidateRows: number[] = [];
  for (let y = 0; y < rowCounts.length; y += 1) {
    const prev = rowCounts[y - 1] ?? 0;
    const next = rowCounts[y + 1] ?? 0;
    if (rowCounts[y] >= peakThreshold || (rowCounts[y] >= peakThreshold * 0.75 && rowCounts[y] >= prev && rowCounts[y] >= next)) {
      candidateRows.push(y);
    }
  }

  return groupConsecutiveRows(candidateRows)
    .flatMap((group) => splitGroupAtValleys(group, rowCounts))
    .map((group) => {
      let weighted = 0;
      let strength = 0;
      for (const y of group) {
        weighted += y * rowCounts[y];
        strength += rowCounts[y];
      }
      return {
        center: weighted / Math.max(1, strength),
        strength,
      };
    })
    .filter((center, index, all) => index === 0 || center.center - all[index - 1].center > 2);
}

// Projection concentration: staff lines concentrate their ink into a few
// row bins at the true slope and smear across many bins elsewhere, so the
// sum of squared bin counts peaks at the dominant staff slope.
function projectionConcentration(image: BinarySheetImage, slope: number): number {
  const bins = projectRowsForSlope(image, slope);
  let score = 0;
  for (let y = 0; y < bins.length; y += 1) score += bins[y] * bins[y];
  return score;
}

export interface StaffSkewEstimate {
  /** Dominant staff-line slope (rise over run). */
  slope: number;
  /** Concentration score at the estimated slope. */
  score: number;
  /** Concentration score at slope 0, for deciding whether to deskew. */
  horizontalScore: number;
}

// Estimate the dominant staff-line slope of a scanned page. Pure function so
// synthetic tilted images can verify it in unit tests.
export function estimateStaffSkew(image: BinarySheetImage): StaffSkewEstimate {
  const horizontalScore = projectionConcentration(image, 0);
  let bestSlope = 0;
  let bestScore = horizontalScore;
  for (let slope = -0.2; slope <= 0.2001; slope += 0.01) {
    if (Math.abs(slope) < 0.005) continue;
    const score = projectionConcentration(image, slope);
    if (score > bestScore) {
      bestScore = score;
      bestSlope = slope;
    }
  }
  return { slope: bestSlope, score: bestScore, horizontalScore };
}

export interface DeskewedSheetImage {
  image: BinarySheetImage;
  /** Slope that was removed; 0 when the image was already horizontal. */
  slope: number;
  /** Vertical padding added during the shear; maps coordinates back. */
  yOffset: number;
}

// Shear the binary image so staff lines become horizontal. The image grows
// vertically to avoid clipping; map coordinates back with deskewInverseY.
export function deskewBinaryImage(image: BinarySheetImage, slope: number): DeskewedSheetImage {
  if (Math.abs(slope) < 1e-9) return { image, slope: 0, yOffset: 0 };
  const yOffset = Math.ceil((Math.abs(slope) * image.width) / 2);
  const height = image.height + yOffset * 2;
  const dark = new Uint8Array(image.width * height);
  const rowCounts = new Uint16Array(height);
  for (let x = 0; x < image.width; x += 1) {
    const shift = Math.round(slope * (x - image.width / 2));
    for (let y = 0; y < image.height; y += 1) {
      if (!image.dark[y * image.width + x]) continue;
      const dy = y - shift + yOffset;
      dark[dy * image.width + x] = 1;
      rowCounts[dy] += 1;
    }
  }
  return { image: { width: image.width, height, dark, rowCounts }, slope, yOffset };
}

// Map a y-coordinate from deskewed analysis space back to the original image.
export function deskewInverseY(deskewed: DeskewedSheetImage, x: number, y: number): number {
  return y - deskewed.yOffset + deskewed.slope * (x - deskewed.image.width / 2);
}

function stavesOverlap(a: DetectedStaff, b: DetectedStaff): boolean {
  const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const smallerHeight = Math.min(a.bottom - a.top, b.bottom - b.top);
  if (overlapHeight > smallerHeight * 0.45) return true;

  const lineTolerance = Math.max(2, Math.min(a.spacing, b.spacing) * 0.35);
  const sharedLines = a.lines.filter((line) => b.lines.some((otherLine) => Math.abs(line - otherLine) <= lineTolerance));
  return sharedLines.length >= 2;
}

function selectGrandStaffPairs(staves: DetectedStaff[], imageHeight: number): DetectedStaff[] {
  if (staves.length < 6) return staves;

  const sorted = [...staves].sort((a, b) => a.top - b.top);
  const pairCandidates: Array<{ upper: DetectedStaff; lower: DetectedStaff; score: number }> = [];
  for (let upperIndex = 0; upperIndex < sorted.length - 1; upperIndex += 1) {
    const upper = sorted[upperIndex];
    for (let lowerIndex = upperIndex + 1; lowerIndex < sorted.length; lowerIndex += 1) {
      const lower = sorted[lowerIndex];
      if (!looksLikeGrandStaffPair(upper, lower)) continue;
      const averageSpacing = (upper.spacing + lower.spacing) / 2;
      const slopePenalty = Math.abs(upper.slope - lower.slope) * averageSpacing;
      pairCandidates.push({
        upper,
        lower,
        score: upper.spacing + lower.spacing - slopePenalty,
      });
    }
  }

  const selected = new Set<DetectedStaff>();
  const selectedPairs: Array<{ upper: DetectedStaff; lower: DetectedStaff; score: number }> = [];
  for (const pair of pairCandidates.sort((a, b) => b.score - a.score)) {
    if (selected.has(pair.upper) || selected.has(pair.lower)) continue;
    selected.add(pair.upper);
    selected.add(pair.lower);
    selectedPairs.push(pair);
  }

  selectedPairs.sort((a, b) => (a.upper.top + a.lower.top) / 2 - (b.upper.top + b.lower.top) / 2);
  for (let index = 1; index < selectedPairs.length; ) {
    const previous = selectedPairs[index - 1];
    const current = selectedPairs[index];
    const previousCenter = (previous.upper.top + previous.lower.top) / 2;
    const currentCenter = (current.upper.top + current.lower.top) / 2;
    if (currentCenter - previousCenter < imageHeight * 0.12) {
      const removeIndex = previous.score < current.score ? index - 1 : index;
      selectedPairs.splice(removeIndex, 1);
      index = Math.max(1, removeIndex);
    } else {
      index += 1;
    }
  }

  const pairedStaves = new Set(selectedPairs.flatMap((pair) => [pair.upper, pair.lower]));
  return pairedStaves.size >= 4 ? sorted.filter((staff) => pairedStaves.has(staff)) : staves;
}

function findStaffSequences(
  centers: Array<{ center: number; strength: number }>,
  slope: number,
  image: BinarySheetImage
): DetectedStaff[] {
  const staves: DetectedStaff[] = [];
  const maxStaffSpacing = Math.min(26, image.height / 20);

  for (let i = 0; i <= centers.length - 5; i += 1) {
    for (let j = i + 1; j < centers.length; j += 1) {
      const spacing = centers[j].center - centers[i].center;
      if (spacing < 3.5) continue;
      if (spacing > maxStaffSpacing) break;

      const lines = [centers[i].center];
      let lastMatchIndex = j;
      for (let step = 1; step < 5; step += 1) {
        const target = centers[i].center + spacing * step;
        let bestIndex = -1;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let k = lastMatchIndex; k < centers.length; k += 1) {
          const distance = Math.abs(centers[k].center - target);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = k;
          }
          if (centers[k].center > target + spacing * 0.6) break;
        }

        if (bestIndex < 0 || bestDistance > Math.max(1.8, spacing * 0.42)) break;
        lines.push(centers[bestIndex].center);
        lastMatchIndex = bestIndex + 1;
      }

      if (lines.length !== 5) continue;

      const actualSpacings = lines.slice(1).map((line, idx) => line - lines[idx]);
      const actualSpacing = actualSpacings.reduce((sum, value) => sum + value, 0) / actualSpacings.length;
      const maxDeviation = Math.max(...actualSpacings.map((value) => Math.abs(value - actualSpacing)));
      if (maxDeviation > Math.max(1.6, actualSpacing * 0.35)) continue;

      const staff = {
        lines,
        spacing: actualSpacing,
        top: lines[0],
        bottom: lines[4],
        slope,
        systemIndex: 0,
        clef: "treble" as const,
      };
      // Projection peaks can form a plausible five-line sequence even when
      // the proposed slope crosses the real staff. Require ink along each
      // proposed line, not merely at its projected intercept.
      const lineSupports = staff.lines.map((line) => {
        let hits = 0;
        for (let x = 0; x < image.width; x += 1) {
          const y = Math.round(lineYAtX(staff, line, x, image.width));
          for (let dy = -1; dy <= 1; dy += 1) {
            const offset = (y + dy) * image.width + x;
            if (y + dy >= 0 && offset < image.dark.length && image.dark[offset]) {
              hits += 1;
              break;
            }
          }
        }
        return hits / image.width;
      });
      if (lineSupports.some((support) => support < 0.25)) continue;
      const supportedStaff: DetectedStaff = { ...staff, support: Math.min(...lineSupports) };
      const overlaps = staves.some((existing) => stavesOverlap(existing, staff));
      if (!overlaps) staves.push(supportedStaff);
      break;
    }
  }

  return staves;
}

export function detectStaves(image: BinarySheetImage): DetectedStaff[] {
  let best: DetectedStaff[] = [];
  for (let slope = -0.14; slope <= 0.141; slope += 0.01) {
    const bins = projectRowsForSlope(image, slope);
    const offset = Math.ceil(Math.abs(slope) * image.width) + 12;
    const centers = lineCentersFromProjection(bins, image.width).map((center) => ({
      ...center,
      center: center.center - offset,
    }));
    const staves = findStaffSequences(centers, slope, image);
    if (staves.length > best.length) {
      best = staves;
    } else if (staves.length === best.length && staves.reduce((sum, staff) => sum + (staff.support ?? 0), 0) > best.reduce((sum, staff) => sum + (staff.support ?? 0), 0)) {
      best = staves;
    }
  }
  const horizontalStaves = findStaffSequences(lineCentersFromRows(image.rowCounts, image.width), 0, image);
  for (const staff of horizontalStaves) {
    const overlaps = best.some((existing) => stavesOverlap(existing, staff));
    if (!overlaps) best.push(staff);
  }

  const bandHeight = Math.max(220, Math.round(image.height * 0.22));
  const bandStep = Math.max(120, Math.round(bandHeight * 0.55));
  for (let minY = 0; minY < image.height; minY += bandStep) {
    const maxY = Math.min(image.height - 1, minY + bandHeight - 1);
    const bandBest: DetectedStaff[] = [];
    const xWindows = [
      [0, image.width - 1],
      [Math.round(image.width * 0.08), Math.round(image.width * 0.58)],
      [Math.round(image.width * 0.25), Math.round(image.width * 0.75)],
      [Math.round(image.width * 0.42), Math.round(image.width * 0.92)],
    ];
    for (const [minX, maxX] of xWindows) {
      let windowBest: DetectedStaff[] = [];
      for (let slope = -0.2; slope <= 0.201; slope += 0.03) {
        const bins = projectBandRowsForSlope(image, slope, minY, maxY, minX, maxX);
        const offset = Math.ceil(Math.abs(slope) * image.width) + 12;
        const centers = lineCentersFromProjection(bins, maxX - minX + 1).map((center) => ({
          ...center,
          center: center.center - offset + minY,
        }));
        // Centers are in full-image coordinates; keep the original height so
        // max staff spacing is not clamped by the band window.
        const staves = findStaffSequences(centers, slope, image);
        if (staves.length > windowBest.length ||
          (staves.length === windowBest.length &&
            staves.reduce((sum, staff) => sum + (staff.support ?? 0), 0) >
            windowBest.reduce((sum, staff) => sum + (staff.support ?? 0), 0))) windowBest = staves;
      }
      for (const staff of windowBest) {
        if (!bandBest.some((existing) => stavesOverlap(existing, staff))) bandBest.push(staff);
      }
    }
    for (const staff of bandBest) {
      const overlaps = best.some((existing) => stavesOverlap(existing, staff));
      if (!overlaps) best.push(staff);
    }
  }

  return assignStaffSystems(selectGrandStaffPairs(best, image.height)
    .sort((a, b) => a.top - b.top)
    .map((staff, index) => ({ ...staff, systemIndex: index })));
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function looksLikeGrandStaffPair(upper: DetectedStaff, lower: DetectedStaff): boolean {
  const averageSpacing = (upper.spacing + lower.spacing) / 2;
  const separationInSpaces = (lower.top - upper.top) / Math.max(1, averageSpacing);
  if (separationInSpaces < 4 || separationInSpaces > 12) return false;
  if (lower.top < upper.bottom - averageSpacing * 0.25) return false;
  const spacingRatio =
    Math.max(upper.spacing, lower.spacing) / Math.max(1, Math.min(upper.spacing, lower.spacing));
  return spacingRatio <= 1.75;
}

function assignStaffSystems(staves: DetectedStaff[]): DetectedStaff[] {
  let assigned: DetectedStaff[];
  if (staves.length === 2 && looksLikeGrandStaffPair(staves[0], staves[1])) {
    assigned = staves.map((staff) => ({ ...staff, systemIndex: 0 }));
  } else if (staves.length < 4) {
    assigned = staves.map((staff, index) => ({ ...staff, systemIndex: index }));
  } else if (staves.length >= 6) {
    assigned = staves.map((staff, index) => ({
      ...staff,
      systemIndex: Math.floor(index / 2),
    }));
  } else {
    const gaps = staves.slice(1).map((staff, index) => staff.top - staves[index].bottom);
    const likelyPairGaps = gaps.filter((_, index) => index % 2 === 0);
    const likelySystemGaps = gaps.filter((_, index) => index % 2 === 1);
    const pairGap = median(likelyPairGaps);
    const systemGap = median(likelySystemGaps);
    const looksLikeGrandStaff = pairGap > 0 && systemGap > 0 && pairGap < systemGap * 0.78;

    assigned = staves.map((staff, index) => ({
      ...staff,
      systemIndex: looksLikeGrandStaff ? Math.floor(index / 2) : index,
    }));
  }

  const stavesPerSystem = new Map<number, DetectedStaff[]>();
  for (const staff of assigned) {
    const system = stavesPerSystem.get(staff.systemIndex) ?? [];
    system.push(staff);
    stavesPerSystem.set(staff.systemIndex, system);
  }

  return assigned.map((staff) => {
    const system = stavesPerSystem.get(staff.systemIndex) ?? [staff];
    const ordered = [...system].sort((a, b) => a.top - b.top);
    return {
      ...staff,
      clef: ordered.length === 2 && ordered[1] === staff ? "bass" : "treble",
    };
  });
}

function suppressThinStaffLinePixels(image: BinarySheetImage, staff: DetectedStaff): Uint8Array {
  const cleaned = image.dark.slice();
  const maxThickness = Math.max(1, Math.round(staff.spacing * 0.28));

  for (let x = 0; x < image.width; x += 1) {
    for (const line of staff.lines) {
      const yMid = Math.round(lineYAtX(staff, line, x, image.width));
      if (yMid < 0 || yMid >= image.height) continue;
      if (!image.dark[yMid * image.width + x]) continue;

      let y0 = yMid;
      let y1 = yMid;
      while (y0 > 0 && image.dark[(y0 - 1) * image.width + x]) y0 -= 1;
      while (y1 < image.height - 1 && image.dark[(y1 + 1) * image.width + x]) y1 += 1;
      if (y1 - y0 + 1 > maxThickness) continue;

      for (let y = y0; y <= y1; y += 1) cleaned[y * image.width + x] = 0;
    }
  }

  return cleaned;
}

function diatonicIndexToMidi(index: number): number {
  const majorSteps = [0, 2, 4, 5, 7, 9, 11];
  const octave = Math.floor(index / 7);
  const degree = ((index % 7) + 7) % 7;
  return 12 + octave * 12 + majorSteps[degree];
}

function pitchFromStaff(y: number, staff: DetectedStaff): number {
  const topLineIndex = staff.clef === "bass" ? 3 * 7 + 5 : 5 * 7 + 3;
  const halfStep = staff.spacing / 2;
  const diatonicOffsetDown = Math.round((y - staff.top) / halfStep);
  return diatonicIndexToMidi(topLineIndex - diatonicOffsetDown);
}

function detectNoteCandidatesInStaff(image: BinarySheetImage, staff: DetectedStaff): NoteCandidate[] {
  const slopeMargin = Math.abs(staff.slope) * image.width;
  const minY = Math.max(0, Math.floor(staff.top - staff.spacing * 2.25 - slopeMargin));
  const maxY = Math.min(image.height - 1, Math.ceil(staff.bottom + staff.spacing * 2.25 + slopeMargin));
  const dark = suppressThinStaffLinePixels(image, staff);
  const visited = new Uint8Array(image.width * image.height);
  const notes: NoteCandidate[] = [];
  const stack: number[] = [];

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const startIdx = y * image.width + x;
      if (visited[startIdx] || !dark[startIdx]) continue;

      let minX = x;
      let maxX = x;
      let compMinY = y;
      let compMaxY = y;
      let sumX = 0;
      let sumY = 0;
      let area = 0;
      stack.push(startIdx);
      visited[startIdx] = 1;

      while (stack.length) {
        const idx = stack.pop() ?? 0;
        const cx = idx % image.width;
        const cy = Math.floor(idx / image.width);

        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        compMinY = Math.min(compMinY, cy);
        compMaxY = Math.max(compMaxY, cy);
        sumX += cx;
        sumY += cy;
        area += 1;

        const neighbors = [idx - 1, idx + 1, idx - image.width, idx + image.width];
        for (const next of neighbors) {
          if (next < 0 || next >= dark.length || visited[next] || !dark[next]) continue;
          const nx = next % image.width;
          const ny = Math.floor(next / image.width);
          if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
          if (ny < minY || ny > maxY) continue;
          visited[next] = 1;
          stack.push(next);
        }
      }

      const compW = maxX - minX + 1;
      const compH = compMaxY - compMinY + 1;
      const density = area / Math.max(1, compW * compH);
      const minWidth = Math.max(3, staff.spacing * 0.35);
      const minHeight = Math.max(3, staff.spacing * 0.28);
      const maxWidth = staff.spacing * 1.4;
      const maxHeight = staff.spacing * 1.35;
      const aspect = compW / Math.max(1, compH);
      const looksLikeNotehead =
        compW >= minWidth &&
        compH >= minHeight &&
        compW <= maxWidth &&
        compH <= maxHeight &&
        aspect >= 0.68 &&
        aspect <= 2.2 &&
        density >= 0.32 &&
        area >= staff.spacing * staff.spacing * 0.1 &&
        area <= staff.spacing * staff.spacing * 0.95;

      if (looksLikeNotehead) {
        const centerX = sumX / area;
        const centerY = sumY / area;
        const staffRelativeY = centerY - staff.slope * (centerX - image.width / 2);
        const inMusicalBand =
          staffRelativeY >= staff.top - staff.spacing * 2.15 &&
          staffRelativeY <= staff.bottom + staff.spacing * 2.15;
        if (!inMusicalBand) continue;
        const midi = Math.max(24, Math.min(96, pitchFromStaff(staffRelativeY, staff)));
        notes.push({
          x: centerX,
          y: centerY,
          midi,
          area,
          staffTop: staff.top,
          staffBottom: staff.bottom,
          systemIndex: staff.systemIndex,
          clef: staff.clef,
          minX,
          minY: compMinY,
          maxX,
          maxY: compMaxY,
        });
      }
    }
  }

  const merged: NoteCandidate[] = [];
  for (const candidate of notes.sort((a, b) => a.x - b.x || a.y - b.y)) {
    const duplicate = merged.find(
      (note) => Math.abs(note.x - candidate.x) < staff.spacing * 0.85 && Math.abs(note.y - candidate.y) < staff.spacing * 0.85
    );
    if (!duplicate) merged.push(candidate);
  }

  return merged.sort((a, b) => a.x - b.x || b.y - a.y);
}

function groupNoteCandidatesIntoEventsWithLayout(
  candidates: NoteCandidate[],
  image: BinarySheetImage
): { events: DetectedSheetNote[]; layout: DetectedSheetNoteLayout[] } {
  if (!candidates.length) return { events: [], layout: [] };

  const systems = [...new Set(candidates.map((candidate) => candidate.systemIndex))].sort((a, b) => a - b);
  const entries: Array<{ event: DetectedSheetNote; layout: DetectedSheetNoteLayout }> = [];
  const systemTicks = WHOLE * 4;
  const systemTops = systems.map((systemIndex) =>
    Math.min(...candidates.filter((candidate) => candidate.systemIndex === systemIndex).map((candidate) => candidate.staffTop))
  );
  const systemGaps = systemTops.slice(1).map((top, index) => top - systemTops[index]).filter((gap) => gap > 0);
  const typicalSystemGap = median(systemGaps);
  const visualSystemOrders: number[] = [0];
  for (let index = 1; index < systems.length; index += 1) {
    const gap = systemTops[index] - systemTops[index - 1];
    const visualGap = typicalSystemGap > 0 ? Math.max(1, Math.round(gap / typicalSystemGap)) : 1;
    visualSystemOrders.push(visualSystemOrders[index - 1] + visualGap);
  }

  for (let systemOrder = 0; systemOrder < systems.length; systemOrder += 1) {
    const systemIndex = systems[systemOrder];
    const systemCandidates = candidates
      .filter(
        (candidate) =>
          candidate.systemIndex === systemIndex &&
          candidate.x >= image.width * 0.08 &&
          candidate.x <= image.width * 0.96
      )
      .sort((a, b) => a.x - b.x || b.y - a.y);
    if (!systemCandidates.length) continue;

    // Align staves within the system: clefs and key signatures offset each
    // staff's first notehead by a different amount. Normalize x so every
    // staff's first notehead maps to the system start; otherwise the hand
    // with the narrower clef gets an earlier downbeat than the other.
    const staffLeftX = new Map<number, number>();
    for (const candidate of systemCandidates) {
      const prev = staffLeftX.get(candidate.staffTop);
      if (prev === undefined || candidate.x < prev) staffLeftX.set(candidate.staffTop, candidate.x);
    }
    const systemLeftX = Math.min(...staffLeftX.values());
    const alignedCandidates = systemCandidates.map((candidate) => ({
      ...candidate,
      x: candidate.x - (staffLeftX.get(candidate.staffTop) ?? systemLeftX) + systemLeftX,
    }));

    const systemTop = Math.min(...alignedCandidates.map((candidate) => candidate.staffTop));
    const systemBottom = Math.max(...alignedCandidates.map((candidate) => candidate.staffBottom));
    const systemSpacing = Math.max(4, (systemBottom - systemTop) / 4);
    const leftX = Math.min(...alignedCandidates.map((candidate) => candidate.x));
    const rightX = Math.max(...alignedCandidates.map((candidate) => candidate.x));
    const usableWidth = Math.max(1, rightX - leftX);
    const musicalCandidates = alignedCandidates.filter(
      (candidate) => candidate.y >= systemTop - systemSpacing * 2.2 && candidate.y <= systemBottom + systemSpacing * 2.6
    );

    const clusters: NoteCandidate[][] = [];
    for (const candidate of musicalCandidates) {
      const current = clusters[clusters.length - 1];
      const last = current?.[current.length - 1];
      const currentStaffHeight = candidate.staffBottom - candidate.staffTop;
      const lastStaffHeight = last ? last.staffBottom - last.staffTop : currentStaffHeight;
      const sameStaff = last ? Math.abs(last.staffTop - candidate.staffTop) < 1 : true;
      const maxSameBeatDistance = Math.max(
        5,
        Math.max(currentStaffHeight, lastStaffHeight) * (sameStaff ? 0.08 : 0.65)
      );
      if (current && last && candidate.x - last.x <= maxSameBeatDistance) {
        current.push(candidate);
      } else {
        clusters.push([candidate]);
      }
    }

    for (const cluster of clusters) {
      const dedupedPitches = [...new Map(cluster.map((candidate) => [candidate.midi, candidate])).values()];
      const limited = dedupedPitches
        .sort((a, b) => b.area - a.area)
        .slice(0, 4)
        .sort((a, b) => a.midi - b.midi);
      const clusterX = cluster.reduce((sum, candidate) => sum + candidate.x, 0) / cluster.length;
      const position = Math.max(0, Math.min(1, (clusterX - leftX) / usableWidth));
      const startTick = visualSystemOrders[systemOrder] * systemTicks + Math.round((position * (systemTicks - QUARTER)) / QUARTER) * QUARTER;

      for (const candidate of limited) {
        entries.push({
          event: {
            midi: candidate.midi,
            startTick,
            durationTicks: QUARTER,
            velocity: candidate.clef === "bass" ? VELOCITY_LH : VELOCITY_RH,
            channel: candidate.clef === "bass" ? 1 : 0,
          },
          layout: {
            midi: candidate.midi,
            startTick,
            durationTicks: QUARTER,
            bbox: {
              x: candidate.minX,
              y: candidate.minY,
              w: candidate.maxX - candidate.minX + 1,
              h: candidate.maxY - candidate.minY + 1,
            },
          },
        });
      }
    }
  }

  // Deduplicate notes and layout in lockstep so layout[i] always describes events[i].
  const uniqueEntries = [
    ...new Map(entries.map((entry) => [`${entry.event.startTick}:${entry.event.midi}`, entry])).values(),
  ];
  const sliced = uniqueEntries.slice(0, Math.max(1, Math.floor(image.width * 0.35)));
  return { events: sliced.map((entry) => entry.event), layout: sliced.map((entry) => entry.layout) };
}

function groupNoteCandidatesIntoEvents(candidates: NoteCandidate[], image: BinarySheetImage): DetectedSheetNote[] {
  return groupNoteCandidatesIntoEventsWithLayout(candidates, image).events;
}

export interface TranscribedSheetMusicLayout {
  notes: DetectedSheetNote[];
  /** Bounding boxes in the input image's coordinates; layout[i] describes notes[i]. */
  layout: DetectedSheetNoteLayout[];
  warnings: string[];
}

export function transcribeSheetImageWithLayout(image: BinarySheetImage): TranscribedSheetMusicLayout {
  const warnings: string[] = [];

  // Estimate page skew and shear it away so staff detection runs on
  // horizontal staves. Layout boxes are mapped back below. Only significant
  // skew is corrected: the detector natively handles mild tilt, and a global
  // shear can hurt pages with varying (perspective) skew.
  const skew = estimateStaffSkew(image);
  const deskewed =
    Math.abs(skew.slope) >= 0.08
      ? deskewBinaryImage(image, skew.slope)
      : { image, slope: 0, yOffset: 0 };

  const staves = detectStaves(deskewed.image);
  if (!staves.length) return { notes: [], layout: [], warnings: ["No five-line staff was detected in the image."] };

  const candidates = staves.flatMap((staff) => detectNoteCandidatesInStaff(deskewed.image, staff));
  const { events, layout } = groupNoteCandidatesIntoEventsWithLayout(candidates, deskewed.image);
  if (!events.length) {
    return {
      notes: [],
      layout: [],
      warnings: [`Detected ${staves.length} staff group${staves.length === 1 ? "" : "s"}, but no noteheads were clear enough to import.`],
    };
  }

  // Map boxes back through the deskew shear into the caller's coordinates.
  // The shear only shifts rows vertically, so x/w are unchanged.
  const mappedLayout =
    deskewed.slope === 0
      ? layout
      : layout.map((entry) => {
          const centerX = entry.bbox.x + entry.bbox.w / 2;
          const y = deskewInverseY(deskewed, centerX, entry.bbox.y);
          return { ...entry, bbox: { ...entry.bbox, y } };
        });

  warnings.push(
    `Detected ${staves.length} staff group${staves.length === 1 ? "" : "s"}, ${candidates.length} notehead candidate${
      candidates.length === 1 ? "" : "s"
    }, and imported ${events.length} MIDI note${events.length === 1 ? "" : "s"}. Treble/bass grand-staff clefs and quarter-note timing were assumed.`
  );
  return { notes: events, layout: mappedLayout, warnings };
}

export function transcribeSheetImage(image: BinarySheetImage): { notes: DetectedSheetNote[]; warnings: string[] } {
  const { notes, warnings } = transcribeSheetImageWithLayout(image);
  return { notes, warnings };
}

function addRepeatingBass(track: MidiTrackBuilder, bar: number, notes: string[]): void {
  const start = bar * WHOLE;
  notes.forEach((pitch, index) => {
    track.addNote(start + index * QUARTER, 1, note(pitch), QUARTER, VELOCITY_LH);
  });
}

function addRhHits(track: MidiTrackBuilder, bar: number, hits: Array<[number, string[], number]>): void {
  const start = bar * WHOLE;
  for (const [beat, pitches, beats] of hits) {
    track.addChord(
      start + Math.trunc((beat - 1) * QUARTER),
      0,
      pitches.map(note),
      Math.trunc(beats * QUARTER),
      VELOCITY_RH
    );
  }
}

function addRhLine(track: MidiTrackBuilder, bar: number, notes: Array<[number, string, number]>): void {
  const start = bar * WHOLE;
  for (const [beat, pitch, beats] of notes) {
    track.addNote(
      start + Math.trunc((beat - 1) * QUARTER),
      0,
      note(pitch),
      Math.trunc(beats * QUARTER),
      VELOCITY_RH + 8
    );
  }
}

export function buildSwedenSheetMusicMidi(): ArrayBuffer {
  const conductor = new MidiTrackBuilder();
  const piano = new MidiTrackBuilder();

  conductor.meta(0, 0x03, ascii("Sweden - photo transcription"));
  conductor.meta(0, 0x51, tempoPayload(46));
  conductor.meta(0, 0x58, [4, 2, 24, 8]);
  conductor.meta(0, 0x59, [2, 0]);

  piano.push(0, [0xc0, 0]);
  piano.push(0, [0xc1, 0]);

  const bassPatterns = [
    ["D2", "A2", "F#3", "A2"],
    ["B1", "F#2", "D3", "F#2"],
    ["G1", "D2", "B2", "D2"],
    ["D2", "A2", "F#3", "A2"],
    ["D2", "A2", "F#3", "A2"],
    ["B1", "F#2", "D3", "F#2"],
    ["G1", "D2", "B2", "D2"],
    ["D2", "A2", "F#3", "A2"],
    ["D2", "A2", "F#3", "A2"],
    ["B1", "F#2", "D3", "F#2"],
    ["G1", "D2", "B2", "D2"],
    ["D2", "A2", "F#3", "A2"],
    ["D2", "A2", "F#3", "A2"],
    ["B1", "F#2", "D3", "F#2"],
    ["G1", "D2", "B2", "D2"],
    ["D2", "A2", "F#3", "A2"],
  ];

  bassPatterns.forEach((pattern, bar) => addRepeatingBass(piano, bar, pattern));

  const chordHits: Array<Array<[number, string[], number]>> = [
    [[1, ["D4", "F#4", "A4"], 2], [3, ["D4", "F#4", "A4"], 2]],
    [[1, ["B3", "D4", "F#4"], 2], [3, ["B3", "D4", "F#4"], 2]],
    [[1, ["G3", "B3", "D4"], 2], [3, ["G3", "B3", "D4"], 2]],
    [[1, ["D4", "F#4", "A4"], 2], [3, ["D4", "F#4", "A4"], 2]],
    [[1, ["D4", "F#4", "A4"], 2], [3, ["B3", "D4", "F#4"], 2]],
    [[1, ["B3", "D4", "F#4"], 2], [3, ["G3", "B3", "D4"], 2]],
    [[1, ["G3", "B3", "D4"], 2], [3, ["A3", "D4", "F#4"], 2]],
    [[1, ["D4", "F#4", "A4"], 2], [3, ["D4", "F#4", "A4"], 2]],
    [[1, ["D4", "F#4", "A4"], 1], [3, ["B3", "D4", "F#4"], 1]],
    [[1, ["B3", "D4", "F#4"], 2], [3, ["G3", "B3", "D4"], 1]],
    [[1, ["G3", "B3", "D4"], 2], [3, ["A3", "D4", "F#4"], 1]],
    [[1, ["D4", "F#4", "A4"], 1], [3, ["D4", "F#4", "A4"], 1]],
    [[1, ["D4", "F#4", "A4"], 1], [3, ["B3", "D4", "F#4"], 1]],
    [[1, ["B3", "D4", "F#4"], 2], [3, ["G3", "B3", "D4"], 1]],
    [[1, ["G3", "B3", "D4"], 2], [3, ["A3", "D4", "F#4"], 1]],
    [[1, ["D4", "F#4", "A4"], 2], [3, ["D4", "F#4", "A4"], 2]],
  ];

  chordHits.forEach((hits, bar) => addRhHits(piano, bar, hits));

  const melody = new Map<number, Array<[number, string, number]>>([
    [6, [[3, "F#4", 0.5], [3.5, "A4", 0.5], [4, "B4", 1]]],
    [7, [[2, "A4", 0.5], [2.5, "F#4", 0.5], [4, "E4", 1]]],
    [8, [[1, "F#4", 0.5], [1.5, "A4", 0.5], [2, "B4", 0.5], [2.5, "A4", 0.5]]],
    [9, [[3, "F#4", 0.5], [3.5, "E4", 0.5], [4, "D4", 1]]],
    [10, [[3, "F#4", 0.5], [3.5, "A4", 0.5], [4, "B4", 1]]],
    [11, [[1, "A4", 0.5], [1.5, "F#4", 0.5], [2, "D4", 1], [3, "E4", 0.5], [3.5, "F#4", 0.5]]],
    [12, [[1, "F#4", 0.5], [1.5, "A4", 0.5], [2, "B4", 1]]],
    [13, [[1, "A4", 0.5], [1.5, "F#4", 0.5], [3, "F#4", 0.5], [3.5, "A4", 0.5]]],
    [14, [[3, "F#4", 0.5], [3.5, "A4", 0.5], [4, "B4", 1]]],
    [15, [[1, "A4", 0.5], [1.5, "F#4", 0.5], [3, "E4", 0.5], [3.5, "F#4", 0.5]]],
  ]);

  for (const [bar, notes] of melody) addRhLine(piano, bar, notes);

  const tracks = [conductor.render(), piano.render()];
  return makeMidiArrayBuffer(tracks);
}

export async function parseSheetMusicWithLayout(file: File): Promise<ParsedSheetMusicWithLayout> {
  if (!isSupportedSheetMusicImageFile(file)) {
    throw new Error("Choose a JPG or PNG image file of sheet music.");
  }

  let decoded: DecodedSheetImage | null = null;
  try {
    decoded = await decodeSheetImage(file);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Image decoding failed (${message}). Choose a readable JPG or PNG image.`);
  }

  if (!decoded) throw new Error("Image recognition is unavailable in this browser.");

  const warnings = analyzeSheetImageQuality(
    decoded.luminance,
    decoded.image.width,
    decoded.image.height,
    decoded.sourceWidth,
    decoded.sourceHeight
  );
  const result = transcribeSheetImageWithLayout(decoded.image);
  warnings.push(...result.warnings);

  if (!result.notes.length) {
    throw new Error(`${warnings.join(" ")} Try a clearer image showing the complete staff.`);
  }

  const midiData = buildDetectedSheetMusicMidi(result.notes, basenameWithoutExtension(file.name));
  // The analysis ran on a downscaled working image; map boxes back to source pixels.
  const scaleX = decoded.image.width / decoded.sourceWidth;
  const scaleY = decoded.image.height / decoded.sourceHeight;
  const secondsPerTick = 60 / (TRANSCRIPTION_BPM * QUARTER);
  const noteLayout: SheetMusicNoteLayout[] = result.layout.map((entry) => ({
    pitch: entry.midi,
    startSec: entry.startTick * secondsPerTick,
    endSec: (entry.startTick + entry.durationTicks) * secondsPerTick,
    bbox: {
      x: entry.bbox.x / scaleX,
      y: entry.bbox.y / scaleY,
      w: entry.bbox.w / scaleX,
      h: entry.bbox.h / scaleY,
    },
  }));

  return {
    midiData,
    fileName: `${basenameWithoutExtension(file.name)}-scan.mid`,
    warnings,
    imageWidth: decoded.sourceWidth,
    imageHeight: decoded.sourceHeight,
    noteLayout,
  };
}

export async function parseSheetMusicToMidi(file: File): Promise<ParsedSheetMusicMidi> {
  const { midiData, fileName, warnings } = await parseSheetMusicWithLayout(file);
  return { midiData, fileName, warnings };
}
