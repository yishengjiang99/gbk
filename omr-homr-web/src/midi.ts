/*
 * Decoded homr symbols -> Standard MIDI File (format 1, 480 ticks/quarter).
 * Part of omr-homr-web, licensed under AGPL-3.0-only. See NOTICE.
 *
 * The emitted file matches exactly what gbk's midi-timer.worker.ts parses:
 * noteOn/noteOff, program change, tempo + time-signature meta events, and a
 * metrical (non-SMPTE) division. Track layout mirrors the existing
 * buildDetectedSheetMusicMidi convention: a conductor track plus one track
 * per staff.
 *
 * Token semantics (from homr/transformer/vocabulary.py + music_xml_generator.py):
 * - pitch "C4" is scientific pitch notation, C4 = MIDI 60; lift "#" / "b"
 *   adjust by semitones.
 * - rhythm "note_4" is a kern duration: 4 = quarter -> 480 ticks. Each dot
 *   adds half the previous value (x1.5, x1.75). "G" suffix = grace note:
 *   short, does not advance the time cursor.
 * - a "chord" rhythm token means the next symbol shares the previous onset
 *   (port of sort_token_chords in vocabulary.py).
 * - rests advance the cursor; barlines/clefs/key/time signatures do not.
 */
import type { DecodedSymbol } from "./vocab.js";

export const TICKS_PER_QUARTER = 480;
export const SCAN_TEMPO_BPM = 72;
export const SCAN_VELOCITY = 84;

export interface MidiNoteEvent {
  tick: number;
  midi: number;
  durationTicks: number;
  staff: number;
  /** Attention-derived coarse position in staff-crop pixels, if available. */
  attention: [number, number] | null;
}

export interface StaffMidiResult {
  midi: Uint8Array;
  noteEvents: MidiNoteEvent[];
  staffCount: number;
  warnings: string[];
}

const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const LIFT_OFFSET: Record<string, number> = { "#": 1, "##": 2, N: 0, b: -1, bb: -2, _: 0 };

/** "C4" + "#" -> 61. Returns null for non-note pitches. */
export function pitchToMidi(pitch: string, lift: string): number | null {
  if (pitch === "." || pitch === "_") return null;
  const m = /^([A-G])(\d+)$/.exec(pitch);
  if (!m) return null;
  const midi = 12 + parseInt(m[2], 10) * 12 + SEMITONES[m[1]] + (LIFT_OFFSET[lift] ?? 0);
  return midi >= 0 && midi <= 127 ? midi : null;
}

export interface KernDuration {
  ticks: number;
  /** True for grace notes: sound briefly, do not advance the cursor. */
  grace: boolean;
  isRest: boolean;
}

/** "note_4.", "rest_8", "note_16G" -> ticks at 480 TPQ. Null for non-durations. */
export function parseKernDuration(rhythm: string): KernDuration | null {
  const m = /^(note|rest)_(\d+)(G?)(\.{0,2})$/.exec(rhythm);
  if (!m) return null;
  const denom = parseInt(m[2], 10);
  if (denom <= 0) return null;
  let ticks = Math.round((TICKS_PER_QUARTER * 4) / denom);
  if (m[4].length === 1) ticks = Math.round(ticks * 1.5);
  else if (m[4].length === 2) ticks = Math.round(ticks * 1.75);
  const grace = m[3] === "G";
  return { ticks: grace ? 60 : ticks, grace, isRest: m[1] === "rest" };
}

/** Group symbols into onset chords (port of homr's sort_token_chords). */
export function groupIntoChords(symbols: DecodedSymbol[]): DecodedSymbol[][] {
  const groups: DecodedSymbol[][] = [];
  let inChord = false;
  for (const symbol of symbols) {
    if (symbol.rhythm === "chord") {
      inChord = true;
      continue;
    }
    if (inChord && groups.length > 0) {
      groups[groups.length - 1].push(symbol);
      inChord = false;
    } else {
      groups.push([symbol]);
      inChord = false;
    }
  }
  return groups;
}

function vlq(value: number): number[] {
  let v = Math.max(0, Math.trunc(value));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  // Set continuation bits on all but the last byte.
  for (let i = 0; i < bytes.length - 1; i += 1) bytes[i] |= 0x80;
  return bytes;
}

interface TrackEvent {
  tick: number;
  order: number;
  data: number[];
}

class TrackBuilder {
  private events: TrackEvent[] = [];
  private order = 0;

  push(tick: number, data: number[]): void {
    this.events.push({ tick: Math.max(0, Math.trunc(tick)), data, order: this.order });
    this.order += 1;
  }

  meta(tick: number, kind: number, payload: number[]): void {
    this.push(tick, [0xff, kind, ...vlq(payload.length), ...payload]);
  }

  addNote(tick: number, channel: number, midi: number, durationTicks: number, velocity: number): void {
    this.push(tick, [0x90 | channel, midi, velocity]);
    this.push(tick + Math.max(1, durationTicks), [0x80 | channel, midi, 0]);
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
    const out: number[] = [0x4d, 0x54, 0x72, 0x6b]; // MTrk
    const len = body.length;
    out.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
    out.push(...body);
    return out;
  }
}

function asciiBytes(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0) & 0x7f);
}

/**
 * Convert one staff's decoded symbols to MIDI note events on a tick cursor.
 * Exported for unit tests; symbolsToMidi assembles the SMF.
 */
export function staffSymbolsToNoteEvents(symbols: DecodedSymbol[], staff: number): { events: MidiNoteEvent[]; warnings: string[]; endTick: number } {
  const events: MidiNoteEvent[] = [];
  const warnings: string[] = [];
  let cursor = 0;
  for (const group of groupIntoChords(symbols)) {
    let advance = 0;
    for (const symbol of group) {
      const dur = parseKernDuration(symbol.rhythm);
      if (!dur) continue; // barline, clef, key/time signature, chord leftovers
      if (dur.isRest) {
        if (!dur.grace) advance = Math.max(advance, dur.ticks);
        continue;
      }
      const midi = pitchToMidi(symbol.pitch, symbol.lift);
      if (midi === null) {
        if (!dur.grace) advance = Math.max(advance, dur.ticks);
        continue;
      }
      events.push({
        tick: cursor,
        midi,
        durationTicks: Math.max(1, dur.ticks),
        staff,
        attention: symbol.attention ?? null,
      });
      if (!dur.grace) advance = Math.max(advance, dur.ticks);
    }
    cursor += advance;
  }
  if (events.length === 0) warnings.push(`staff ${staff}: no notes decoded`);
  return { events, warnings, endTick: cursor };
}

/**
 * Build a format-1 SMF: conductor track (name, tempo, 4/4) + one track per
 * staff (program 0, note events). Matches the gbk timer worker's parser.
 */
export function symbolsToMidi(staves: DecodedSymbol[][], title = "homr scan"): StaffMidiResult {
  const warnings: string[] = [];
  const conductor = new TrackBuilder();
  conductor.meta(0, 0x03, asciiBytes(title));
  const microsPerQuarter = Math.round(60000000 / SCAN_TEMPO_BPM);
  conductor.meta(0, 0x51, [(microsPerQuarter >> 16) & 0xff, (microsPerQuarter >> 8) & 0xff, microsPerQuarter & 0xff]);
  conductor.meta(0, 0x58, [4, 2, 24, 8]);

  const tracks: number[][] = [conductor.render()];
  const noteEvents: MidiNoteEvent[] = [];

  staves.forEach((symbols, staffIdx) => {
    // Skip MIDI channel 9 (percussion) when assigning staff channels.
    const channel = staffIdx < 9 ? staffIdx : staffIdx + 1;
    if (channel > 15) {
      warnings.push(`staff ${staffIdx}: too many staves for MIDI channels, skipped`);
      return;
    }
    const { events, warnings: w } = staffSymbolsToNoteEvents(symbols, staffIdx);
    warnings.push(...w);
    noteEvents.push(...events);

    const track = new TrackBuilder();
    track.meta(0, 0x03, asciiBytes(`Staff ${staffIdx + 1}`));
    track.push(0, [0xc0 | channel, 0]); // program 0: acoustic grand piano
    for (const ev of events) {
      track.addNote(ev.tick, channel, ev.midi, ev.durationTicks, SCAN_VELOCITY);
    }
    tracks.push(track.render());
  });

  const header = [
    0x4d, 0x54, 0x68, 0x64, // MThd
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x01, // format 1
    (tracks.length >> 8) & 0xff, tracks.length & 0xff,
    (TICKS_PER_QUARTER >> 8) & 0xff, TICKS_PER_QUARTER & 0xff,
  ];
  const bytes: number[] = [...header];
  for (const t of tracks) bytes.push(...t);
  return { midi: Uint8Array.from(bytes), noteEvents, staffCount: staves.length, warnings };
}
