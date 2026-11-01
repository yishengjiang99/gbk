// Note-state reconciliation for one remote source (participant + generation). Turns a deduped but possibly
// reordered/lossy event stream into a safe one: duplicate attacks never double-trigger, a release that beats its
// attack leaves a bounded tombstone, an old release never kills a newer note on the same key, and snapshots
// (held keys + pedals as of a sequence number) release notes whose release packet was lost.
// Policy: a lost attack is NOT synthesized later from a snapshot (that would be an unrelated late note).
import { Kind, heldBit, seqNewer, type JamEvent } from "../../shared/jam/events.ts";

export const MAX_TOMBSTONES = 64;
interface Held { noteId: number; seq: number }
export interface Reconciled { event: JamEvent; synthetic?: boolean }

export class NoteReconciler {
  private held = new Map<number, Held>();            // pitch -> current note instance
  private seenNoteIds = new Set<number>();          // bounded memory of attacks applied
  private tombstones = new Map<number, number>();    // noteId -> pitch (release seen before attack)
  private sustain = 0; private sustainSeq = -1;
  private sostenuto = 0; private sostenutoSeq = -1;
  stats = { duplicateAttacks: 0, tombstoned: 0, staleReleases: 0, snapshotReleases: 0, retriggers: 0 };

  get heldCount() { return this.held.size; }
  heldPitches() { return [...this.held.keys()]; }

  apply(e: JamEvent): Reconciled[] {
    switch (e.kind) {
      case Kind.NOTE_ON: {
        if (e.b === 0) return this.apply({ ...e, kind: Kind.NOTE_OFF });
        if (this.seenNoteIds.has(e.noteId)) { this.stats.duplicateAttacks++; return []; }
        this.remember(e.noteId);
        if (this.tombstones.delete(e.noteId)) { this.stats.tombstoned++; return []; }
        const cur = this.held.get(e.a); const out: Reconciled[] = [];
        if (cur) { // same-key retrigger: release the older instance first, unless this attack is the older one
          if (seqNewer(cur.seq, e.seq)) { this.stats.staleReleases++; return []; }
          this.stats.retriggers++; out.push({ event: { ...e, kind: Kind.NOTE_OFF, b: 0, noteId: cur.noteId }, synthetic: true });
        }
        this.held.set(e.a, { noteId: e.noteId, seq: e.seq });
        out.push({ event: e }); return out;
      }
      case Kind.NOTE_OFF: {
        const cur = this.held.get(e.a);
        if (cur && cur.noteId === e.noteId) { this.held.delete(e.a); return [{ event: e }]; }
        if (!this.seenNoteIds.has(e.noteId)) { // attack not seen yet
          this.tombstones.set(e.noteId, e.a); if (this.tombstones.size > MAX_TOMBSTONES) this.tombstones.delete(this.tombstones.keys().next().value!);
          return [];
        }
        this.stats.staleReleases++; return []; // an older instance's release: the key is held by a newer note
      }
      case Kind.CC: {
        if (e.a === 64) { if (seqNewer(this.sustainSeq >>> 0, e.seq) && this.sustainSeq >= 0) return []; this.sustain = e.b; this.sustainSeq = e.seq; }
        if (e.a === 66) { if (seqNewer(this.sostenutoSeq >>> 0, e.seq) && this.sostenutoSeq >= 0) return []; this.sostenuto = e.b; this.sostenutoSeq = e.seq; }
        return [{ event: e }];
      }
      case Kind.PANIC: { const out = this.releaseAll(e); return out; }
      case Kind.SNAPSHOT: return this.snapshot(e);
      default: return [{ event: e }];
    }
  }

  private snapshot(s: JamEvent): Reconciled[] {
    const out: Reconciled[] = []; const held = s.held ?? new Uint8Array(16);
    for (const [pitch, h] of [...this.held]) {
      if (!heldBit(held, pitch) && !seqNewer(h.seq, s.seq)) { // released at or before the watermark
        this.held.delete(pitch); this.stats.snapshotReleases++;
        out.push({ event: { ...s, kind: Kind.NOTE_OFF, a: pitch, b: 0, noteId: h.noteId }, synthetic: true });
      }
    }
    if ((s.sustain ?? 0) !== this.sustain && (this.sustainSeq < 0 || !seqNewer(this.sustainSeq >>> 0, s.seq))) { this.sustain = s.sustain ?? 0; this.sustainSeq = s.seq; out.push({ event: { ...s, kind: Kind.CC, a: 64, b: this.sustain, noteId: 0 }, synthetic: true }); }
    if ((s.sostenuto ?? 0) !== this.sostenuto && (this.sostenutoSeq < 0 || !seqNewer(this.sostenutoSeq >>> 0, s.seq))) { this.sostenuto = s.sostenuto ?? 0; this.sostenutoSeq = s.seq; out.push({ event: { ...s, kind: Kind.CC, a: 66, b: this.sostenuto, noteId: 0 }, synthetic: true }); }
    return out;
  }

  /** Lease expiry / kick / generation change: release this source's notes and pedals. */
  releaseAll(template?: Partial<JamEvent>): Reconciled[] {
    const base = { kind: Kind.NOTE_OFF, generation: 0, seq: 0, roomTimeUs: 0, stream: 0, channel: 0, a: 0, b: 0, noteId: 0, instrumentRevision: 0, clockRevision: 0, ...template } as JamEvent;
    const out: Reconciled[] = [];
    for (const [pitch, h] of this.held) out.push({ event: { ...base, kind: Kind.NOTE_OFF, a: pitch, b: 0, noteId: h.noteId }, synthetic: true });
    out.push({ event: { ...base, kind: Kind.CC, a: 64, b: 0 }, synthetic: true }, { event: { ...base, kind: Kind.CC, a: 66, b: 0 }, synthetic: true }, { event: { ...base, kind: Kind.CC, a: 123, b: 0 }, synthetic: true });
    this.held.clear(); this.sustain = 0; this.sostenuto = 0; this.tombstones.clear();
    return out;
  }
  private remember(id: number) { this.seenNoteIds.add(id); if (this.seenNoteIds.size > 1024) this.seenNoteIds.delete(this.seenNoteIds.values().next().value!); }
}
