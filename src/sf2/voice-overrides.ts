// Per-track / per-preset / per-key-range SoundFont generator overrides layered on top of the SF2 zones.
// Non-normative engine extension (GBK only; sf2player-swift has no equivalent yet, see docs/sound-design.md).
//
// An override targets one SF2 2.01 generator (section 8.1.2 ids) in native units:
//   mode "add": the amount is added to the zone's generator value (like an SF2 NRPN offset, 9.6).
//   mode "set": the zone's generator value is replaced (absolute); modulators still add on top.
// Overrides are summed into the voice's modulator accumulator, so every result is clamped to the
// generator's useful range (10.5) by the existing engine code. They are applied at note-on; realtime
// generators of already-sounding voices can be refreshed on request (Sf2SynthEngine.setVoiceOverrides).
import type { SF2Region } from "./soundfont.ts";
import { clampGen, valueRange } from "./geninfo.ts";

export type OverrideMode = "add" | "set";
export interface VoiceOverride {
  gen: number; mode: OverrideMode; value: number;
  /** Optional inclusive key range (MIDI note) the override applies to. */
  keyLo?: number; keyHi?: number;
}

export type HumanUnit = "seconds" | "Hz" | "dB" | "cents" | "semitones" | "percent" | "cents/key" | "tc/key";
export interface VoiceParamInfo { gen: number; name: string; group: "volEnv" | "modEnv" | "filter" | "lfo" | "vibrato" | "tuning" | "mix" | "effects"; unit: HumanUnit; native: string; realtime: boolean; description: string }

const P = (gen: number, name: string, group: VoiceParamInfo["group"], unit: HumanUnit, native: string, description: string, realtime = true): VoiceParamInfo => ({ gen, name, group, unit, native, realtime, description });
/** Generators an agent / the Sound panel may override, with human units. */
export const VOICE_PARAMS: readonly VoiceParamInfo[] = [
  P(33, "volEnvDelay", "volEnv", "seconds", "timecents", "Volume envelope delay", false),
  P(34, "volEnvAttack", "volEnv", "seconds", "timecents", "Volume envelope attack (linear rise)", false),
  P(35, "volEnvHold", "volEnv", "seconds", "timecents", "Volume envelope hold", false),
  P(36, "volEnvDecay", "volEnv", "seconds", "timecents", "Volume envelope decay (time for 100 dB)", false),
  P(37, "volEnvSustain", "volEnv", "dB", "centibels", "Volume envelope sustain attenuation (0 dB = full level)", false),
  P(38, "volEnvRelease", "volEnv", "seconds", "timecents", "Volume envelope release (time for 100 dB)", false),
  P(39, "keynumToVolEnvHold", "volEnv", "tc/key", "timecents per key", "Hold time scaling per key from 60", false),
  P(40, "keynumToVolEnvDecay", "volEnv", "tc/key", "timecents per key", "Decay time scaling per key from 60", false),
  P(25, "modEnvDelay", "modEnv", "seconds", "timecents", "Modulation envelope delay", false),
  P(26, "modEnvAttack", "modEnv", "seconds", "timecents", "Modulation envelope attack", false),
  P(27, "modEnvHold", "modEnv", "seconds", "timecents", "Modulation envelope hold", false),
  P(28, "modEnvDecay", "modEnv", "seconds", "timecents", "Modulation envelope decay", false),
  P(29, "modEnvSustain", "modEnv", "percent", "0.1 % below full", "Modulation envelope sustain decrease (0 % = full)", false),
  P(30, "modEnvRelease", "modEnv", "seconds", "timecents", "Modulation envelope release", false),
  P(7, "modEnvToPitch", "modEnv", "cents", "cents", "Mod envelope -> pitch depth"),
  P(11, "modEnvToFilterFc", "modEnv", "cents", "cents", "Mod envelope -> filter cutoff depth"),
  P(8, "filterCutoff", "filter", "Hz", "absolute cents", "Low-pass cutoff (13500 cents ~ 20 kHz = open)"),
  P(9, "filterQ", "filter", "dB", "centibels", "Low-pass resonance above DC"),
  P(21, "modLfoDelay", "lfo", "seconds", "timecents", "Modulation LFO delay", false),
  P(22, "modLfoFreq", "lfo", "Hz", "absolute cents", "Modulation LFO frequency", false),
  P(5, "modLfoToPitch", "lfo", "cents", "cents", "Mod LFO -> pitch depth"),
  P(10, "modLfoToFilterFc", "lfo", "cents", "cents", "Mod LFO -> filter cutoff depth"),
  P(13, "modLfoToVolume", "lfo", "dB", "centibels", "Mod LFO -> volume (tremolo) depth"),
  P(23, "vibLfoDelay", "vibrato", "seconds", "timecents", "Vibrato LFO delay", false),
  P(24, "vibLfoFreq", "vibrato", "Hz", "absolute cents", "Vibrato LFO frequency", false),
  P(6, "vibLfoToPitch", "vibrato", "cents", "cents", "Vibrato depth"),
  P(51, "coarseTune", "tuning", "semitones", "semitones", "Coarse tuning"),
  P(52, "fineTune", "tuning", "cents", "cents", "Fine tuning"),
  P(56, "scaleTuning", "tuning", "cents/key", "cents per key", "Key tracking (100 = equal temperament, 0 = same pitch on every key)", false),
  P(17, "pan", "mix", "percent", "0.1 % (-500 left ... 500 right)", "Zone pan (-50 % left ... +50 % right)"),
  P(48, "attenuation", "mix", "dB", "centibels", "Initial attenuation (positive = quieter)"),
  P(15, "chorusSend", "effects", "percent", "0.1 %", "Chorus effects send"),
  P(16, "reverbSend", "effects", "percent", "0.1 %", "Reverb effects send"),
];
export const VOICE_PARAM_BY_NAME: ReadonlyMap<string, VoiceParamInfo> = new Map(VOICE_PARAMS.map((p) => [p.name, p]));
export const VOICE_PARAM_BY_GEN: ReadonlyMap<number, VoiceParamInfo> = new Map(VOICE_PARAMS.map((p) => [p.gen, p]));

/** Native SF2 units -> human units (for set values and effective values). */
export function nativeToHuman(gen: number, v: number): number {
  const info = VOICE_PARAM_BY_GEN.get(gen); if (!info) return v;
  switch (info.unit) {
    case "seconds": return Math.pow(2, v / 1200);
    case "Hz": return 8.176 * Math.pow(2, v / 1200);
    case "dB": return v / 10;
    case "percent": return v / 10;
    default: return v;
  }
}
/** Human units -> native SF2 units (absolute values). */
export function humanToNative(gen: number, h: number): number {
  const info = VOICE_PARAM_BY_GEN.get(gen); if (!info) return h;
  switch (info.unit) {
    case "seconds": return h <= 0 ? -12000 : Math.round(1200 * Math.log2(h));
    case "Hz": return h <= 0 ? -16000 : Math.round(1200 * Math.log2(h / 8.176));
    case "dB": return Math.round(h * 10);
    case "percent": return Math.round(h * 10);
    default: return Math.round(h);
  }
}
/** Human delta for "add" overrides: seconds/Hz -> multiplicative factor expressed as a ratio. */
export function ratioToNativeDelta(ratio: number): number { return Math.round(1200 * Math.log2(ratio)); }

/** The zone's (pre-modulator) value of a generator in native units. */
export function regionGenValue(r: SF2Region, gen: number): number {
  const ve = r.volEnv, me = r.modEnv;
  switch (gen) {
    case 5: return r.modLfoToPitchCents; case 6: return r.vibLfoToPitchCents; case 7: return r.modEnvToPitchCents ?? 0;
    case 8: return r.initialFilterFcCents; case 9: return r.initialFilterQCb; case 10: return r.modLfoToFilterFcCents;
    case 11: return r.modEnvToFilterFcCents; case 13: return r.modLfoToVolumeCb ?? 0; case 15: return r.chorusSend ?? 0;
    case 16: return r.reverbSend ?? 0; case 17: return r.pan; case 21: return r.modLfoDelayTc; case 22: return r.modLfoFreqCents;
    case 23: return r.vibLfoDelayTc; case 24: return r.vibLfoFreqCents;
    case 25: return me.delayTc; case 26: return me.attackTc; case 27: return me.holdTc; case 28: return me.decayTc;
    case 29: return Math.round((1 - me.sustain) * 1000); case 30: return me.releaseTc;
    case 31: return r.keynumToModEnvHold ?? 0; case 32: return r.keynumToModEnvDecay ?? 0;
    case 33: return ve.delayTc; case 34: return ve.attackTc; case 35: return ve.holdTc; case 36: return ve.decayTc;
    case 37: return ve.sustainCb; case 38: return ve.releaseTc; case 39: return r.keynumToVolEnvHold ?? 0; case 40: return r.keynumToVolEnvDecay ?? 0;
    case 48: return r.initialAttenuationCb; case 51: return r.coarseTune; case 52: return r.fineTune; case 56: return r.scaleTuning;
    default: return 0;
  }
}

/** Validation against SF2 2.01 section 8.1.3 ranges. Returns an error string or null. */
export function validateOverride(o: VoiceOverride): string | null {
  if (!o || typeof o !== "object") return "override must be an object";
  const info = VOICE_PARAM_BY_GEN.get(o.gen);
  if (!info) return `generator ${o.gen} is not an editable voice parameter`;
  const r = valueRange(o.gen); if (!r) return `generator ${o.gen} has no value range`;
  if (o.mode !== "add" && o.mode !== "set") return "mode must be add or set";
  if (typeof o.value !== "number" || !Number.isFinite(o.value)) return "value must be a finite number";
  if (o.mode === "set" && (o.value < r[0] || o.value > r[1])) return `${info.name}: ${o.value} outside SF2 range [${r[0]}, ${r[1]}] (${info.native})`;
  if (o.mode === "add" && Math.abs(o.value) > r[1] - r[0]) return `${info.name}: offset ${o.value} exceeds range span ${r[1] - r[0]}`;
  for (const k of ["keyLo", "keyHi"] as const) if (o[k] !== undefined && !(Number.isInteger(o[k]) && o[k]! >= 0 && o[k]! <= 127)) return `${k} must be 0..127`;
  if (o.keyLo !== undefined && o.keyHi !== undefined && o.keyLo > o.keyHi) return "keyLo must be <= keyHi";
  return null;
}

/** Fills `out` (length >= 61) with generator deltas for a voice. Allocation-free. Returns true if any non-zero. */
export function computeOverrideDeltas(list: readonly VoiceOverride[] | null | undefined, r: SF2Region, key: number, out: Float64Array): boolean {
  out.fill(0, 0, 61);
  if (!list || list.length === 0) return false;
  let any = false;
  // "set" first-wins-last semantics: later entries override earlier ones for the same generator.
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o.keyLo !== undefined && key < o.keyLo) continue;
    if (o.keyHi !== undefined && key > o.keyHi) continue;
    if (o.mode === "set") out[o.gen] = clampGen(o.gen, o.value) - regionGenValue(r, o.gen);
    else out[o.gen] += o.value;
    any = true;
  }
  return any;
}

/** Effective (zone + overrides, before modulators) generator values with human units. */
export function effectiveVoice(r: SF2Region, list: readonly VoiceOverride[] | null | undefined, key: number) {
  const d = new Float64Array(61); computeOverrideDeltas(list, r, key, d);
  const out: Record<string, { gen: number; native: number; zone: number; value: number; unit: HumanUnit; overridden: boolean }> = {};
  for (const p of VOICE_PARAMS) {
    const zone = regionGenValue(r, p.gen);
    const native = clampGen(p.gen, zone + d[p.gen]);
    out[p.name] = { gen: p.gen, native, zone, value: round4(nativeToHuman(p.gen, native)), unit: p.unit, overridden: d[p.gen] !== 0 };
  }
  return out;
}
const round4 = (x: number) => (Math.abs(x) >= 100 ? Math.round(x * 10) / 10 : Math.round(x * 10000) / 10000);

// ---- global effects parameters ------------------------------------------------------------------
export interface EffectsParams {
  enabled: boolean;
  /** Freeverb room size 0..1 (comb feedback 0.7 + 0.28 * size). */
  roomSize: number;
  /** High-frequency damping 0..1 (0.4 * damping per comb). */
  damping: number;
  /** Reverb return level 0..1 (1 = Freeverb wet scale 0.7). */
  reverbLevel: number;
  /** Chorus return level 0..1. */
  chorusLevel: number;
  chorusDepthMs: number; chorusRateHz: number; chorusDelayMs: number;
}
export const EFFECTS_DEFAULTS: Readonly<EffectsParams> = Object.freeze({
  enabled: true, roomSize: 0.5, damping: 0.5, reverbLevel: 0.5, chorusLevel: 0.7, chorusDepthMs: 4, chorusRateHz: 0.6, chorusDelayMs: 12,
});
export const EFFECTS_RANGES: Record<Exclude<keyof EffectsParams, "enabled">, [number, number]> = {
  roomSize: [0, 1], damping: [0, 1], reverbLevel: [0, 1], chorusLevel: [0, 1], chorusDepthMs: [0, 10], chorusRateHz: [0.05, 5], chorusDelayMs: [1, 30],
};
export function normalizeEffects(p: Partial<EffectsParams> | null | undefined): EffectsParams {
  const o = { ...EFFECTS_DEFAULTS, ...(p ?? {}) } as EffectsParams;
  for (const [k, [lo, hi]] of Object.entries(EFFECTS_RANGES)) {
    const v = (o as unknown as Record<string, number>)[k];
    (o as unknown as Record<string, number>)[k] = Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : (EFFECTS_DEFAULTS as unknown as Record<string, number>)[k];
  }
  o.enabled = o.enabled !== false;
  return o;
}

// ---- SF2 NRPN export (9.6): additive, key-range-free overrides ---------------------------------
/** NRPN step (native units per data step, 9.6.3) — same as Sf2SynthEngine.nrpnScale. */
export function nrpnStep(gen: number): number {
  const r = valueRange(gen); if (!r) return 0;
  let span = r[1] - r[0], step = 1;
  while (span > 8192) { span /= 2; step *= 2; }
  return step;
}
/** Channel-message bytes (CC 99/98/38/6) setting SF2 NRPN offsets. Only "add" overrides without key range and
 * realtime-safe generators (scaleTuning #56 is excluded by 9.6) map; the rest are project-only. */
export function overridesToNrpn(list: readonly VoiceOverride[], channel: number): { bytes: number[][]; skipped: VoiceOverride[] } {
  const sum = new Map<number, number>(); const skipped: VoiceOverride[] = [];
  for (const o of list) {
    if (o.mode !== "add" || o.keyLo !== undefined || o.keyHi !== undefined || o.gen === 56) { skipped.push(o); continue; }
    sum.set(o.gen, (sum.get(o.gen) ?? 0) + o.value);
  }
  const st = 0xb0 | (channel & 15); const bytes: number[][] = [];
  for (const [gen, amount] of sum) {
    const step = nrpnStep(gen);
    const data = Math.max(0, Math.min(16383, Math.round(amount / step) + 8192));
    bytes.push([st, 99, 120]);
    // 9.6.2: generator numbers >= 100 use the 100/101/102 accumulators before the final 0..99 selector.
    let g = gen; while (g >= 100) { bytes.push([st, 98, 100]); g -= 100; }
    bytes.push([st, 98, g]);
    bytes.push([st, 38, data & 0x7f]);
    bytes.push([st, 6, (data >> 7) & 0x7f]);
  }
  return { bytes, skipped };
}
