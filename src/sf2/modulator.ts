// SoundFont 2.01 modulators (sections 8.2 to 8.5, 9.5; 2.04 additions gated by SF2SpecVersion).
// Mirrors sf2player-swift Sources/SF2Engine/SF2Modulator.swift.
import { isValueGenerator } from "./geninfo.ts";

export interface SF2Modulator {
  src: number;     // raw SFModulator word (u16)
  dest: number;    // u16
  amount: number;  // i16
  amtSrc: number;  // u16
  transform: number; // u16
}

export interface SF2SpecVersion { major: number; minor: number }

export function has204Features(v: SF2SpecVersion): boolean {
  return v.major > 2 || (v.major === 2 && v.minor >= 4);
}
/** Section 8.3 (2.01 defines only linear = 0; 2.04 adds 2 = absolute value). */
export function isValidTransform(v: SF2SpecVersion, t: number): boolean {
  return t === 0 || (t === 2 && has204Features(v));
}

export function mod(src: number, dest: number, amount: number, amtSrc = 0, transform = 0): SF2Modulator {
  return { src, dest, amount, amtSrc, transform };
}

/** Virtual "Initial Pitch" destination (cents) of default modulator 8.4.10, outside file enumerator space (M-07). */
export const PITCH_DEST = 64;
/** Slots in a modulator destination accumulator (generators 0...63 plus PITCH_DEST). */
export const SLOT_COUNT = 65;

/** SoundFont 2.04 default modulators (8 entries). Used for files with ifil >= 2.04 and hand-built regions. */
export const DEFAULT_MODS_204: readonly SF2Modulator[] = [
  mod(0x0502, 48, 960),
  mod(0x0102, 8, -2400),
  mod(0x000d, 6, 50),
  mod(0x0081, 6, 50),
  mod(0x0587, 48, 960),
  mod(0x028a, 17, 1000),
  mod(0x058b, 48, 960),
  mod(0x020e, PITCH_DEST, 12700, 0x0010),
];

/** SoundFont 2.01 section 8.4: ten default modulators. Errata resolved: 8.4.2's amount source is
 * 0x0D02 (printed 0x502); 8.4.6's destination is pan (#17) per its prose. */
export const DEFAULT_MODS_201: readonly SF2Modulator[] = [
  mod(0x0502, 48, 960),
  mod(0x0102, 8, -2400, 0x0d02),
  mod(0x000d, 6, 50),
  mod(0x0081, 6, 50),
  mod(0x0587, 48, 960),
  mod(0x028a, 17, 1000),
  mod(0x058b, 48, 960),
  mod(0x00db, 16, 200),
  mod(0x00dd, 15, 200),
  mod(0x020e, PITCH_DEST, 12700, 0x0010),
];

export function defaultModulators(v: SF2SpecVersion): readonly SF2Modulator[] {
  return has204Features(v) ? DEFAULT_MODS_204 : DEFAULT_MODS_201;
}

/** 8.2.1: identical when source, destination, amount source and transform match. */
export function sameIdentity(a: SF2Modulator, b: SF2Modulator): boolean {
  return a.src === b.src && a.dest === b.dest && a.amtSrc === b.amtSrc && a.transform === b.transform;
}

const BAD_CC = new Set([0, 6, 32, 38, 98, 99, 100, 101]);
const GENERAL_SOURCES = new Set([0, 2, 3, 10, 13, 14, 16]);

/** 8.2 / 8.2.1 / 8.2.4: type 0...3 and a defined general-controller index or a legal MIDI CC. */
export function sourceIsValid(w: number): boolean {
  if (w >> 10 > 3) return false;
  const idx = w & 0x7f;
  if (w & 0x80) {
    if (BAD_CC.has(idx) || idx >= 120 || (idx >= 33 && idx <= 63)) return false;
    return true;
  }
  return GENERAL_SOURCES.has(idx);
}

/** M-01, M-02, M-05, M-06, M-07: invalid modulators are ignored entirely. */
export function modulatorIsValid(m: SF2Modulator, v: SF2SpecVersion): boolean {
  return sourceIsValid(m.src) && sourceIsValid(m.amtSrc) && isValidTransform(v, m.transform)
    && (m.dest & 0x8000) === 0 && isValueGenerator(m.dest);
}

function clampI16(x: number): number { return Math.max(-32768, Math.min(32767, x)); }

/** 9.5: instrument modulators (global then local) replace identical defaults; preset modulators add. */
export function mergeModulators(instGlobal: SF2Modulator[], instLocal: SF2Modulator[], presetGlobal: SF2Modulator[],
  presetLocal: SF2Modulator[], version: SF2SpecVersion = { major: 2, minor: 4 }): SF2Modulator[] {
  const overlay = (base: readonly SF2Modulator[], top: SF2Modulator[]) => {
    const out = base.map((m) => ({ ...m }));
    for (const m of top) {
      if (!modulatorIsValid(m, version)) continue;
      const i = out.findIndex((o) => sameIdentity(o, m));
      if (i >= 0) out[i] = { ...m }; else out.push({ ...m });
    }
    return out;
  };
  const inst = overlay(overlay(defaultModulators(version), instGlobal), instLocal);
  const preset = overlay(overlay([], presetGlobal), presetLocal);
  const out = inst;
  for (const m of preset) {
    const i = out.findIndex((o) => sameIdentity(o, m));
    if (i >= 0) out[i].amount = clampI16(out[i].amount + m.amount); else out.push({ ...m });
  }
  return out.filter((m) => m.amount !== 0);
}

/** Controller state a modulator source reads (one MIDI channel plus the note). Reused, not allocated per call. */
export interface ModInputs {
  velocity: number;
  key: number;
  cc: Uint8Array;        // 128 controllers (a subarray view)
  ccBase: number;        // offset of this channel's controllers in `cc`
  pitchWheel: number;    // 0...16383
  pitchWheelSensitivity: number; // semitones
  channelPressure: number;
  polyPressure: number;
}

/** SF2 concave curve: -(20/96) log10((1 - x)^2), clipped to 0...1. */
export function concave(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return Math.min(1, -(20.0 / 96.0) * Math.log10((1 - x) * (1 - x)));
}

/** Curve types on 0...1: 0 linear, 1 concave, 2 convex, 3 switch. */
export function modCurve(type: number, x: number): number {
  switch (type) {
    case 1: return concave(x);
    case 2: return 1 - concave(1 - x);
    case 3: return x >= 0.5 ? 1 : 0;
    default: return x;
  }
}

/** 8.2.1 source value (Table 2 mapping v/128; pitch-wheel sensitivity s/127, 8.4.10 erratum). */
export function modSourceValue(word: number, i: ModInputs): number {
  const index = word & 0x7f;
  const isCC = (word & 0x80) !== 0;
  const negative = (word & 0x100) !== 0;
  const bipolar = (word & 0x200) !== 0;
  const type = word >> 10;
  let raw: number;
  let range = 128.0;
  if (isCC) {
    raw = i.cc[i.ccBase + index];
  } else {
    switch (index) {
      case 0: return 1;
      case 2: raw = i.velocity; break;
      case 3: raw = i.key; break;
      case 10: raw = i.polyPressure; break;
      case 13: raw = i.channelPressure; break;
      case 14: raw = i.pitchWheel; range = 16384; break;
      case 16: {
        const x = Math.min(1, i.pitchWheelSensitivity / 127);
        return modCurve(type, negative ? 1 - x : x);
      }
      default: return 0;
    }
  }
  if (bipolar) {
    let b = (2 * raw) / range - 1;
    if (negative) b = -b;
    const s = b < 0 ? -1 : 1;
    return s * modCurve(type, Math.min(1, Math.abs(b)));
  }
  const x = negative ? (range - 1 - raw) / range : raw / range;
  return modCurve(type, x);
}

/** 9.5.1: amount x source x amount source, then transform. Amount source 0 maps to 1. */
export function modValue(m: SF2Modulator, i: ModInputs): number {
  const s = modSourceValue(m.src, i);
  if (s === 0) return 0;
  const a = m.amtSrc === 0 ? 1 : modSourceValue(m.amtSrc, i);
  const v = s * a * m.amount;
  return m.transform === 2 ? Math.abs(v) : v;
}
