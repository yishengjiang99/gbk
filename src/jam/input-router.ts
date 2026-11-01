// Local capture -> (1) immediate local monitor, (2) one send to every peer, with modest redundancy for critical
// events. Raw key releases and pedals are sent as-is (no local sustain deferral). Remote input never enters here.
import { Kind, setHeldBit, type JamEvent, type KindCode } from "../../shared/jam/events.ts";
import type { SynthEvent } from "../sf2-renderer.ts";
import { toSynth } from "./receive-scheduler.ts";

export interface RouterDeps { monitor(e: SynthEvent): void; send(e: JamEvent, redundant: JamEvent[]): void; localToRoomMs(perfMs: number): number; clockRevision(): number; generation(): number; instrumentRevision(): number }
export const REDUNDANT = 3;
export class InputRouter {
  private seq = 0; private nextNoteId = 1;
  private held = new Map<number, number>(); // pitch -> noteId
  private sustain = 0; private sostenuto = 0;
  private recent: JamEvent[] = [];
  sent = 0;
  constructor(private d: RouterDeps) {}
  private make(kind: KindCode, a: number, b: number, capturePerf: number, noteId = 0, stream = 0): JamEvent {
    this.seq = (this.seq + 1) >>> 0;
    return { kind, generation: this.d.generation() & 0xffff, seq: this.seq, roomTimeUs: Math.round(this.d.localToRoomMs(capturePerf) * 1000), stream, channel: 0, a: a & 0x7f, b: b & 0x7f, noteId, instrumentRevision: this.d.instrumentRevision() & 0xffff, clockRevision: this.d.clockRevision() };
  }
  private out(e: JamEvent, critical: boolean) {
    const m = toSynth(e); if (m) this.d.monitor(m);
    this.d.send(e, critical ? this.recent.slice() : []); this.sent++;
    if (critical) { this.recent.unshift(e); if (this.recent.length > REDUNDANT) this.recent.pop(); }
  }
  noteOn(note: number, velocity: number, capturePerf: number, stream = 0) {
    if (velocity <= 0) return this.noteOff(note, capturePerf, stream);
    const prev = this.held.get(note); if (prev) this.out(this.make(Kind.NOTE_OFF, note, 0, capturePerf, prev, stream), true);
    const id = this.nextNoteId = (this.nextNoteId + 1) >>> 0 || 1; this.held.set(note, id);
    this.out(this.make(Kind.NOTE_ON, note, velocity, capturePerf, id, stream), true);
  }
  noteOff(note: number, capturePerf: number, stream = 0) {
    const id = this.held.get(note); if (!id) return; this.held.delete(note);
    this.out(this.make(Kind.NOTE_OFF, note, 0, capturePerf, id, stream), true);
  }
  controlChange(controller: number, value: number, capturePerf: number, stream = 0) {
    if (controller === 64) this.sustain = value; if (controller === 66) this.sostenuto = value;
    this.out(this.make(Kind.CC, controller, value, capturePerf, 0, stream), controller === 64 || controller === 66 || controller >= 120);
  }
  pitchBend(value14: number, capturePerf: number, stream = 0) { this.out(this.make(Kind.BEND, value14 & 0x7f, (value14 >> 7) & 0x7f, capturePerf, 0, stream), false); }
  channelPressure(v: number, capturePerf: number, stream = 0) { this.out(this.make(Kind.CHANNEL_PRESSURE, v, 0, capturePerf, 0, stream), false); }
  polyPressure(note: number, v: number, capturePerf: number, stream = 0) { this.out(this.make(Kind.POLY_PRESSURE, note, v, capturePerf, 0, stream), false); }
  /** Raw MIDI 1.0 bytes from Web MIDI, timestamp = event.timeStamp (performance.now domain). Channel is folded to 0 (one instrument per player in v1). */
  midi(data: Uint8Array, timeStamp: number, stream = 1) {
    const st = data[0] & 0xf0, a = data[1] ?? 0, b = data[2] ?? 0;
    if (st === 0x90) this.noteOn(a, b, timeStamp, stream);
    else if (st === 0x80) this.noteOff(a, timeStamp, stream);
    else if (st === 0xb0) { if (a === 0 || a === 32) return; this.controlChange(a, b, timeStamp, stream); } // bank select is a room instrument choice, not live input
    else if (st === 0xe0) this.pitchBend((b << 7) | a, timeStamp, stream);
    else if (st === 0xd0) this.channelPressure(a, timeStamp, stream);
    else if (st === 0xa0) this.polyPressure(a, b, timeStamp, stream);
    // program change / sysex / clock: ignored here (instrument changes go through the room UI)
  }
  /** Heartbeat + authoritative state; also the source lease keepalive. */
  snapshot(nowPerf: number): JamEvent {
    const held = new Uint8Array(16); for (const n of this.held.keys()) setHeldBit(held, n, true);
    const asOf = this.seq; const e: JamEvent = { ...this.make(Kind.SNAPSHOT, 0, 0, nowPerf), seq: asOf, held, sustain: this.sustain, sostenuto: this.sostenuto }; this.seq = asOf; // snapshots do not consume a sequence number
    return e;
  }
  /** Local panic: release everything locally and tell peers. */
  panic(nowPerf: number) { for (const [n, id] of [...this.held]) { this.held.delete(n); this.out(this.make(Kind.NOTE_OFF, n, 0, nowPerf, id), true); } this.sustain = 0; this.sostenuto = 0; this.out(this.make(Kind.CC, 64, 0, nowPerf), true); this.out(this.make(Kind.PANIC, 0, 0, nowPerf), true); }
  get heldNotes() { return [...this.held.keys()]; }
}
