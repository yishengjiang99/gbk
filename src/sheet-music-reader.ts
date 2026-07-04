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
}

export interface DetectedSheetNote {
  midi: number;
  startTick: number;
  durationTicks: number;
  velocity: number;
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
  conductor.meta(0, 0x51, tempoPayload(92));
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

  return makeMidiArrayBuffer([conductor.render(), melody.render()]);
}

function basenameWithoutExtension(name: string): string {
  return (name || "sheet-music").replace(/\.[^.]*$/, "") || "sheet-music";
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

function detectStaves(image: BinarySheetImage): DetectedStaff[] {
  const rowThreshold = Math.max(12, Math.round(image.width * 0.22));
  const candidateRows: number[] = [];
  for (let y = 0; y < image.height; y += 1) {
    if (image.rowCounts[y] >= rowThreshold) candidateRows.push(y);
  }

  const lineCenters = groupConsecutiveRows(candidateRows)
    .map((group) => group.reduce((sum, y) => sum + y, 0) / group.length)
    .filter((center, index, all) => index === 0 || center - all[index - 1] > 2);

  const staves: DetectedStaff[] = [];
  for (let i = 0; i <= lineCenters.length - 5; i += 1) {
    const lines = lineCenters.slice(i, i + 5);
    const spacings = lines.slice(1).map((line, idx) => line - lines[idx]);
    const spacing = spacings.reduce((sum, value) => sum + value, 0) / spacings.length;
    const maxDeviation = Math.max(...spacings.map((value) => Math.abs(value - spacing)));
    if (spacing < 4 || spacing > 60 || maxDeviation > spacing * 0.35) continue;

    const overlaps = staves.some((staff) => Math.abs(staff.top - lines[0]) < spacing * 2);
    if (!overlaps) {
      staves.push({
        lines,
        spacing,
        top: lines[0],
        bottom: lines[4],
      });
    }
    i += 4;
  }

  return staves;
}

function isNearStaffLine(y: number, staff: DetectedStaff): boolean {
  return staff.lines.some((line) => Math.abs(y - line) <= Math.max(1, staff.spacing * 0.12));
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

function detectNotesInStaff(image: BinarySheetImage, staff: DetectedStaff): DetectedSheetNote[] {
  const minY = Math.max(0, Math.floor(staff.top - staff.spacing * 2.2));
  const maxY = Math.min(image.height - 1, Math.ceil(staff.bottom + staff.spacing * 2.2));
  const visited = new Uint8Array(image.width * image.height);
  const notes: Array<{ x: number; y: number; midi: number; area: number }> = [];
  const stack: number[] = [];

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const startIdx = y * image.width + x;
      if (visited[startIdx] || !image.dark[startIdx] || isNearStaffLine(y, staff)) continue;

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
          if (ny < minY || ny > maxY || isNearStaffLine(ny, staff)) continue;
          visited[next] = 1;
          stack.push(next);
        }
      }

      const compW = maxX - minX + 1;
      const compH = compMaxY - compMinY + 1;
      const density = area / Math.max(1, compW * compH);
      const minSize = staff.spacing * 0.45;
      const maxWidth = staff.spacing * 2.4;
      const maxHeight = staff.spacing * 2.2;
      const looksLikeNotehead =
        compW >= minSize &&
        compH >= minSize &&
        compW <= maxWidth &&
        compH <= maxHeight &&
        density >= 0.18 &&
        area >= staff.spacing * staff.spacing * 0.18;

      if (looksLikeNotehead) {
        const centerX = sumX / area;
        const centerY = sumY / area;
        const midi = Math.max(36, Math.min(96, pitchFromTrebleStaff(centerY, staff)));
        notes.push({ x: centerX, y: centerY, midi, area });
      }
    }
  }

  const merged: typeof notes = [];
  for (const candidate of notes.sort((a, b) => a.x - b.x || a.y - b.y)) {
    const duplicate = merged.find(
      (note) => Math.abs(note.x - candidate.x) < staff.spacing * 0.85 && Math.abs(note.y - candidate.y) < staff.spacing * 0.85
    );
    if (!duplicate) merged.push(candidate);
  }

  return merged
    .sort((a, b) => a.x - b.x || b.y - a.y)
    .slice(0, 96)
    .map((candidate, index) => ({
      midi: candidate.midi,
      startTick: index * QUARTER,
      durationTicks: QUARTER,
      velocity: 78,
    }));
}

function transcribeSheetImage(image: BinarySheetImage): { notes: DetectedSheetNote[]; warnings: string[] } {
  const warnings: string[] = [];
  const staves = detectStaves(image);
  if (!staves.length) return { notes: [], warnings: ["No five-line staff was detected in the image."] };

  const notes = staves.flatMap((staff) => detectNotesInStaff(image, staff));
  if (!notes.length) {
    return {
      notes: [],
      warnings: [`Detected ${staves.length} staff group${staves.length === 1 ? "" : "s"}, but no noteheads were clear enough to import.`],
    };
  }

  warnings.push(
    `Detected ${staves.length} staff group${staves.length === 1 ? "" : "s"} and ${notes.length} note candidate${
      notes.length === 1 ? "" : "s"
    }. Treble clef and quarter-note timing were assumed.`
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
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose a camera photo or image file of sheet music.");
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
