// Live note input for the workstation: computer-keyboard mapping, MIDI message parsing and a session that
// plays the selected track's instrument (through a LiveSink) and records takes as normal, undoable user edits.
import type { WorkstationController } from "./controller.ts";
import type { Op } from "./ops.ts";
import { secToTick, tickToSec } from "./timing.ts";

/** DAW-style layout: A W S E D F T G Y H U J K = C C# D D# E F F# G G# A A# B C (offsets from the octave's C). */
export const KEY_NOTE_OFFSETS: Readonly<Record<string, number>> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12,
};
export const MIN_OCTAVE = -1, MAX_OCTAVE = 8, VELOCITY_STEP = 16;
export type KeyAction = { kind: "note"; note: number } | { kind: "octave"; delta: -1 | 1 } | { kind: "velocity"; delta: number } | null;

/** KeyboardEvent.code -> action. Octave 4 puts KeyA on C4 = MIDI 60. Z/X octave down/up, C/V velocity down/up. */
export function keyAction(code: string, octave: number): KeyAction {
  const off = KEY_NOTE_OFFSETS[code];
  if (off !== undefined) { const note = (octave + 1) * 12 + off; return note >= 0 && note <= 127 ? { kind: "note", note } : null; }
  if (code === "KeyZ") return { kind: "octave", delta: -1 };
  if (code === "KeyX") return { kind: "octave", delta: 1 };
  if (code === "KeyC") return { kind: "velocity", delta: -VELOCITY_STEP };
  if (code === "KeyV") return { kind: "velocity", delta: VELOCITY_STEP };
  return null;
}

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "image"]);
interface ElementLike { tagName?: string; type?: string; isContentEditable?: boolean; closest?(sel: string): unknown }
/** True when a key press belongs to a text field (inputs, textareas, selects, contenteditable, the composer prompt). */
export function isTypingTarget(el: ElementLike | null | undefined): boolean {
  if (!el) return false;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has((el.type ?? "text").toLowerCase());
  if (el.isContentEditable) return true;
  return !!el.closest?.("[contenteditable=''],[contenteditable='true'],[data-no-live-keys]");
}

export type MidiMsg =
  | { type: "noteOn"; channel: number; note: number; velocity: number }
  | { type: "noteOff"; channel: number; note: number }
  | { type: "cc"; channel: number; controller: number; value: number }
  | { type: "bend"; channel: number; value: number /* 0..16383, 8192 centre */ }
  | { type: "other" };
export function parseMidiMessage(data: ArrayLike<number>): MidiMsg {
  if (!data || data.length === 0) return { type: "other" };
  const st = data[0] & 0xff, cmd = st & 0xf0, channel = st & 0x0f, d1 = (data[1] ?? 0) & 0x7f, d2 = (data[2] ?? 0) & 0x7f;
  if (st >= 0xf0) return { type: "other" };
  if (cmd === 0x90 && d2 > 0) return { type: "noteOn", channel, note: d1, velocity: d2 };
  if (cmd === 0x80 || cmd === 0x90) return { type: "noteOff", channel, note: d1 };
  if (cmd === 0xb0) return { type: "cc", channel, controller: d1, value: d2 };
  if (cmd === 0xe0) return { type: "bend", channel, value: (d2 << 7) | d1 };
  return { type: "other" };
}

/** Where live notes sound (the SF2 engine in the browser; a fake in tests). Always plays on the selected track. */
export interface LiveSink {
  noteOn(trackId: string, note: number, velocity: number): void;
  noteOff(trackId: string, note: number): void;
  controlChange(trackId: string, controller: number, value: number): void;
  pitchBend(trackId: string, value: number): void;
  allNotesOff(): void;
}
export interface LiveSnapshot { octave: number; velocity: number; armed: boolean; recording: boolean; active: number[]; trackId: string | null; lastTake: { notes: number; ccs: number; bends: number } | null }

interface Pending { tick: number; velocity: number }
/** Transport clock: last reported position extrapolated with wall time while playing (the player reports ~every frame). */
function makeClock(c: WorkstationController, now: () => number) {
  let lastTick = c.getState().transport.positionTick, at = now(), playing = c.getState().transport.playing;
  c.subscribe((s) => { if (s.transport.positionTick !== lastTick || s.transport.playing !== playing) { lastTick = s.transport.positionTick; playing = s.transport.playing; at = now(); } });
  return () => playing ? Math.max(0, Math.round(secToTick(c.project, tickToSec(c.project, lastTick) + (now() - at) / 1000))) : lastTick;
}

export class LiveInputSession {
  octave = 4; velocity = 96; armed = false;
  private active = new Map<number, string>(); // note -> trackId it sounds on
  private pending = new Map<number, Pending>();
  private take = { notes: [] as { pitch: number; tick: number; duration: number; velocity: number }[], ccs: [] as { controller: number; tick: number; value: number }[], bends: [] as { tick: number; value: number }[] };
  private takeTrack: string | null = null;
  private listeners = new Set<() => void>();
  private lastTake: LiveSnapshot["lastTake"] = null;
  private wasPlaying = false;
  readonly tickNow: () => number;

  constructor(private c: WorkstationController, private sink: LiveSink, opts: { now?: () => number; tickNow?: () => number } = {}) {
    this.tickNow = opts.tickNow ?? makeClock(c, opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now())));
    c.subscribe((s) => {
      const playing = s.transport.playing;
      if (this.wasPlaying && !playing) queueMicrotask(() => this.finishTake()); // stop/pause closes the take as one undo step
      this.wasPlaying = playing;
    });
    this.wasPlaying = c.getState().transport.playing;
  }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { for (const l of this.listeners) l(); }
  /** Selected track (first of the selection), else the first track. */
  get trackId(): string | null {
    const p = this.c.project;
    return p.tracks.find((t) => p.selection.trackIds.includes(t.id))?.id ?? p.tracks[0]?.id ?? null;
  }
  get recording(): boolean { return this.armed && this.c.getState().transport.playing; }
  snapshot(): LiveSnapshot { return { octave: this.octave, velocity: this.velocity, armed: this.armed, recording: this.recording, active: [...this.active.keys()].sort((a, b) => a - b), trackId: this.trackId, lastTake: this.lastTake }; }

  setArmed(on: boolean) { if (this.armed && !on) this.finishTake(); this.armed = on; this.emit(); }
  shiftOctave(d: number) { this.octave = Math.max(MIN_OCTAVE, Math.min(MAX_OCTAVE, this.octave + d)); this.emit(); }
  shiftVelocity(d: number) { this.velocity = Math.max(1, Math.min(127, this.velocity + d)); this.emit(); }

  noteOn(note: number, velocity = this.velocity) {
    const tid = this.trackId; if (!tid) return;
    if (this.active.has(note)) this.noteOff(note);
    this.active.set(note, tid); this.sink.noteOn(tid, note, velocity);
    if (this.recording) { this.beginTake(tid); this.pending.set(note, { tick: this.tickNow(), velocity }); }
    this.emit();
  }
  noteOff(note: number) {
    const tid = this.active.get(note); if (tid === undefined) return;
    this.active.delete(note); this.sink.noteOff(tid, note);
    const pn = this.pending.get(note);
    if (pn) { this.pending.delete(note); this.take.notes.push({ pitch: note, tick: pn.tick, velocity: pn.velocity, duration: Math.max(1, this.tickNow() - pn.tick) }); }
    this.emit();
  }
  controlChange(controller: number, value: number) {
    const tid = this.trackId; if (!tid) return;
    this.sink.controlChange(tid, controller, value);
    if (this.recording) { this.beginTake(tid); this.take.ccs.push({ controller, value, tick: this.tickNow() }); }
  }
  pitchBend(value: number) {
    const tid = this.trackId; if (!tid) return;
    this.sink.pitchBend(tid, value);
    if (this.recording) { this.beginTake(tid); this.take.bends.push({ value, tick: this.tickNow() }); }
  }
  /** Route one raw MIDI message (any channel: omni into the selected track). */
  handleMidi(data: ArrayLike<number>): MidiMsg {
    const m = parseMidiMessage(data);
    if (m.type === "noteOn") this.noteOn(m.note, m.velocity);
    else if (m.type === "noteOff") this.noteOff(m.note);
    else if (m.type === "cc") { if (m.controller === 123 || m.controller === 120) this.panic(); else this.controlChange(m.controller, m.value); }
    else if (m.type === "bend") this.pitchBend(m.value);
    return m;
  }
  panic() { for (const n of [...this.active.keys()]) this.noteOff(n); this.sink.allNotesOff(); }
  private beginTake(tid: string) { if (!this.takeTrack) this.takeTrack = tid; }

  /** Commit the take (notes still held end now) as one undoable user edit. Returns the edit's revision or null. */
  finishTake(): number | null {
    const tid = this.takeTrack;
    const end = this.tickNow();
    for (const [note, pn] of this.pending) this.take.notes.push({ pitch: note, tick: pn.tick, velocity: pn.velocity, duration: Math.max(1, end - pn.tick) });
    this.pending.clear();
    const t = this.take; this.take = { notes: [], ccs: [], bends: [] }; this.takeTrack = null;
    const track = tid ? this.c.project.tracks.find((x) => x.id === tid) : undefined;
    if (!track || (!t.notes.length && !t.ccs.length && !t.bends.length)) return null;
    const ch = track.channel, ops: Op[] = [];
    if (t.notes.length) ops.push({ op: "addNotes", notes: t.notes.map((n) => ({ trackId: track.id, channel: ch, ...n })) });
    const byCc = new Map<number, { tick: number; value: number }[]>();
    for (const e of t.ccs) { const a = byCc.get(e.controller) ?? []; a.push({ tick: e.tick, value: e.value }); byCc.set(e.controller, a); }
    for (const [controller, pts] of byCc) {
      const dedup = [...new Map(pts.map((x) => [x.tick, x])).values()]; // last value per tick
      ops.push({ op: "setCC", trackId: track.id, channel: ch, controller, mode: "merge", startTick: Math.min(...dedup.map((x) => x.tick)), endTick: Math.max(...dedup.map((x) => x.tick)), points: dedup });
    }
    if (t.bends.length) ops.push({ op: "addPitchBends", trackId: track.id, channel: ch, events: t.bends });
    const r = this.c.edit(ops, { label: `record take (${t.notes.length} notes)`, source: "user" });
    this.lastTake = { notes: t.notes.length, ccs: t.ccs.length, bends: t.bends.length };
    this.emit();
    return r.revision;
  }
}
