import type { WorkerStats } from "./midi-recorder.worker";
import RecorderWorker from "./midi-recorder.worker.ts?worker";

export interface BenchmarkResult {
  batchSize: number;
  messageCount: number;
  totalTimeMs: number;
  p99LatencyMs: number;
  medianLatencyMs: number;
  recommended: boolean;
}

function createRecorderWorker(): Worker {
  return new RecorderWorker();
}

function buildEvents(count: number): Array<{ timeMs: number; bytes: number[] }> {
  const events: Array<{ timeMs: number; bytes: number[] }> = [];
  const channels = 16;
  const notes = 88;
  const baseMs = performance.now();
  for (let i = 0; i < count; i++) {
    const channel = i % channels;
    const note = 21 + (i % notes);
    const velocity = 60 + ((i * 7) % 68);
    if (i % 3 === 0) {
      events.push({
        timeMs: baseMs + i * 0.5 + Math.random() * 0.05,
        bytes: [0x80 | channel, note, velocity],
      });
    } else {
      events.push({
        timeMs: baseMs + i * 0.5 + Math.random() * 0.05,
        bytes: [0x90 | channel, note, velocity],
      });
    }
  }
  return events;
}

function encodeEventsHeader(events: Array<{ deltaMs: number; bytes: number[] }>): Float64Array {
  const HEADER_FIELDS = 3;
  let payloadBytes = 0;
  for (const ev of events) payloadBytes += ev.bytes.length;
  const out = new Float64Array(events.length * HEADER_FIELDS + payloadBytes);
  let offset = 0;
  for (const ev of events) {
    out[offset++] = ev.deltaMs;
    out[offset++] = ev.bytes.length;
    out[offset++] =
      ev.bytes.length > 0 &&
      (ev.bytes[0] & 0x80) !== 0 &&
      (ev.bytes[0] & 0xf0) >= 0x80 &&
      (ev.bytes[0] & 0xf0) <= 0xe0
        ? ev.bytes[0]
        : 0;
    for (const b of ev.bytes) out[offset++] = b;
  }
  return out;
}

export async function runBenchmarkForBatchSize(
  batchSize: number,
  eventCount = 5000
): Promise<BenchmarkResult> {
  const worker = createRecorderWorker();
  const events = buildEvents(eventCount);
  const latencies: number[] = [];
  let sentMessages = 0;

  return new Promise((resolve) => {
    const startMs = performance.now();
    let currentBatch: Array<{ deltaMs: number; bytes: number[] }> = [];
    let currentEnqueueTimes: number[] = [];
    let batchStartDelta = 0;
    let recordStartMs: number | null = null;

    worker.onmessage = (event: MessageEvent<{ type: string; stats?: WorkerStats }>) => {
      const msg = event.data;
      if (msg.type === "stats" && msg.stats) {
        const totalTimeMs = performance.now() - startMs;
        worker.terminate();

        const p99 = msg.stats.p99LatencyMs;
        const median = msg.stats.p50LatencyMs;

        const baselineMessages = eventCount;
        const reduction = 1 - sentMessages / baselineMessages;
        const recommended = reduction >= 0.75 && p99 < 10;

        resolve({
          batchSize,
          messageCount: sentMessages,
          totalTimeMs,
          p99LatencyMs: p99,
          medianLatencyMs: median,
          recommended,
        });
      }
    };

    for (const event of events) {
      if (recordStartMs == null) recordStartMs = event.timeMs;
      const deltaMs = event.timeMs - recordStartMs;
      if (currentBatch.length === 0) batchStartDelta = deltaMs;
      currentBatch.push({ deltaMs, bytes: event.bytes });
      currentEnqueueTimes.push(performance.now());

      if (currentBatch.length >= batchSize) {
        const typed = encodeEventsHeader(currentBatch);
        const enqueueStart = currentEnqueueTimes[0];
        worker.postMessage(
          {
            type: "batch",
            events: typed,
            startMs: batchStartDelta,
            endMs: deltaMs,
            enqueueStart,
          },
          [typed.buffer]
        );
        sentMessages += 1;
        currentBatch = [];
        currentEnqueueTimes = [];
      }
    }

    if (currentBatch.length > 0) {
      const typed = encodeEventsHeader(currentBatch);
      const enqueueStart = currentEnqueueTimes[0];
      worker.postMessage(
        {
          type: "batch",
          events: typed,
          startMs: batchStartDelta,
          endMs: currentBatch[currentBatch.length - 1].deltaMs,
          enqueueStart,
        },
        [typed.buffer]
      );
      sentMessages += 1;
    }

    // Request stats after giving the worker a chance to process. In a real
    // browser this lets us measure actual enqueue-to-receipt latency.
    requestAnimationFrame(() => {
      worker.postMessage({ type: "stats" });
    });
  });
}

export async function runBatchBenchmark(eventCount = 5000): Promise<BenchmarkResult[]> {
  const sizes = [1, 8, 32, 128];
  const results: BenchmarkResult[] = [];
  for (const size of sizes) {
    results.push(await runBenchmarkForBatchSize(size, eventCount));
  }
  return results;
}

export function selectRecommended(results: BenchmarkResult[]): BenchmarkResult | null {
  for (const r of results) {
    if (r.recommended) return r;
  }
  return null;
}
