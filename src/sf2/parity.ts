// Scenario renderer shared by scripts/parity-render.ts and the cross-engine parity test. Mirrors
// sf2player-swift Sources/sf2-parity-render/main.swift (offline order: frame, seq, track).
import { SF2SoundFont, STRICT, LENIENT } from "./soundfont.ts";
import { Sf2SynthEngine, sortEvents, type SynthEvent, type TrackState } from "../sf2-renderer.ts";

export interface ScenarioEvent {
  frame?: number; seq?: number; type: string; channel?: number; trackIndex?: number; note?: number; velocity?: number;
  controller?: number; value?: number; program?: number; preset?: number;
}
export interface Scenario {
  font: string; sampleRate?: number; frames?: number; effects?: boolean; strict?: boolean; programs?: boolean; maxVoices?: number;
  tracks?: { trackIndex?: number; preset?: number; gain?: number; pan?: number }[];
  events?: ScenarioEvent[];
}

const fontCache = new Map<string, SF2SoundFont>();

export function renderScenario(s: Scenario, read: (path: string) => Uint8Array): { left: Float32Array; right: Float32Array } {
  const key = `${s.font}|${s.strict ? 1 : 0}`;
  let sf = fontCache.get(key);
  if (!sf) { sf = new SF2SoundFont(read(s.font), s.strict ? STRICT : LENIENT); fontCache.set(key, sf); }
  const sr = s.sampleRate ?? 44100, frames = s.frames ?? 44100;
  const engine = new Sf2SynthEngine(sr, { maxVoices: s.maxVoices ?? 64 });
  engine.effectsEnabled = s.effects ?? false;
  if (s.programs) engine.loadPrograms(sf);
  const tracks: TrackState[] = (s.tracks ?? []).map((t) => ({
    trackIndex: t.trackIndex ?? 0, regions: t.preset !== undefined ? sf!.regionList(t.preset) : undefined, pan: t.pan, gain: t.gain,
  }));
  engine.setTrackStates(tracks);
  const events: SynthEvent[] = (s.events ?? []).map((e, i) => ({
    ...e, frame: e.frame ?? 0, seq: e.seq ?? i,
    regions: e.preset !== undefined ? sf!.regionList(e.preset) : undefined,
  }));
  const left = new Float32Array(frames), right = new Float32Array(frames);
  let cursor = 0;
  for (const e of sortEvents(events)) {
    const f = Math.max(0, Math.min(frames, e.frame ?? 0));
    if (f > cursor) { engine.renderRange(left.subarray(cursor, f), right.subarray(cursor, f)); cursor = f; }
    engine.dispatchEvent(e);
  }
  if (cursor < frames) engine.renderRange(left.subarray(cursor), right.subarray(cursor));
  return { left, right };
}

/** Same text format as sf2-parity-render's PARITY_DUMP (debugging cross-engine differences). */
export function dumpRegions(sf: SF2SoundFont, p: number): string {
  return sf.regionList(p).map((r) => {
    const m = (r.modulators ?? []).map((x) => `${x.src}:${x.dest}:${x.amount}:${x.amtSrc}:${x.transform}`).join(",");
    const ve = r.volEnv, me = r.modEnv;
    return `key ${r.keyRange[0]}-${r.keyRange[1]} vel ${r.velRange[0]}-${r.velRange[1]} len ${r.sample.dataL.length} rate ${r.sample.sampleRate} loop ${r.sample.loopStart}-${r.sample.loopEnd} modes ${r.sampleModes} root ${r.overridingRootKey ?? r.originalKey} ct ${r.coarseTune} ft ${r.fineTune} st ${r.scaleTuning} att ${r.initialAttenuationCb} pan ${r.pan} ve ${ve.delayTc},${ve.attackTc},${ve.holdTc},${ve.decayTc},${ve.sustainCb},${ve.releaseTc} me ${me.delayTc},${me.attackTc},${me.holdTc},${me.decayTc},${fmt(me.sustain)},${me.releaseTc} fc ${r.initialFilterFcCents} q ${r.initialFilterQCb} meFc ${r.modEnvToFilterFcCents} mlFc ${r.modLfoToFilterFcCents} ml ${r.modLfoDelayTc},${r.modLfoFreqCents},${r.modLfoToPitchCents} vl ${r.vibLfoDelayTc},${r.vibLfoFreqCents},${r.vibLfoToPitchCents} ex ${r.exclusiveClass} mePitch ${r.modEnvToPitchCents ?? 0} mlVol ${r.modLfoToVolumeCb ?? 0} kn ${r.keynumToVolEnvHold ?? 0},${r.keynumToVolEnvDecay ?? 0},${r.keynumToModEnvHold ?? 0},${r.keynumToModEnvDecay ?? 0} ov ${r.keynumOverride ?? -1},${r.velocityOverride ?? -1} send ${r.chorusSend ?? 0},${r.reverbSend ?? 0} mods ${m}`;
  }).join("\n");
}
function fmt(x: number): string { return Number.isInteger(x) ? x.toFixed(1) : String(x); }
