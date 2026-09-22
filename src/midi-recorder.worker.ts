export interface WorkerStats {
  receivedEvents: number;
  receivedBytes: number;
  receivedBatches: number;
  durationMs: number;
  p50LatencyMs: number;
  p99LatencyMs: number;
}

interface BatchMessage {
  type: "batch";
  events: Float64Array;
  startMs: number;
  endMs: number;
  enqueueStart?: number;
}

interface StatsMessage {
  type: "stats";
}

interface ResetMessage {
  type: "reset";
}

type IncomingMessage = BatchMessage | StatsMessage | ResetMessage;

const HEADER_FIELDS = 3; // deltaMs, byteCount, channelCommandHint

let receivedEvents = 0;
let receivedBytes = 0;
let receivedBatches = 0;
let durationMs = 0;
let firstStartMs: number | null = null;
let lastEndMs = 0;
const latencySamples: number[] = [];

function decodeBatch(typed: Float64Array): Array<{ deltaMs: number; bytes: number[] }> {
  const out: Array<{ deltaMs: number; bytes: number[] }> = [];
  let i = 0;
  while (i < typed.length) {
    const deltaMs = typed[i];
    const byteCount = typed[i + 1];
    const bytes: number[] = [];
    for (let j = 0; j < byteCount; j++) {
      bytes.push(typed[i + HEADER_FIELDS + j]);
    }
    out.push({ deltaMs, bytes });
    i += HEADER_FIELDS + byteCount;
  }
  return out;
}

function updateStats(batch: BatchMessage): void {
  const events = decodeBatch(batch.events);
  receivedEvents += events.length;
  for (const ev of events) {
    receivedBytes += ev.bytes.length;
  }
  receivedBatches += 1;
  if (firstStartMs == null) {
    firstStartMs = batch.startMs;
  }
  lastEndMs = Math.max(lastEndMs, batch.endMs);
  durationMs = Math.max(0, lastEndMs - firstStartMs);
  if (typeof batch.enqueueStart === "number") {
    latencySamples.push(performance.now() - batch.enqueueStart);
  }
}

function handleStats(): void {
  latencySamples.sort((a, b) => a - b);
  const stats: WorkerStats = {
    receivedEvents,
    receivedBytes,
    receivedBatches,
    durationMs,
    p50LatencyMs: latencySamples[Math.floor(latencySamples.length * 0.5)] ?? 0,
    p99LatencyMs: latencySamples[Math.floor(latencySamples.length * 0.99)] ?? 0,
  };
  self.postMessage({ type: "stats", stats });
}

function handleReset(): void {
  receivedEvents = 0;
  receivedBytes = 0;
  receivedBatches = 0;
  durationMs = 0;
  firstStartMs = null;
  lastEndMs = 0;
  latencySamples.length = 0;
}

self.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "batch":
      updateStats(msg);
      break;
    case "stats":
      handleStats();
      break;
    case "reset":
      handleReset();
      break;
    default:
      // ignore unknown messages
      break;
  }
};

export {};
