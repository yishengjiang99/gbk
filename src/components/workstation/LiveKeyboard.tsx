// On-screen piano + computer-keyboard + Web MIDI input for the selected track, with record arm.
import { useEffect, useMemo, useReducer } from "react";
import type { WorkstationController } from "../../workstation/controller.ts";
import { LiveInputSession, keyAction, isTypingTarget, KEY_NOTE_OFFSETS } from "../../workstation/live-input.ts";
import { MidiInputManager } from "../../workstation/midi-input.ts";
import { Sf2LiveSink } from "../../workstation/live-sink.ts";

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = new Set([1, 3, 6, 8, 10]);
const LETTER_FOR_OFFSET = Object.fromEntries(Object.entries(KEY_NOTE_OFFSETS).map(([code, off]) => [off, code.slice(3)]));

export interface LiveRig { session: LiveInputSession; midi: MidiInputManager; sink: Sf2LiveSink }
let rig: LiveRig | null = null;
/** One rig per page (the session survives the panel being hidden so a take is never lost). */
export function liveRig(c: WorkstationController): LiveRig {
  if (rig) return rig;
  const sink = new Sf2LiveSink(c);
  const session = new LiveInputSession(c, sink);
  const midi = new MidiInputManager(typeof navigator !== "undefined" ? (navigator as never) : undefined, (data) => session.handleMidi(data));
  rig = { session, midi, sink };
  if (typeof window !== "undefined") (window as unknown as { __gbkLive?: LiveRig }).__gbkLive = rig; // test/debug handle
  return rig;
}

export function LiveKeyboard({ workstation }: { workstation: WorkstationController }) {
  const { session, midi, sink } = useMemo(() => liveRig(workstation), [workstation]);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => { const a = session.subscribe(bump), b = midi.subscribe(bump); return () => { a(); b(); }; }, [session, midi]);
  const s = session.snapshot();
  useEffect(() => { sink.refresh(s.trackId); }, [s.trackId]);
  // Computer keyboard: only while the panel is open, never while typing.
  useEffect(() => {
    const held = new Map<string, number>();
    const down = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target as never)) return;
      const a = keyAction(e.code, session.octave); if (!a) return;
      e.preventDefault(); void sink.prepare().catch(() => undefined);
      if (a.kind === "note") { held.set(e.code, a.note); session.noteOn(a.note); }
      else if (a.kind === "octave") session.shiftOctave(a.delta);
      else session.shiftVelocity(a.delta);
    };
    const up = (e: KeyboardEvent) => { const n = held.get(e.code); if (n !== undefined) { held.delete(e.code); session.noteOff(n); } };
    const blur = () => { for (const n of held.values()) session.noteOff(n); held.clear(); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("blur", blur);
    return () => { blur(); window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); };
  }, [session, sink]);

  const base = (s.octave + 1) * 12;
  const notes = Array.from({ length: 25 }, (_, i) => base + i).filter((n) => n <= 127);
  const track = workstation.project.tracks.find((t) => t.id === s.trackId);
  const press = (n: number) => (e: React.PointerEvent) => { e.preventDefault(); (e.target as Element).setPointerCapture?.(e.pointerId); void sink.prepare().catch(() => undefined); session.noteOn(n); };
  const release = (n: number) => () => session.noteOff(n);
  return (
    <div className="ws-keys" data-testid="live-keyboard">
      <div className="ws-row ws-dim">
        <span>Playing <b style={{ color: track?.color }}>{track?.name ?? "no track"}</b></span>
        <button onClick={() => session.shiftOctave(-1)} aria-label="Octave down">Z ◀</button>
        <span data-testid="live-octave">C{s.octave}</span>
        <button onClick={() => session.shiftOctave(1)} aria-label="Octave up">▶ X</button>
        <button onClick={() => session.shiftVelocity(-16)} aria-label="Velocity down">C −</button>
        <span data-testid="live-velocity">vel {s.velocity}</span>
        <button onClick={() => session.shiftVelocity(16)} aria-label="Velocity up">+ V</button>
        <button className={`ws-rec ${s.armed ? "on" : ""}`} data-testid="rec-arm" aria-pressed={s.armed} onClick={() => session.setArmed(!s.armed)} title="When armed, notes played while the transport runs are written to the selected track (one undo step per take)">● {s.recording ? "Recording" : s.armed ? "Armed" : "Rec"}</button>
        {s.lastTake && <span data-testid="last-take">last take: {s.lastTake.notes} notes, {s.lastTake.ccs} CC, {s.lastTake.bends} bends</span>}
        {sink.latencyMs != null && <span>~{sink.latencyMs} ms</span>}
      </div>
      <div className="ws-row ws-dim" data-testid="midi-input">
        {midi.status.kind === "ready"
          ? <><select aria-label="MIDI input device" value={midi.selectedId} onChange={(e) => midi.select(e.target.value)} data-testid="midi-device">
              <option value="all">All MIDI inputs</option>
              {midi.devices.map((d) => <option key={d.id} value={d.id}>{d.name}{d.manufacturer ? ` (${d.manufacturer})` : ""}</option>)}
            </select><button onClick={() => midi.disable()}>Disable MIDI</button></>
          : <button onClick={() => { void sink.prepare().catch(() => undefined); void midi.enable(); }} data-testid="midi-enable">Enable MIDI</button>}
        <span data-testid="midi-status" data-kind={midi.status.kind} className={midi.status.kind === "unsupported" || midi.status.kind === "denied" || midi.status.kind === "error" ? "ws-warn" : ""}>{midi.status.message}</span>
        {sink.error && <span className="ws-warn">Audio: {sink.error}</span>}
      </div>
      <div className="ws-piano" role="group" aria-label="Piano keyboard">
        {notes.map((n) => {
          const off = n - base, black = BLACK.has(n % 12), lit = s.active.includes(n);
          return (
            <button key={n} type="button" data-note={n} data-testid={`key-${n}`} aria-label={`${NAMES[n % 12]}${Math.floor(n / 12) - 1}`} aria-pressed={lit}
              className={`ws-pkey ${black ? "black" : "white"} ${lit ? "lit" : ""}`}
              onPointerDown={press(n)} onPointerUp={release(n)} onPointerCancel={release(n)} onPointerLeave={(e) => { if (e.buttons) session.noteOff(n); }}>
              {LETTER_FOR_OFFSET[off] && <span className="ws-pkey-hint">{LETTER_FOR_OFFSET[off]}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
