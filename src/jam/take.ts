// Take recording: explicitly started and stopped by the user, local to this browser. Captures every player's
// events at their sender's room-clock capture time (not the jittery arrival time) and turns them into an
// editable workstation project, one track per player, on the metronome's bar grid when it was running.
import { Kind, type JamEvent } from "../../shared/jam/events.ts";
import type { TransportState } from "../../shared/jam/signaling.ts";
import { DEFAULT_MIX, emptyProject, newId, TRACK_COLORS, type Project } from "../workstation/model.ts";

interface Rec { pid: string; ms: number; e: JamEvent }
export class TakeRecorder {
  recording = false; startMs = 0; stopMs = 0; private events: Rec[] = []; private seen = new Set<string>(); private transport: TransportState | null = null;
  start(roomMs: number, t: TransportState | null) { this.recording = true; this.startMs = roomMs; this.stopMs = 0; this.events = []; this.seen.clear(); this.transport = t?.running ? t : null; }
  stop(roomMs: number) { this.recording = false; this.stopMs = roomMs; }
  get count() { return this.events.filter((r) => r.e.kind === Kind.NOTE_ON).length; }
  add(pid: string, e: JamEvent) {
    if (!this.recording || (e.kind !== Kind.NOTE_ON && e.kind !== Kind.NOTE_OFF && e.kind !== Kind.CC)) return;
    const k = `${pid}:${e.generation}:${e.seq}`; if (this.seen.has(k)) return; this.seen.add(k); // redundancy copies
    const ms = e.roomTimeUs / 1000; if (ms < this.startMs - 5) return;
    this.events.push({ pid, ms, e });
  }
  /** Editable project. players: pid -> track name + GM program/bank. */
  toProject(players: Map<string, { name: string; bank: number; program: number }>, name = "Live Jam take"): Project {
    const p = emptyProject(name); const t = this.transport; const bpm = t?.bpm ?? 120; const beatMs = 60000 / bpm;
    // Tick 0 = the metronome's bar line at or before the take start (beat 0 of the bar grid), else the take start.
    let origin = this.startMs;
    if (t) { const beat0 = t.anchorRoomTime - t.anchorBeat * beatMs; const bars = Math.floor((this.startMs - beat0) / (beatMs * t.beatsPerBar)); origin = beat0 + bars * beatMs * t.beatsPerBar; }
    p.tempos = [{ tick: 0, microPerQuarter: Math.round(beatMs * 1000) }]; p.timeSigs = [{ tick: 0, numerator: t?.beatsPerBar ?? 4, denominator: 4 }];
    const tick = (ms: number) => Math.max(0, Math.round(((ms - origin) / beatMs) * p.ppq));
    const end = this.stopMs || Math.max(this.startMs, ...this.events.map((r) => r.ms));
    const pids = [...new Set(this.events.map((r) => r.pid))];
    pids.forEach((pid, i) => {
      const info = players.get(pid) ?? { name: pid, bank: 0, program: 0 }; const drums = info.bank === 128; const channel = drums ? 9 : i >= 9 ? i + 1 : i;
      const trackId = newId("trk");
      p.tracks.push({ id: trackId, name: info.name, channel, color: TRACK_COLORS[i % TRACK_COLORS.length], mix: { ...DEFAULT_MIX }, visible: true });
      p.programs.push({ id: newId("pg"), trackId, channel, tick: 0, program: info.program, bankMsb: drums ? 0 : info.bank, bankLsb: 0 });
      const open = new Map<number, Rec>();
      const finish = (on: Rec, offMs: number) => { const s = tick(on.ms); p.notes.push({ id: newId("n"), trackId, channel, tick: s, duration: Math.max(1, tick(offMs) - s), pitch: on.e.a, velocity: on.e.b }); };
      for (const r of this.events.filter((x) => x.pid === pid).sort((a, b) => a.ms - b.ms)) {
        if (r.e.kind === Kind.NOTE_ON) { const prev = open.get(r.e.noteId); if (prev) finish(prev, r.ms); open.set(r.e.noteId, r); }
        else if (r.e.kind === Kind.NOTE_OFF) { const on = open.get(r.e.noteId); if (on) { finish(on, r.ms); open.delete(r.e.noteId); } }
        else p.ccs.push({ id: newId("cc"), trackId, channel, controller: r.e.a, tick: tick(r.ms), value: r.e.b });
      }
      for (const on of open.values()) finish(on, end); // still held at stop
    });
    p.notes.sort((a, b) => a.tick - b.tick); p.ccs.sort((a, b) => a.tick - b.tick);
    p.endTick = Math.max(tick(end), ...p.notes.map((n) => n.tick + n.duration)); p.meta = { owner: "user", createdAt: Date.now() };
    return p;
  }
}
