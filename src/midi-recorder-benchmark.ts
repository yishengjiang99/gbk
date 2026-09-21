import { createMidiRecorder, MidiRecorderBatch } from "./midi-recorder.ts";

export interface BenchmarkResult {
  batchSize: number;
  totalEvents: number;
  messageCount: number;
  totalTimeMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
}

interface TimedBatch {
  events: number;
  queuedAt: number;
  processedAt: number;
}

export function runBatchBenchmark(totalEvents = 5000): BenchmarkResult[] {
  const batchSizes = [1, 8, 32, 128];
  return batchSizes.map((batchSize) => runBenchmarkForBatchSize(batchSize, totalEvents));
}

function runBenchmarkForBatchSize(batchSize: number, totalEvents: number): BenchmarkResult {
  const timedBatches: TimedBatch[] = [];
  const startMs = performance.now();

  const recorder = createMidiRecorder({
    batchSize,
    onBatch: (batch: MidiRecorderBatch, _typed: Float64Array) => {
      // Simulate worker decode/processing cost proportional to batch length.
      const processedAt = performance.now();
      timedBatches.push({
        events: batch.events.length,
        queuedAt: startMs + batch.startMs,
        processedAt,
      });
    },
  });

  recorder.start();
  for (let i = 0; i < totalEvents; i++) {
    const channel = i % 16;
    const note = 60 + (i % 24);
    const isNoteOn = i % 2 === 0;
    const status = isNoteOn ? 0x90 | channel : 0x80 | channel;
    const velocity = isNoteOn ? Math.max(1, i % 127) : 0;
    recorder.recordMessage(startMs + i * 0.1, [status, note, velocity]);
  }
  recorder.stop();

  // Any remaining partial batch is considered delivered immediately at stop.
  const finalMs = performance.now();
  for (const pending of recorder.pendingBatch) {
    timedBatches.push({
      events: 1,
      queuedAt: startMs + pending.deltaMs,
      processedAt: finalMs,
    });
  }

  const latencies = timedBatches.map((b) => b.processedAt - b.queuedAt).sort((a, b) => a - b);
  const p99Index = Math.max(0, Math.ceil(latencies.length * 0.99) - 1);

  return {
    batchSize,
    totalEvents,
    messageCount: timedBatches.length,
    totalTimeMs: finalMs - startMs,
    p99LatencyMs: latencies[p99Index] ?? 0,
    maxLatencyMs: latencies[latencies.length - 1] ?? 0,
  };
}

export function recommendBatchSize(results: BenchmarkResult[]): number {
  const baseline = results.find((r) => r.batchSize === 1);
  if (!baseline) return 32;
  const eligible = results
    .filter((r) => r.batchSize > 1)
    .filter((r) => r.p99LatencyMs < 10)
    .filter((r) => (1 - r.messageCount / baseline.messageCount) >= 0.75)
    .sort((a, b) => a.batchSize - b.batchSize);
  return eligible[0]?.batchSize ?? 32;
}
