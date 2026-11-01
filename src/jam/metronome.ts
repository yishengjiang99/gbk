// Shared metronome: clicks are computed from the room transport (see TransportState) and scheduled on the local
// audio clock through the clock estimator, a short lookahead at a time. Beats < 0 are the count-in.
import type { TransportState } from "../../shared/jam/signaling.ts";
import { synthEvent } from "../synth-ingress.ts";
import type { SynthEvent } from "../sf2-renderer.ts";

export const CLICK_PID = "__click";
export interface Click { beat: number; roomMs: number; accent: boolean; countIn: boolean }

/** Beats with room time in [fromMs, toMs). */
export function beatsBetween(t: TransportState, fromMs: number, toMs: number): Click[] {
  if (!t.running || toMs <= fromMs) return [];
  const beatMs = 60000 / t.bpm; const out: Click[] = [];
  for (let b = Math.max(t.anchorBeat, Math.ceil(t.anchorBeat + (fromMs - t.anchorRoomTime) / beatMs)); ; b++) {
    const at = t.anchorRoomTime + (b - t.anchorBeat) * beatMs; if (at >= toMs) break; if (at < fromMs) continue;
    out.push({ beat: b, roomMs: at, accent: ((b % t.beatsPerBar) + t.beatsPerBar) % t.beatsPerBar === 0, countIn: b < 0 });
  }
  return out;
}

export interface MetronomeDeps { roomToLocal(ms: number): number; localToRoom(ms: number): number; post(perfMs: number, e: SynthEvent): void; clear(): void; now(): number }
export class Metronome {
  transport: TransportState | null = null; enabled = true; lastBeat: Click | null = null;
  private scheduledTo = -Infinity; private prev: TransportState | null = null; scheduled = 0;
  constructor(private d: MetronomeDeps, private lookaheadMs = 200) {}
  setTransport(t: TransportState) {
    const prev = this.transport; this.transport = t;
    if (!prev || prev.revision === t.revision) return;
    this.prev = prev.running && t.running ? prev : null; // old tempo keeps clicking until the new anchor
    if (!t.running) { this.d.clear(); this.scheduledTo = -Infinity; return; }
    // Re-anchors only take effect at or after the old schedule horizon (lead time > lookahead), so nothing to undo.
    if (!prev.running) this.scheduledTo = -Infinity;
  }
  tick() {
    const t = this.transport; if (!t?.running || !this.enabled) return;
    const nowRoom = this.d.localToRoom(this.d.now());
    const from = Math.max(this.scheduledTo, nowRoom), to = nowRoom + this.lookaheadMs;
    const p = this.prev; const split = p ? Math.max(from, Math.min(to, t.anchorRoomTime)) : from;
    const clicks = p ? [...beatsBetween(p, from, split), ...beatsBetween(t, split, to)] : beatsBetween(t, from, to);
    for (const c of clicks) {
      const at = this.d.roomToLocal(c.roomMs); const note = c.accent ? 76 : 77;
      this.d.post(at, synthEvent.noteOn(0, note, c.countIn ? 127 : c.accent ? 115 : 90));
      this.d.post(at + 60, synthEvent.noteOff(0, note));
      this.lastBeat = c; this.scheduled++;
    }
    this.scheduledTo = Math.max(this.scheduledTo, to);
  }
  setEnabled(on: boolean) { this.enabled = on; if (!on) { this.d.clear(); this.scheduledTo = -Infinity; } }
  /** Current beat at local time `localMs` (for UI): {bar, beat, countIn} or null. */
  position(localMs: number) {
    const t = this.transport; if (!t?.running) return null;
    const b = Math.floor(t.anchorBeat + (this.d.localToRoom(localMs) - t.anchorRoomTime) / (60000 / t.bpm));
    if (b < t.anchorBeat) return null;
    return { beat: b, countIn: b < 0, bar: Math.floor(b / t.beatsPerBar) + 1, beatInBar: ((b % t.beatsPerBar) + t.beatsPerBar) % t.beatsPerBar + 1 };
  }
}
