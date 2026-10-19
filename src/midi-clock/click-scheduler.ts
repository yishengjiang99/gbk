// Click scheduling + synthesis against the audio clock. Pure (no AudioWorklet globals): the AudioWorklet
// processor is a thin wrapper, and node tests drive process() with synthetic render blocks.
//
// Allocation policy: everything (voice state, click log) is preallocated in the constructor. process() and
// setSchedule() create no objects/arrays/closures. The log is read out via drainLog() from a message handler
// (outside the render loop).

export const LATE_TOLERANCE_S = 0.12;
const LOG_CAPACITY = 512; // clicks; flushed by the main thread at ~4 Hz, 2 clicks/s at 120 BPM

export class ClickScheduler {
  private running = false;
  private runId = -1;
  private firstBeat = 0;
  private anchorBeat = 0;
  private anchorTimeS = 0;
  private beatPeriodS = 0;
  private lastFired = -1;

  // voice
  private active = false;
  private phase = 0;
  private phaseInc = 0;
  private amp = 0;
  private decay = 0;
  private samplesLeft = 0;
  private startOffset = 0;

  private readonly log = new Float64Array(LOG_CAPACITY * 3);
  private logWrite = 0;
  private logUnread = 0;

  totalFired = 0;
  skipped = 0;
  blocks = 0;

  constructor(private readonly sampleRate: number) {}

  setSchedule(
    running: boolean, runId: number, firstBeat: number, anchorBeat: number, anchorTimeS: number, beatPeriodS: number,
  ): void {
    if (runId !== this.runId) {
      this.runId = runId;
      this.lastFired = firstBeat - 1; // new Start/Continue: nothing fired yet in this run
    }
    this.running = running;
    this.firstBeat = firstBeat;
    this.anchorBeat = anchorBeat;
    this.anchorTimeS = anchorTimeS;
    this.beatPeriodS = beatPeriodS;
    if (this.lastFired < firstBeat - 1) this.lastFired = firstBeat - 1;
  }

  /** Render one block starting at audio time `blockStartS`. Adds the click into outL/outR. */
  process(blockStartS: number, outL: Float32Array, outR: Float32Array | undefined): void {
    this.blocks++;
    const frames = outL.length;
    const sr = this.sampleRate;
    const blockEndS = blockStartS + frames / sr;

    if (this.running) {
      for (;;) {
        const k = this.lastFired + 1;
        let t: number;
        if (this.beatPeriodS > 0) t = this.anchorTimeS + (k - this.anchorBeat) * this.beatPeriodS;
        else if (k === this.anchorBeat) t = this.anchorTimeS;
        else break; // period unknown: only the anchor beat can be fired
        if (t >= blockEndS) break;
        this.lastFired = k;
        if (t < blockStartS - LATE_TOLERANCE_S) { this.skipped++; continue; }
        let f = t < blockStartS ? 0 : Math.round((t - blockStartS) * sr);
        if (f >= frames) f = frames - 1;
        this.trigger(k, f, t, blockStartS + f / sr);
      }
    }

    if (!this.active) return;
    let n = this.startOffset;
    this.startOffset = 0;
    for (; n < frames && this.samplesLeft > 0; n++) {
      const v = Math.sin(this.phase) * this.amp;
      this.phase += this.phaseInc;
      if (this.phase > 6.283185307179586) this.phase -= 6.283185307179586;
      this.amp *= this.decay;
      this.samplesLeft--;
      outL[n] += v;
      if (outR) outR[n] += v;
    }
    if (this.samplesLeft <= 0) this.active = false;
  }

  private trigger(beat: number, frame: number, scheduledS: number, renderedS: number): void {
    const freq = beat % 4 === 0 ? 1500 : 1000;
    this.phase = 0;
    this.phaseInc = (2 * Math.PI * freq) / this.sampleRate;
    this.amp = 0.5;
    this.decay = Math.exp(-1 / (0.006 * this.sampleRate));
    this.samplesLeft = Math.round(0.04 * this.sampleRate);
    this.startOffset = frame;
    this.active = true;
    this.totalFired++;
    const w = this.logWrite * 3;
    this.log[w] = beat;
    this.log[w + 1] = scheduledS;
    this.log[w + 2] = renderedS;
    this.logWrite = (this.logWrite + 1) % LOG_CAPACITY;
    if (this.logUnread < LOG_CAPACITY) this.logUnread++;
  }

  /** Copy unread log entries into a new Float64Array (called from a message handler, not process()). */
  drainLog(): Float64Array {
    const n = this.logUnread;
    const out = new Float64Array(n * 3);
    let r = (this.logWrite - n + LOG_CAPACITY) % LOG_CAPACITY;
    for (let i = 0; i < n; i++) {
      const s = r * 3;
      out[i * 3] = this.log[s]; out[i * 3 + 1] = this.log[s + 1]; out[i * 3 + 2] = this.log[s + 2];
      r = (r + 1) % LOG_CAPACITY;
    }
    this.logUnread = 0;
    return out;
  }
}
