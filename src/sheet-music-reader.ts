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
  const header = [...ascii("MThd"), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(TICKS_PER_QUARTER)];
  const bytes = concatBytes([header, ...tracks]);
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

export async function parseSheetMusicToMidi(file: File): Promise<ParsedSheetMusicMidi> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose a camera photo or image file of sheet music.");
  }

  await file.arrayBuffer();

  return {
    midiData: buildSwedenSheetMusicMidi(),
    fileName: "scanned-sheet-demo-sweden.mid",
    warnings: ["Sheet music image recognition is not implemented yet; loaded the bundled Sweden transcription demo."],
  };
}
