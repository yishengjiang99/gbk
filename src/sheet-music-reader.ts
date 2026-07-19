const TICKS_PER_QUARTER = 480;
const QUARTER = TICKS_PER_QUARTER;
const WHOLE = TICKS_PER_QUARTER * 4;
const VELOCITY_RH = 62;
const VELOCITY_LH = 50;

const NOTE_BASE: Record<string, number> = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
};

export interface ParsedSheetMusicMidi {
  midiData: ArrayBuffer;
  fileName: string;
  warnings: string[];
}

interface BinarySheetImage {
  width: number;
  height: number;
  dark: Uint8Array;
  rowCounts: Uint16Array;
}

interface DetectedStaff {
  lines: number[];
  spacing: number;
  top: number;
  bottom: number;
  slope: number;
  systemIndex: number;
}

export interface DetectedSheetNote {
  midi: number;
  startTick: number;
  durationTicks: number;
  velocity: number;
}

interface NoteCandidate {
  x: number;
  y: number;
  midi: number;
  area: number;
  staffTop: number;
  staffBottom: number;
  systemIndex: number;
}

function note(name: string): number {
  const match = /^([A-G](?:#|b)?)(-?\d+)$/.exec(name);
  if (!match) throw new Error(`Invalid note name: ${name}`);

  const [, pitch, octaveText] = match;
  return 12 * (Number(octaveText) + 1) + NOTE_BASE[pitch];
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
  conductor.meta(0, 0x51, tempoPayload(46));
  conductor.meta(0, 0x58, [4, 2, 24, 8]);

  melody.push(0, [0xc0, 0]);
  for (const noteEvent of notes) {
    melody.addNote(
      Math.max(0, Math.trunc(noteEvent.startTick)),
      0,
      Math.max(0, Math.min(127, Math.trunc(noteEvent.midi))),
      Math.max(QUARTER / 4, Math.trunc(noteEvent.durationTicks)),
      Math.max(1, Math.min(127, Math.trunc(noteEvent.velocity)))
    );
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
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  const hasSupportedExtension = /\.(?:jpe?g|png)$/.test(name);

  if (type) return type === "image/jpeg" || type === "image/png";
  return hasSupportedExtension;
}

function canUseBrowserImagePipeline(): boolean {
  return typeof createImageBitmap === "function" && typeof document !== "undefined";
}

function otsuThreshold(values: Uint8ClampedArray): number {
  const histogram = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < values.length; i += 4) {
    const r = values[i];
    const g = values[i + 1];
    const b = values[i + 2];
    const luminance = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    histogram[luminance] += 1;
    total += 1;
  }

  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];

  let sumBackground = 0;
  let weightBackground = 0;
  let bestThreshold = 150;
  let bestVariance = 0;

  for (let i = 0; i < 256; i += 1) {
    weightBackground += histogram[i];
    if (!weightBackground) continue;

    const weightForeground = total - weightBackground;
    if (!weightForeground) break;

    sumBackground += i * histogram[i];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const betweenVariance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (betweenVariance > bestVariance) {
      bestVariance = betweenVariance;
      bestThreshold = i;
    }
  }

  return Math.max(80, Math.min(190, bestThreshold - 12));
}

async function decodeSheetImage(file: File): Promise<BinarySheetImage | null> {
  if (!canUseBrowserImagePipeline()) return null;

  const bitmap = await createImageBitmap(file);
  const maxSide = 1800;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const pixels = ctx.getImageData(0, 0, width, height).data;
  const threshold = otsuThreshold(pixels);
  const dark = new Uint8Array(width * height);
  const rowCounts = new Uint16Array(height);

  for (let y = 0; y < height; y += 1) {
    let count = 0;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const luminance = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
      if (luminance <= threshold) {
        dark[y * width + x] = 1;
        count += 1;
      }
    }
    rowCounts[y] = count;
  }

  return { width, height, dark, rowCounts };
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

function lineYAtX(staff: DetectedStaff, line: number, x: number, width: number): number {
  return line + staff.slope * (x - width / 2);
}

function projectRowsForSlope(image: BinarySheetImage, slope: number): Uint16Array {
  const extra = Math.ceil(Math.abs(slope) * image.width) + 12;
  const bins = new Uint16Array(image.height + extra * 2);
  const offset = extra;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (!image.dark[y * image.width + x]) continue;
      const projectedY = Math.round(y - slope * (x - image.width / 2)) + offset;
      if (projectedY >= 0 && projectedY < bins.length) bins[projectedY] += 1;
    }
  }

  return bins;
}

function projectBandRowsForSlope(image: BinarySheetImage, slope: number, minY: number, maxY: number): Uint16Array {
  const bandHeight = Math.max(1, maxY - minY + 1);
  const extra = Math.ceil(Math.abs(slope) * image.width) + 12;
  const bins = new Uint16Array(bandHeight + extra * 2);
  const offset = extra;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
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
      };
      const overlaps = staves.some((existing) => Math.abs(existing.top - staff.top) < actualSpacing * 3);
      if (!overlaps) staves.push(staff);
      break;
    }
  }

  return staves;
}

function detectStaves(image: BinarySheetImage): DetectedStaff[] {
  let best: DetectedStaff[] = [];
  for (let slope = -0.14; slope <= 0.141; slope += 0.02) {
    const bins = projectRowsForSlope(image, slope);
    const offset = Math.ceil(Math.abs(slope) * image.width) + 12;
    const centers = lineCentersFromProjection(bins, image.width).map((center) => ({
      ...center,
      center: center.center - offset,
    }));
    const staves = findStaffSequences(centers, slope, image);
    if (staves.length > best.length) {
      best = staves;
    } else if (staves.length === best.length && staves.reduce((sum, staff) => sum + staff.spacing, 0) > best.reduce((sum, staff) => sum + staff.spacing, 0)) {
      best = staves;
    }
  }
  const horizontalStaves = findStaffSequences(lineCentersFromRows(image.rowCounts, image.width), 0, image);
  for (const staff of horizontalStaves) {
    const overlaps = best.some((existing) => Math.abs(existing.top - staff.top) < Math.max(existing.spacing, staff.spacing) * 3);
    if (!overlaps) best.push(staff);
  }

  const bandHeight = Math.max(220, Math.round(image.height * 0.22));
  const bandStep = Math.max(120, Math.round(bandHeight * 0.55));
  for (let minY = 0; minY < image.height; minY += bandStep) {
    const maxY = Math.min(image.height - 1, minY + bandHeight - 1);
    const bandImage = { ...image, height: maxY - minY + 1 };
    let bandBest: DetectedStaff[] = [];
    for (let slope = -0.2; slope <= 0.201; slope += 0.03) {
      const bins = projectBandRowsForSlope(image, slope, minY, maxY);
      const offset = Math.ceil(Math.abs(slope) * image.width) + 12;
      const centers = lineCentersFromProjection(bins, image.width).map((center) => ({
        ...center,
        center: center.center - offset + minY,
      }));
      const staves = findStaffSequences(centers, slope, bandImage);
      if (staves.length > bandBest.length) bandBest = staves;
    }
    for (const staff of bandBest) {
      const overlaps = best.some((existing) => Math.abs(existing.top - staff.top) < Math.max(existing.spacing, staff.spacing) * 3);
      if (!overlaps) best.push(staff);
    }
  }

  return assignStaffSystems(best
    .sort((a, b) => a.top - b.top)
    .map((staff, index) => ({ ...staff, systemIndex: index })));
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function assignStaffSystems(staves: DetectedStaff[]): DetectedStaff[] {
  if (staves.length < 4) return staves.map((staff, index) => ({ ...staff, systemIndex: index }));
  if (staves.length >= 6) {
    return staves.map((staff, index) => ({
      ...staff,
      systemIndex: Math.floor(index / 2),
    }));
  }

  const gaps = staves.slice(1).map((staff, index) => staff.top - staves[index].bottom);
  const likelyPairGaps = gaps.filter((_, index) => index % 2 === 0);
  const likelySystemGaps = gaps.filter((_, index) => index % 2 === 1);
  const pairGap = median(likelyPairGaps);
  const systemGap = median(likelySystemGaps);
  const looksLikeGrandStaff = pairGap > 0 && systemGap > 0 && pairGap < systemGap * 0.78;

  if (!looksLikeGrandStaff) return staves.map((staff, index) => ({ ...staff, systemIndex: index }));

  return staves.map((staff, index) => ({
    ...staff,
    systemIndex: Math.floor(index / 2),
  }));
}

function isNearStaffLine(x: number, y: number, staff: DetectedStaff, width: number): boolean {
  return staff.lines.some((line) => Math.abs(y - lineYAtX(staff, line, x, width)) <= Math.max(1, staff.spacing * 0.22));
}

function diatonicIndexToMidi(index: number): number {
  const majorSteps = [0, 2, 4, 5, 7, 9, 11];
  const octave = Math.floor(index / 7);
  const degree = ((index % 7) + 7) % 7;
  return 12 + octave * 12 + majorSteps[degree];
}

function pitchFromTrebleStaff(y: number, staff: DetectedStaff): number {
  const topLineF5Index = 5 * 7 + 3;
  const halfStep = staff.spacing / 2;
  const diatonicOffsetDown = Math.round((y - staff.top) / halfStep);
  return diatonicIndexToMidi(topLineF5Index - diatonicOffsetDown);
}

function detectNoteCandidatesInStaff(image: BinarySheetImage, staff: DetectedStaff): NoteCandidate[] {
  const slopeMargin = Math.abs(staff.slope) * image.width;
  const minY = Math.max(0, Math.floor(staff.top - staff.spacing * 1.45 - slopeMargin));
  const maxY = Math.min(image.height - 1, Math.ceil(staff.bottom + staff.spacing * 1.05 + slopeMargin));
  const visited = new Uint8Array(image.width * image.height);
  const notes: NoteCandidate[] = [];
  const stack: number[] = [];

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const startIdx = y * image.width + x;
      if (visited[startIdx] || !image.dark[startIdx] || isNearStaffLine(x, y, staff, image.width)) continue;

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
          if (next < 0 || next >= image.dark.length || visited[next] || !image.dark[next]) continue;
          const nx = next % image.width;
          const ny = Math.floor(next / image.width);
          if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
          if (ny < minY || ny > maxY || isNearStaffLine(nx, ny, staff, image.width)) continue;
          visited[next] = 1;
          stack.push(next);
        }
      }

      const compW = maxX - minX + 1;
      const compH = compMaxY - compMinY + 1;
      const density = area / Math.max(1, compW * compH);
      const minWidth = Math.max(3, staff.spacing * 0.35);
      const minHeight = Math.max(3, staff.spacing * 0.28);
      const maxWidth = staff.spacing * 1.15;
      const maxHeight = staff.spacing * 0.95;
      const aspect = compW / Math.max(1, compH);
      const looksLikeNotehead =
        compW >= minWidth &&
        compH >= minHeight &&
        compW <= maxWidth &&
        compH <= maxHeight &&
        aspect >= 0.68 &&
        aspect <= 2.05 &&
        density >= 0.32 &&
        area >= staff.spacing * staff.spacing * 0.1 &&
        area <= staff.spacing * staff.spacing * 0.85;

      if (looksLikeNotehead) {
        const centerX = sumX / area;
        const centerY = sumY / area;
        const staffRelativeY = centerY - staff.slope * (centerX - image.width / 2);
        const inMusicalBand =
          staffRelativeY >= staff.top - staff.spacing * 1.35 &&
          staffRelativeY <= staff.bottom + staff.spacing * 0.95;
        if (!inMusicalBand) continue;
        const midi = Math.max(36, Math.min(96, pitchFromTrebleStaff(staffRelativeY, staff)));
        notes.push({
          x: centerX,
          y: centerY,
          midi,
          area,
          staffTop: staff.top,
          staffBottom: staff.bottom,
          systemIndex: staff.systemIndex,
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

function groupNoteCandidatesIntoEvents(candidates: NoteCandidate[], image: BinarySheetImage): DetectedSheetNote[] {
  if (!candidates.length) return [];

  const systems = [...new Set(candidates.map((candidate) => candidate.systemIndex))].sort((a, b) => a - b);
  const events: DetectedSheetNote[] = [];
  const systemTicks = WHOLE * 4;

  for (let systemOrder = 0; systemOrder < systems.length; systemOrder += 1) {
    const systemIndex = systems[systemOrder];
    const systemCandidates = candidates
      .filter((candidate) => candidate.systemIndex === systemIndex)
      .sort((a, b) => a.x - b.x || b.y - a.y);
    if (!systemCandidates.length) continue;

    const systemTop = Math.min(...systemCandidates.map((candidate) => candidate.staffTop));
    const systemBottom = Math.max(...systemCandidates.map((candidate) => candidate.staffBottom));
    const systemSpacing = Math.max(4, (systemBottom - systemTop) / 4);
    const leftX = Math.min(...systemCandidates.map((candidate) => candidate.x));
    const rightX = Math.max(...systemCandidates.map((candidate) => candidate.x));
    const usableWidth = Math.max(1, rightX - leftX);
    const musicalCandidates = systemCandidates.filter(
      (candidate) => candidate.y >= systemTop - systemSpacing * 2.2 && candidate.y <= systemBottom + systemSpacing * 2.6
    );

    const clusters: NoteCandidate[][] = [];
    for (const candidate of musicalCandidates) {
      const current = clusters[clusters.length - 1];
      const last = current?.[current.length - 1];
      const maxSameBeatDistance = Math.max(5, (candidate.staffBottom - candidate.staffTop) * 0.08);
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
      const startTick = systemOrder * systemTicks + Math.round((position * (systemTicks - QUARTER)) / QUARTER) * QUARTER;

      for (const candidate of limited) {
        events.push({
          midi: candidate.midi,
          startTick,
          durationTicks: QUARTER,
          velocity: 78,
        });
      }
    }
  }

  return events.slice(0, Math.max(1, Math.floor(image.width * 0.35)));
}

function transcribeSheetImage(image: BinarySheetImage): { notes: DetectedSheetNote[]; warnings: string[] } {
  const warnings: string[] = [];
  const staves = detectStaves(image);
  if (!staves.length) return { notes: [], warnings: ["No five-line staff was detected in the image."] };

  const candidates = staves.flatMap((staff) => detectNoteCandidatesInStaff(image, staff));
  const notes = groupNoteCandidatesIntoEvents(candidates, image);
  if (!notes.length) {
    return {
      notes: [],
      warnings: [`Detected ${staves.length} staff group${staves.length === 1 ? "" : "s"}, but no noteheads were clear enough to import.`],
    };
  }

  warnings.push(
    `Detected ${staves.length} staff group${staves.length === 1 ? "" : "s"}, ${candidates.length} notehead candidate${
      candidates.length === 1 ? "" : "s"
    }, and imported ${notes.length} MIDI note${notes.length === 1 ? "" : "s"}. Treble clef and quarter-note timing were assumed.`
  );
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

export async function parseSheetMusicToMidi(file: File): Promise<ParsedSheetMusicMidi> {
  if (!isSupportedSheetMusicImageFile(file)) {
    throw new Error("Choose a JPG or PNG image file of sheet music.");
  }

  const fallback = (): ParsedSheetMusicMidi => ({
    midiData: buildSwedenSheetMusicMidi(),
    fileName: "scanned-sheet-demo-sweden.mid",
    warnings: ["Could not run image recognition for this file; loaded the bundled Sweden transcription demo."],
  });

  let image: BinarySheetImage | null = null;
  try {
    image = await decodeSheetImage(file);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...fallback(),
      warnings: [`Image decoding failed (${message}); loaded the bundled Sweden transcription demo.`],
    };
  }

  if (!image) return fallback();

  const result = transcribeSheetImage(image);
  if (!result.notes.length) {
    return {
      ...fallback(),
      warnings: [...result.warnings, "Loaded the bundled Sweden transcription demo instead."],
    };
  }

  return {
    midiData: buildDetectedSheetMusicMidi(result.notes, basenameWithoutExtension(file.name)),
    fileName: `${basenameWithoutExtension(file.name)}-scan.mid`,
    warnings: result.warnings,
  };
}
