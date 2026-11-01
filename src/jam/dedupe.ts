// Sliding replay window over u32 sequence numbers: accepts reordered packets inside the window once each.
import { seqDistance } from "../../shared/jam/events.ts";
export const REPLAY_WINDOW = 1024;
export class ReplayWindow {
  private top = -1; private seen = new Uint8Array(REPLAY_WINDOW); started = false;
  gaps = 0; duplicates = 0; tooOld = 0; received = 0;
  /** true = first time this sequence is seen and it is inside the window. */
  accept(seq: number): boolean {
    if (!this.started) { this.started = true; this.top = seq >>> 0; this.seen.fill(0); this.seen[seq % REPLAY_WINDOW] = 1; this.received++; return true; }
    const d = seqDistance(seq, this.top);
    if (d > 0) {
      if (d > 1) this.gaps += d - 1;
      for (let i = 1; i <= Math.min(d, REPLAY_WINDOW); i++) this.seen[((this.top + i) >>> 0) % REPLAY_WINDOW] = 0;
      this.top = seq >>> 0; this.seen[seq % REPLAY_WINDOW] = 1; this.received++; return true;
    }
    if (-d >= REPLAY_WINDOW) { this.tooOld++; return false; }
    const k = (seq >>> 0) % REPLAY_WINDOW; if (this.seen[k]) { this.duplicates++; return false; }
    this.seen[k] = 1; if (this.gaps > 0) this.gaps--; this.received++; return true; // filled an earlier gap
  }
}
