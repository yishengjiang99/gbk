// Client <-> room clock estimate from signaling ping/pong. Room time = the signaling server's monotonic
// performance.now() (ms). With one server stamp ts (t1 = t2): rtt = t3 - t0, offset(room - local) = ts - (t0 + t3) / 2.
// Filtering keeps the low-RTT samples (least queueing) and takes their median offset. Unknown path asymmetry
// cannot be filtered out, so `uncertaintyMs` is at least half the best RTT.
export interface ClockSample { t0: number; ts: number; t3: number }
export class ClockEstimator {
  private samples: { offset: number; rtt: number; at: number }[] = [];
  offsetMs = 0; uncertaintyMs = Infinity; revision = 0; rttMs = NaN;
  constructor(private size = 16, private resetGapMs = 10_000) {}
  get ready() { return this.samples.length > 0; }
  /** Feed one exchange; returns false for an implausible sample (negative RTT). */
  add(s: ClockSample): boolean {
    const rtt = s.t3 - s.t0; if (!(rtt >= 0) || rtt > 10_000) return false;
    const last = this.samples[this.samples.length - 1];
    if (last && s.t3 - last.at > this.resetGapMs) this.reset(); // sleep/resume: old mapping is stale
    this.samples.push({ offset: s.ts - (s.t0 + s.t3) / 2, rtt, at: s.t3 });
    if (this.samples.length > this.size) this.samples.shift();
    const minRtt = Math.min(...this.samples.map((x) => x.rtt));
    const good = this.samples.filter((x) => x.rtt <= minRtt * 1.5 + 1).map((x) => x.offset).sort((a, b) => a - b);
    const off = good[good.length >> 1];
    const spread = good.length > 1 ? (good[good.length - 1] - good[0]) / 2 : 0;
    if (!this.ready || Math.abs(off - this.offsetMs) > 0.5 || this.revision === 0) this.revision = (this.revision + 1) & 0xffff;
    this.offsetMs = off; this.uncertaintyMs = minRtt / 2 + spread; this.rttMs = rtt;
    return true;
  }
  reset() { this.samples = []; this.uncertaintyMs = Infinity; this.revision = (this.revision + 1) & 0xffff; }
  /** Server epoch changed: a new timebase. */
  rebase() { this.reset(); this.offsetMs = 0; }
  localToRoom(localMs: number) { return localMs + this.offsetMs; }
  roomToLocal(roomMs: number) { return roomMs - this.offsetMs; }
}
