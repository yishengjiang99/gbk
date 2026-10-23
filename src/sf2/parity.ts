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
