// Sound-design helpers shared by the WebMCP tools and the Sound panel (one code path for agents and users).
import type { Project } from "./model.ts";
import type { SF2Region } from "../sf2/soundfont.ts";
import { WorkstationError } from "./ops.ts";
import {
  VOICE_PARAM_BY_NAME, VOICE_PARAMS, effectiveVoice, humanToNative, nativeToHuman, regionGenValue, normalizeEffects,
  computeOverrideDeltas, type VoiceOverride, type EffectsParams,
} from "../sf2/voice-overrides.ts";
import { clampGen, valueRange } from "../sf2/geninfo.ts";

/** A human-unit edit: set = absolute value in the parameter's unit; add = delta in the unit (dB, cents, %, semitones);
 * scale = multiply a time / frequency (seconds, Hz) by a factor (e.g. 2 = twice as long). */
export interface HumanVoiceEdit { param: string; mode: "set" | "add" | "scale"; value: number; keyLo?: number; keyHi?: number }

export function humanEditToOverride(e: HumanVoiceEdit): VoiceOverride {
  const info = VOICE_PARAM_BY_NAME.get(e.param);
  if (!info) throw new WorkstationError("INVALID_ARGUMENT", `unknown voice parameter ${JSON.stringify(String(e.param).slice(0, 40))}; one of ${VOICE_PARAMS.map((p) => p.name).join(", ")}`);
  const r = valueRange(info.gen)!;
  const k = { ...(e.keyLo !== undefined ? { keyLo: e.keyLo } : {}), ...(e.keyHi !== undefined ? { keyHi: e.keyHi } : {}) };
  const exp = info.unit === "seconds" || info.unit === "Hz";
  if (e.mode === "set") {
    const native = humanToNative(info.gen, e.value);
    if (native < r[0] || native > r[1]) {
      throw new WorkstationError("INVALID_ARGUMENT", `${info.name}: ${e.value} ${info.unit} is outside the SF2 range ${fmt(nativeToHuman(info.gen, r[0]))}..${fmt(nativeToHuman(info.gen, r[1]))} ${info.unit}`);
    }
    return { gen: info.gen, mode: "set", value: native, ...k };
  }
  if (e.mode === "scale") {
    if (!exp) throw new WorkstationError("INVALID_ARGUMENT", `${info.name}: scale only applies to seconds/Hz parameters; use add`);
    if (!(e.value > 0 && e.value <= 1024)) throw new WorkstationError("INVALID_ARGUMENT", `${info.name}: scale factor must be in (0, 1024]`);
    return { gen: info.gen, mode: "add", value: Math.round(1200 * Math.log2(e.value)), ...k };
  }
  if (exp) throw new WorkstationError("INVALID_ARGUMENT", `${info.name}: use mode scale (factor) or set (${info.unit}) for time/frequency parameters`);
  const delta = humanToNative(info.gen, e.value);
  if (Math.abs(delta) > r[1] - r[0]) throw new WorkstationError("INVALID_ARGUMENT", `${info.name}: offset too large`);
  return { gen: info.gen, mode: "add", value: delta, ...k };
}
const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toPrecision(3));

/** Controller value in effect at `tick` on the track (authored CC events), else MIDI power-on default. */
export function ccAt(p: Project, trackId: string, controller: number, tick: number): number {
  let v = controller === 7 ? 100 : controller === 10 ? 64 : controller === 11 ? 127 : 0;
  for (const c of p.ccs) if (c.trackId === trackId && c.controller === controller && c.tick <= tick) v = c.value;
  return v;
}

function sendModAmount(r: SF2Region, dest: 15 | 16, cc: number): number {
  const src = dest === 16 ? 91 : 93;
  const m = (r.modulators ?? []).find((x) => x.dest === dest && (x.src & 0x80) && (x.src & 0x7f) === src);
  return (m ? m.amount : 200) * (cc / 128);
}

/** Voice report for gbk_get_voice_settings / Sound panel. */
export function voiceReport(p: Project, trackId: string, host: { presetName: string; presetIndex: number; regions: SF2Region[] } | null, key = 60, velocity = 100, tick = 0) {
  const overrides = p.sound?.tracks[trackId] ?? [];
  const effects = normalizeEffects(p.sound?.effects);
  const cc91 = ccAt(p, trackId, 91, tick), cc93 = ccAt(p, trackId, 93, tick);
  const zones = (host?.regions ?? []).filter((r) => key >= r.keyRange[0] && key <= r.keyRange[1] && velocity >= r.velRange[0] && velocity <= r.velRange[1]);
  const d = new Float64Array(61);
  return {
    trackId, key, velocity, preset: host ? { index: host.presetIndex, name: host.presetName } : null,
    overrides, effects, controllers: { cc91ReverbSend: cc91, cc93ChorusSend: cc93 },
    zones: zones.map((r) => {
      computeOverrideDeltas(overrides, r, key, d);
      const send = (gen: 15 | 16, cc: number) => {
        const zone = regionGenValue(r, gen), mod = sendModAmount(r, gen, cc), ovr = d[gen];
        return { zonePercent: zone / 10, ccModulatorPercent: +(mod / 10).toFixed(2), overridePercent: ovr / 10, effectivePercent: +(clampGen(gen, zone + mod + ovr) / 10).toFixed(2) };
      };
      return {
        keyRange: r.keyRange, velRange: r.velRange, sample: { rate: r.sample.sampleRate, rootKey: r.overridingRootKey ?? r.originalKey },
        generators: effectiveVoice(r, overrides, key),
        effectiveSends: { reverb: send(16, cc91), chorus: send(15, cc93) },
      };
    }),
    notes: [
      "generators = zone (preset+instrument summed per SF2 9.4) + overrides, clamped to SF2 ranges, before modulators (velocity, CCs).",
      "effectiveSends include the SF2 2.01 default modulators CC91->reverb / CC93->chorus (200 = 20% at CC 127) unless the preset defines its own.",
      "Envelope times are seconds (decay/release = time for a 100 dB fall), sustain/attenuation in dB of attenuation, cutoff / LFO rates in Hz.",
    ],
  };
}

export function effectsOrDefault(p: Project): EffectsParams { return normalizeEffects(p.sound?.effects); }
