// Per-peer receive path: generation check -> replay window -> reconciler -> adaptive delay budget -> timed engine events.
// Remote capture time (room clock) maps to local performance time, plus a per-peer budget = p95 observed transit
// + jitter allowance (hysteresis: grows at once, shrinks slowly). Late attacks past the deadline are dropped and
// counted; releases, pedals and panic are applied as soon as possible regardless of lateness.
import { Kind, type JamEvent } from "../../shared/jam/events.ts";
import { ReplayWindow } from "./dedupe.ts";
import { NoteReconciler } from "./reconciler.ts";
import type { SynthEvent } from "../sf2-renderer.ts";
import { synthEvent } from "../synth-ingress.ts";

export interface TimedSink { /** Schedule at local performance time (ms); null = as soon as possible. */ schedule(perfMs: number | null, e: SynthEvent): void; clear(): void }
export interface SchedulerOptions { jitterAllowanceMs?: number; maxBudgetMs?: number; lateAttackDropMs?: number; leaseMs?: number; degradedBudgetMs?: number }
export const DEFAULTS: Required<SchedulerOptions> = { jitterAllowanceMs: 5, maxBudgetMs: 80, lateAttackDropMs: 40, leaseMs: 1000, degradedBudgetMs: 40 };

/** JamEvent -> engine message through the shared synth-ingress builders (channel kept; isolation is per engine). */
export function toSynth(e: JamEvent): SynthEvent | null {
  switch (e.kind) {
    case Kind.NOTE_ON: return synthEvent.noteOn(e.channel, e.a, e.b);
    case Kind.NOTE_OFF: return synthEvent.noteOff(e.channel, e.a);
    case Kind.CC: return synthEvent.controlChange(e.channel, e.a, e.b);
    case Kind.BEND: return synthEvent.pitchBend(e.channel, (e.b << 7) | e.a);
    case Kind.CHANNEL_PRESSURE: return synthEvent.channelPressure(e.channel, e.a);
    case Kind.POLY_PRESSURE: return synthEvent.polyPressure(e.channel, e.a, e.b);
    default: return null;
  }
}

export class ReceiveScheduler {
  generation = -1;
  private window = new ReplayWindow();
  readonly reconciler = new NoteReconciler();
  private transits: number[] = [];
  budgetMs: number; lastHeard = -Infinity; private lastTarget = -Infinity; private lastShrink = 0;
  stats = { events: 0, attacks: 0, lateAttacksDropped: 0, lateApplied: 0, staleGeneration: 0, leaseExpiries: 0, malformed: 0 };
  private o: Required<SchedulerOptions>;
  constructor(private sink: TimedSink, private roomToLocal: (roomMs: number) => number, private now: () => number, opts: SchedulerOptions = {}) {
    this.o = { ...DEFAULTS, ...opts }; this.budgetMs = this.o.jitterAllowanceMs;
  }
  get replay() { return this.window; }
  get quality(): "unknown" | "good" | "ok" | "degraded" {
    if (this.transits.length < 5) return "unknown";
    const loss = this.window.gaps / Math.max(1, this.window.received + this.window.gaps);
    return this.budgetMs > this.o.degradedBudgetMs || loss > 0.05 ? "degraded" : this.budgetMs > 20 || loss > 0.01 ? "ok" : "good";
  }
  /** Signaling says this peer reconnected with a new generation: release its old notes, forget its old stream. */
  setGeneration(g: number) {
    if (g === this.generation) return;
    if (this.generation >= 0) this.releaseAll();
    this.generation = g; this.window = new ReplayWindow(); this.lastTarget = -Infinity;
  }
  receive(events: JamEvent[]) {
    const arrival = this.now();
    for (const e of events) {
      if (this.generation >= 0 && e.generation !== (this.generation & 0xffff)) { this.stats.staleGeneration++; continue; }
      // Snapshots carry the as-of watermark in `seq` (no sequence of their own): idempotent, never deduped.
      if (e.kind !== Kind.SNAPSHOT && !this.window.accept(e.seq)) continue;
      this.lastHeard = arrival; this.stats.events++;
      const capture = this.roomToLocal(e.roomTimeUs / 1000);
      this.observe(arrival - capture, arrival);
      for (const r of this.reconciler.apply(e)) this.emit(r.event, capture, arrival, !!r.synthetic);
    }
  }
  private observe(transit: number, now: number) {
    if (!Number.isFinite(transit)) return;
    this.transits.push(transit); if (this.transits.length > 64) this.transits.shift();
    const s = [...this.transits].sort((a, b) => a - b); const p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
    const want = Math.min(this.o.maxBudgetMs, Math.max(0, p95 + this.o.jitterAllowanceMs));
    if (want > this.budgetMs) this.budgetMs = want;
    else if (now - this.lastShrink > 1000) { this.budgetMs = Math.max(want, this.budgetMs - 0.5); this.lastShrink = now; }
  }
  private emit(e: JamEvent, capture: number, arrival: number, synthetic: boolean) {
    const m = toSynth(e); if (!m) return;
    const attack = e.kind === Kind.NOTE_ON;
    let target: number | null = synthetic ? null : capture + this.budgetMs;
    if (target !== null && target < arrival) {
      if (attack && arrival - target > this.o.lateAttackDropMs) { this.stats.lateAttacksDropped++; return; }
      this.stats.lateApplied++; target = null;
    }
    // Commit order per source: never schedule before an already committed event.
    if (target !== null) { target = Math.max(target, this.lastTarget); this.lastTarget = target; }
    if (attack) this.stats.attacks++;
    this.sink.schedule(target, m);
  }
  /** Call periodically: no packet (events or heartbeats) for leaseMs -> release this source. */
  checkLease() { if (Number.isFinite(this.lastHeard) && this.now() - this.lastHeard > this.o.leaseMs) { this.stats.leaseExpiries++; this.lastHeard = -Infinity; this.releaseAll(); } }
  releaseAll() { this.sink.clear(); for (const r of this.reconciler.releaseAll()) { const m = toSynth(r.event); if (m) this.sink.schedule(null, m); } }
  snapshotStats() { return { ...this.stats, budgetMs: Math.round(this.budgetMs * 10) / 10, quality: this.quality, gaps: this.window.gaps, duplicates: this.window.duplicates, received: this.window.received, held: this.reconciler.heldCount, ...this.reconciler.stats }; }
}
