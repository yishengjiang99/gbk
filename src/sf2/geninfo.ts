// SoundFont 2.01 section 8.1.3 generator table: kinds, defaults, useful ranges, instrument-only
// (section 8.5) and real-time flags. Mirrors sf2player-swift Sources/SF2Engine/SF2GenInfo.swift.

export type GenKind = "index" | "range" | "substitution" | "sample" | "value";

export interface GenInfo {
  id: number;
  kind: GenKind;
  min: number;
  max: number;
  defaultValue: number;
  instrumentOnly: boolean;
  realtime: boolean;
}

export const Gen = {
  startAddrsOffset: 0, endAddrsOffset: 1, startloopAddrsOffset: 2, endloopAddrsOffset: 3,
  startAddrsCoarseOffset: 4, modLfoToPitch: 5, vibLfoToPitch: 6, modEnvToPitch: 7,
  initialFilterFc: 8, initialFilterQ: 9, modLfoToFilterFc: 10, modEnvToFilterFc: 11,
  endAddrsCoarseOffset: 12, modLfoToVolume: 13, chorusEffectsSend: 15, reverbEffectsSend: 16,
  pan: 17, delayModLFO: 21, freqModLFO: 22, delayVibLFO: 23, freqVibLFO: 24,
  delayModEnv: 25, attackModEnv: 26, holdModEnv: 27, decayModEnv: 28, sustainModEnv: 29,
  releaseModEnv: 30, keynumToModEnvHold: 31, keynumToModEnvDecay: 32,
  delayVolEnv: 33, attackVolEnv: 34, holdVolEnv: 35, decayVolEnv: 36, sustainVolEnv: 37,
  releaseVolEnv: 38, keynumToVolEnvHold: 39, keynumToVolEnvDecay: 40, instrument: 41,
  keyRange: 43, velRange: 44, startloopAddrsCoarseOffset: 45, keynum: 46, velocity: 47,
  initialAttenuation: 48, endloopAddrsCoarseOffset: 50, coarseTune: 51, fineTune: 52,
  sampleID: 53, sampleModes: 54, scaleTuning: 56, exclusiveClass: 57, overridingRootKey: 58,
} as const;

/** Indexed by generator id 0...60; null for unused/reserved (14, 18, 19, 20, 42, 49, 55, 59, 60). */
export const GEN_TABLE: (GenInfo | null)[] = (() => {
  const t: (GenInfo | null)[] = new Array(61).fill(null);
  const v = (id: number, lo: number, hi: number, def: number) => {
    t[id] = { id, kind: "value", min: lo, max: hi, defaultValue: def, instrumentOnly: false, realtime: true };
  };
  const s = (id: number, lo: number, hi: number, def: number, realtime = true) => {
    t[id] = { id, kind: "sample", min: lo, max: hi, defaultValue: def, instrumentOnly: true, realtime };
  };
  const big = 32767 * 32768;
  s(0, 0, big, 0); s(1, -big, 0, 0); s(2, -big, big, 0); s(3, -big, big, 0); s(4, 0, 32767, 0);
  v(5, -12000, 12000, 0); v(6, -12000, 12000, 0); v(7, -12000, 12000, 0);
  v(8, 1500, 13500, 13500); v(9, 0, 960, 0); v(10, -12000, 12000, 0); v(11, -12000, 12000, 0);
  s(12, -32768, 0, 0); v(13, -960, 960, 0);
  v(15, 0, 1000, 0); v(16, 0, 1000, 0); v(17, -500, 500, 0);
  v(21, -12000, 5000, -12000); v(22, -16000, 4500, 0); v(23, -12000, 5000, -12000); v(24, -16000, 4500, 0);
  v(25, -12000, 5000, -12000); v(26, -12000, 8000, -12000); v(27, -12000, 5000, -12000); v(28, -12000, 8000, -12000);
  v(29, 0, 1000, 0); v(30, -12000, 8000, -12000); v(31, -1200, 1200, 0); v(32, -1200, 1200, 0);
  v(33, -12000, 5000, -12000); v(34, -12000, 8000, -12000); v(35, -12000, 5000, -12000); v(36, -12000, 8000, -12000);
  v(37, 0, 1440, 0); v(38, -12000, 8000, -12000); v(39, -1200, 1200, 0); v(40, -1200, 1200, 0);
  t[41] = { id: 41, kind: "index", min: 0, max: 65535, defaultValue: 0, instrumentOnly: false, realtime: false };
  t[43] = { id: 43, kind: "range", min: 0, max: 0x7f7f, defaultValue: 0x7f00, instrumentOnly: false, realtime: false };
  t[44] = { id: 44, kind: "range", min: 0, max: 0x7f7f, defaultValue: 0x7f00, instrumentOnly: false, realtime: false };
  s(45, -32768, 32767, 0);
  t[46] = { id: 46, kind: "substitution", min: 0, max: 127, defaultValue: -1, instrumentOnly: true, realtime: false };
  t[47] = { id: 47, kind: "substitution", min: 0, max: 127, defaultValue: -1, instrumentOnly: true, realtime: false };
  v(48, 0, 1440, 0);
  s(50, -32768, 32767, 0);
  v(51, -120, 120, 0); v(52, -99, 99, 0);
  t[53] = { id: 53, kind: "index", min: 0, max: 65535, defaultValue: 0, instrumentOnly: true, realtime: false };
  s(54, 0, 3, 0, false);
  t[56] = { id: 56, kind: "value", min: 0, max: 1200, defaultValue: 100, instrumentOnly: false, realtime: false };
  s(57, 0, 127, 0, false);
  s(58, 0, 127, -1, false);
  return t;
})();

export function genInfo(id: number): GenInfo | null {
  return id >= 0 && id < GEN_TABLE.length ? GEN_TABLE[id] : null;
}
/** Section 8.1.1: modulator destinations are exclusively value generators. */
export function isValueGenerator(id: number): boolean {
  return genInfo(id)?.kind === "value";
}
export function genDefaultValue(id: number): number {
  return genInfo(id)?.defaultValue ?? 0;
}

// Real-time ranges (no allocation): value-generator ranges as flat tables, kept in sync with
// GEN_TABLE by test_Z11_genInfoTableAndClamp.
const RANGE_LO = new Float64Array(65).fill(NaN);
const RANGE_HI = new Float64Array(65).fill(NaN);
for (const g of GEN_TABLE) {
  if (g && g.kind === "value") { RANGE_LO[g.id] = g.min; RANGE_HI[g.id] = g.max; }
}

/** [lo, hi] of a value generator, or null. Allocates: not for the render path. */
export function valueRange(id: number): [number, number] | null {
  if (!(id >= 0 && id < 61) || Number.isNaN(RANGE_LO[id])) return null;
  return [RANGE_LO[id], RANGE_HI[id]];
}
export function hasValueRange(id: number): boolean {
  return id >= 0 && id < 61 && !Number.isNaN(RANGE_LO[id]);
}

/** Section 10.5: clamp a summed value generator to its useful range (others unchanged). Real-time safe. */
export function clampGen(id: number, x: number): number {
  if (!(id >= 0 && id < 61)) return x;
  const lo = RANGE_LO[id];
  if (Number.isNaN(lo)) return x;
  return Math.max(lo, Math.min(RANGE_HI[id], x));
}

/** Swift `Double.rounded()` (schoolbook: half away from zero). */
export function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}
