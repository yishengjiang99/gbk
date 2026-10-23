// Framework-independent workstation project model. Ticks are authoritative; seconds are derived.
export const PROJECT_SCHEMA_VERSION = 1;

export interface Note { id: string; trackId: string; channel: number; tick: number; duration: number; pitch: number; velocity: number; offVelocity?: number }
export interface CCEvent { id: string; trackId: string; channel: number; controller: number; tick: number; value: number }
export interface PitchBendEvent { id: string; trackId: string; channel: number; tick: number; value: number /* 0..16383, 8192 center */ }
export interface ChannelPressureEvent { id: string; trackId: string; channel: number; tick: number; value: number }
export interface PolyPressureEvent { id: string; trackId: string; channel: number; tick: number; pitch: number; value: number }
export interface ProgramEvent { id: string; trackId: string; channel: number; tick: number; program: number; bankMsb: number; bankLsb: number }
export interface TempoEvent { tick: number; microPerQuarter: number }
export interface TimeSigEvent { tick: number; numerator: number; denominator: number }
/** Events we do not model but must round-trip (sysex, unknown meta, text...). `bytes` excludes delta time. */
export interface RawEvent { id: string; trackId: string; tick: number; bytes: number[]; kind: "meta" | "sysex" | "other" }

export interface TrackMix { volume: number; pan: number; expression: number; mute: boolean; solo: boolean }
export type TrackRole = "melody" | "harmony" | "bass" | "counterpoint" | "accompaniment" | "percussion" | "pad" | "other";
export interface Track { id: string; name: string; channel: number; color: string; mix: TrackMix; visible: boolean; role?: TrackRole }
/** Semantic arrangement section (1-based bars, inclusive start, `bars` long). */
export interface Section { name: string; startBar: number; bars: number; energy?: number }
/** Composition metadata (GBK extension, optional for older projects). owner=agent marks a project created by an agent. */
export interface ProjectMeta { key?: string; sections?: Section[]; descriptors?: Record<string, string>; owner?: "user" | "agent"; createdAt?: number; style?: string; seed?: number }

/** Sound design layer (GBK extension): per-track SF2 generator overrides + global effects. Optional for older projects. */
export interface SoundSettings {
  tracks: Record<string, import("../sf2/voice-overrides.ts").VoiceOverride[]>;
  effects: import("../sf2/voice-overrides.ts").EffectsParams | null;
}
export interface Selection { trackIds: string[]; startTick: number; endTick: number; noteIds: string[] }
export interface Loop { enabled: boolean; startTick: number; endTick: number }

export interface Project {
  schemaVersion: number;
  id: string;
  revision: number;
  name: string;
  ppq: number;
  format: number;
  tracks: Track[];
  notes: Note[];
  ccs: CCEvent[];
  pitchBends: PitchBendEvent[];
  channelPressure: ChannelPressureEvent[];
  polyPressure: PolyPressureEvent[];
  programs: ProgramEvent[];
  tempos: TempoEvent[];
  timeSigs: TimeSigEvent[];
  raw: RawEvent[];
  endTick: number;
  selection: Selection;
  loop: Loop;
  sound?: SoundSettings;
  meta?: ProjectMeta;
}

export const DEFAULT_MIX: TrackMix = { volume: 100, pan: 64, expression: 127, mute: false, solo: false };
export const TRACK_COLORS = ["#4fc3f7", "#ffb74d", "#81c784", "#e57373", "#ba68c8", "#fff176", "#4db6ac", "#f06292", "#a1887f", "#90a4ae", "#aed581", "#7986cb", "#ff8a65", "#9575cd", "#4dd0e1", "#dce775"];

/** Deterministic same-tick order: bank(CC0/32), program, note-off, note-on, CC (others). */
export const ORDER = { bank: 0, program: 1, noteOff: 2, noteOn: 3, cc: 4, bend: 5, pressure: 6 } as const;

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1e9;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function emptyProject(name = "Untitled", ppq = 480): Project {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION, id: newId("prj"), revision: 0, name, ppq, format: 1,
    tracks: [], notes: [], ccs: [], pitchBends: [], channelPressure: [], polyPressure: [], programs: [],
    tempos: [{ tick: 0, microPerQuarter: 500000 }], timeSigs: [{ tick: 0, numerator: 4, denominator: 4 }],
    raw: [], endTick: 0, selection: { trackIds: [], startTick: 0, endTick: 0, noteIds: [] }, loop: { enabled: false, startTick: 0, endTick: 0 },
  };
}

export function cloneProject(p: Project): Project { return structuredClone(p); }

export function computeEndTick(p: Project): number {
  let m = 0;
  for (const n of p.notes) m = Math.max(m, n.tick + n.duration);
  for (const c of p.ccs) m = Math.max(m, c.tick);
  for (const b of p.pitchBends) m = Math.max(m, b.tick);
  for (const r of p.raw) m = Math.max(m, r.tick);
  return m;
}

export const sortByTick = <T extends { tick: number; id?: string }>(a: T, b: T) => a.tick - b.tick;
