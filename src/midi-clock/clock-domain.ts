// Clock-domain conversion between the three time bases used by the demo.
//
//   Web MIDI event.timeStamp, main-thread performance.now()   : ms, origin = main window timeOrigin
//   Worker performance.now()                                  : ms, origin = worker timeOrigin (different!)
//   AudioContext.currentTime / AudioWorklet `currentTime`     : seconds, origin = context creation
//
// Pure helpers; the browser glue samples AudioContext.getOutputTimestamp() and feeds it to ClockDomainMap.

/** Convert a worker-local performance.now() to the main-thread performance.now() domain. */
export function workerToMainMs(workerNowMs: number, workerTimeOrigin: number, mainTimeOrigin: number): number {
  return workerNowMs + (workerTimeOrigin - mainTimeOrigin);
}

/**
 * Maps main-thread performance.now() milliseconds to AudioContext seconds.
 *
 * `getOutputTimestamp()` returns a pair {contextTime, performanceTime} that describe the same instant: the
 * sample currently leaving the audio device. So `audioTime = contextTime + (perfMs - performanceTime)/1000`,
 * and a sound rendered at audio time T is heard at the performance time that maps to T (no extra output
 * latency term is needed). Individual pairs are noisy (they are quantised to render quanta/OS buffers), so
 * the offset `perfMs/1000 - contextTime` is the median of the last `size` samples.
 */
export class ClockDomainMap {
  private readonly offsets: Float64Array;
  private readonly scratch: Float64Array;
  private head = 0;
  private len = 0;
  private offset = 0;

  constructor(private readonly size = 15) {
    this.offsets = new Float64Array(size);
    this.scratch = new Float64Array(size);
  }

  get ready(): boolean { return this.len > 0; }
  get samples(): number { return this.len; }

  reset(): void { this.head = 0; this.len = 0; this.offset = 0; }

  /** Feed one getOutputTimestamp() pair (contextTime seconds, performanceTime ms). */
  update(contextTimeS: number, performanceTimeMs: number): void {
    this.offsets[this.head] = performanceTimeMs / 1000 - contextTimeS;
    this.head = (this.head + 1) % this.size;
    if (this.len < this.size) this.len++;
    // insertion-sort median, no allocation
    const n = this.len;
    for (let i = 0; i < n; i++) {
      const v = this.offsets[i];
      let j = i - 1;
      while (j >= 0 && this.scratch[j] > v) { this.scratch[j + 1] = this.scratch[j]; j--; }
      this.scratch[j + 1] = v;
    }
    const mid = n >> 1;
    this.offset = n & 1 ? this.scratch[mid] : 0.5 * (this.scratch[mid - 1] + this.scratch[mid]);
  }

  perfToAudio(perfMs: number): number { return perfMs / 1000 - this.offset; }
  audioToPerf(audioS: number): number { return (audioS + this.offset) * 1000; }
}
