interface RecorderEvent {
  deltaMs: number;
  status: number;
  data1: number;
  data2: number;
}

interface WorkerBatchMessage {
  type: "batch";
  events: Float64Array;
  startMs: number;
  endMs: number;
}

interface WorkerFlushMessage {
  type: "flush";
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

const batches: StoredBatch[] = [];

function decodeBatch(events: Float64Array): RecorderEvent[] {
  const out: RecorderEvent[] = [];
  for (let i = 0; i < events.length; i += 8) {
    out.push({
      deltaMs: events[i],
      status: events[i + 1],
      data1: events[i + 2],
      data2: events[i + 3],
    });
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
