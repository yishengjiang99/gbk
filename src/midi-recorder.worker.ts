interface RecorderEvent {
  deltaMs: number;
  bytes: number[];
}

interface WorkerBatchMessage {
  type: "batch";
  events: Float64Array;
  startMs: number;
  endMs: number;
}

interface WorkerStatsMessage {
  type: "stats";
  batches: number;
  events: number;
  latencyMs: number;
}

type IncomingMessage =
  | { type: "batch"; events: Float64Array; startMs: number; endMs: number }
  | { type: "flush" }
  | { type: "stats" };

interface StoredBatch {
  events: RecorderEvent[];
  startMs: number;
  endMs: number;
  receivedAt: number;
}

const HEADER_FIELDS = 3;
const MAX_MIDI_MESSAGE_BYTES = 3;

const batches: StoredBatch[] = [];

function decodeBatch(events: Float64Array): RecorderEvent[] {
  const out: RecorderEvent[] = [];
  for (let i = 0; i < events.length; i += HEADER_FIELDS + MAX_MIDI_MESSAGE_BYTES) {
    const deltaMs = events[i];
    const byteCount = Math.max(0, Math.min(MAX_MIDI_MESSAGE_BYTES, events[i + 1]));
    const bytes: number[] = [];
    for (let j = 0; j < byteCount; j++) {
      bytes.push(events[i + HEADER_FIELDS + j]);
    }
    out.push({ deltaMs, bytes });
  }
  return out;
}

function handleBatch(msg: WorkerBatchMessage, receivedAt: number): void {
  const decoded = decodeBatch(msg.events);
  batches.push({
    events: decoded,
    startMs: msg.startMs,
    endMs: msg.endMs,
    receivedAt,
  });
}

function handleFlush(): void {
  const eventCount = batches.reduce((sum, b) => sum + b.events.length, 0);
  self.postMessage({ type: "flushed", batches: batches.length, events: eventCount });
}

function handleStats(): void {
  const eventCount = batches.reduce((sum, b) => sum + b.events.length, 0);
  const latencyMs = batches.length
    ? batches[batches.length - 1].receivedAt - batches[0].receivedAt
    : 0;
  const msg: WorkerStatsMessage = {
    type: "stats",
    batches: batches.length,
    events: eventCount,
    latencyMs,
  };
  self.postMessage(msg);
}

self.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data;
  const receivedAt = performance.now();
  switch (msg.type) {
    case "batch":
      handleBatch(msg, receivedAt);
      break;
    case "flush":
      handleFlush();
      break;
    case "stats":
      handleStats();
      break;
  }
};

export {};
