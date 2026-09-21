export interface MidiRecorderEvent {
  deltaMs: number;
  status: number;
  data1: number;
  data2: number;
}

export interface MidiRecorderBatch {
  events: MidiRecorderEvent[];
  startMs: number;
  endMs: number;
}

export type RecorderState = "idle" | "recording" | "stopped";

interface ActiveNote {
  note: number;
  channel: number;
  velocity: number;
  onMs: number;
}

export interface MidiRecorderSnapshot {
  state: RecorderState;
  activeNotes: ActiveNote[];
  pendingCount: number;
  recordedCount: number;
  sentCount?: number;
}

export interface MidiRecorderExports {
  state: RecorderState;
  activeNotes: ReadonlyMap<string, ActiveNote>;
  pendingBatch: MidiRecorderEvent[];
  recordedBatches: MidiRecorderBatch[];
  start(): void;
  stop(): void;
  recordMessage(timestampMs: number, data: ArrayLike<number>): void;
  flush(): void;
  download(filename?: string): void;
  snapshot(): MidiRecorderSnapshot;
  reset(): void;
}

const EVENT_BYTE_LENGTH = 8;

function noteKey(channel: number, note: number): string {
  return `${channel}:${note}`;
}

export function createMidiRecorder(options?: {
  worker?: Worker | null;
  batchSize?: number;
  onBatch?: (batch: MidiRecorderBatch, typed: Float64Array) => void;
}): MidiRecorderExports {
  const BATCH_SIZE = Math.max(1, options?.batchSize ?? 32);
  const worker = options?.worker ?? null;
  const onBatch = options?.onBatch;

  let state: RecorderState = "idle";
  let startMs: number | null = null;
  const activeNotes = new Map<string, ActiveNote>();
  let pendingBatch: MidiRecorderEvent[] = [];
  const recordedBatches: MidiRecorderBatch[] = [];
  let recordedCount = 0;
  let batchStartMs: number | null = null;
  let sentCount = 0;

  function transition(next: RecorderState): void {
    if (state === next) return;
    if (next === "recording") {
      startMs = null;
      batchStartMs = null;
    }
    state = next;
  }

  function encodeEvents(events: MidiRecorderEvent[]): Float64Array {
    const out = new Float64Array(events.length * EVENT_BYTE_LENGTH);
    let offset = 0;
    for (const ev of events) {
      out[offset++] = ev.deltaMs;
      out[offset++] = ev.status;
      out[offset++] = ev.data1;
      out[offset++] = ev.data2;
    }
    return out;
  }

  function pushBatch(): void {
    if (pendingBatch.length === 0) return;
    const batch: MidiRecorderBatch = {
      events: pendingBatch,
      startMs: batchStartMs ?? pendingBatch[0].deltaMs,
      endMs: pendingBatch[pendingBatch.length - 1].deltaMs,
    };
    const typed = encodeEvents(pendingBatch);
    recordedBatches.push(batch);
    recordedCount += pendingBatch.length;

    if (worker) {
      worker.postMessage(
        { type: "batch", events: typed, startMs: batch.startMs, endMs: batch.endMs },
        [typed.buffer]
      );
      sentCount += pendingBatch.length;
    }
    onBatch?.(batch, typed);

    pendingBatch = [];
    batchStartMs = null;
  }

  function recordMessage(timestampMs: number, data: ArrayLike<number>): void {
    if (state !== "recording" || data.length === 0) return;

    if (startMs == null) {
      startMs = timestampMs;
    }
    const deltaMs = timestampMs - startMs;

    const status = Number(data[0]) & 0xff;
    const data1 = data.length > 1 ? Number(data[1]) & 0x7f : 0;
    const data2 = data.length > 2 ? Number(data[2]) & 0x7f : 0;
    const command = status & 0xf0;
    const channel = status & 0x0f;

    if (command === 0x90 && data2 > 0) {
      activeNotes.set(noteKey(channel, data1), { note: data1, channel, velocity: data2, onMs: deltaMs });
    } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
      activeNotes.delete(noteKey(channel, data1));
    } else if (command === 0xb0 && data1 === 64) {
      // Sustain pedal: handled as controller event; active notes intentionally kept.
    } else if (command === 0xb0 && data1 === 123) {
      // All notes off for this channel.
      for (const key of activeNotes.keys()) {
        if (activeNotes.get(key)!.channel === channel) {
          activeNotes.delete(key);
        }
      }
    }

    if (batchStartMs == null) {
      batchStartMs = deltaMs;
    }
    pendingBatch.push({ deltaMs, status, data1, data2 });

    if (pendingBatch.length >= BATCH_SIZE) {
      pushBatch();
    }
  }

  function stop(): void {
    if (state !== "recording") return;
    pushBatch();
    transition("stopped");
  }

  function start(): void {
    reset();
    transition("recording");
  }

  function flush(): void {
    pushBatch();
  }

  function snapshot(): MidiRecorderSnapshot {
    return {
      state,
      activeNotes: Array.from(activeNotes.values()),
      pendingCount: pendingBatch.length,
      recordedCount: recordedCount + pendingBatch.length,
      sentCount: worker ? sentCount : undefined,
    } as MidiRecorderSnapshot;
  }

  function reset(): void {
    state = "idle";
    startMs = null;
    batchStartMs = null;
    activeNotes.clear();
    pendingBatch = [];
    recordedBatches.length = 0;
    recordedCount = 0;
    sentCount = 0;
  }

  function buildTypedEvents(): Float64Array {
    let total = 0;
    for (const batch of recordedBatches) total += batch.events.length;
    total += pendingBatch.length;

    const out = new Float64Array(total * EVENT_BYTE_LENGTH);
    let offset = 0;
    for (const batch of recordedBatches) {
      for (const ev of batch.events) {
        out[offset++] = ev.deltaMs;
        out[offset++] = ev.status;
        out[offset++] = ev.data1;
        out[offset++] = ev.data2;
      }
    }
    for (const ev of pendingBatch) {
      out[offset++] = ev.deltaMs;
      out[offset++] = ev.status;
      out[offset++] = ev.data1;
      out[offset++] = ev.data2;
    }
    return out;
  }

  function download(filename = "recording.json"): void {
    const events: MidiRecorderEvent[] = [];
    for (const batch of recordedBatches) events.push(...batch.events);
    events.push(...pendingBatch);

    const blob = new Blob(
      [
        JSON.stringify(
          {
            version: 1,
            eventCount: events.length,
            durationMs: events.length ? events[events.length - 1].deltaMs : 0,
            events,
          },
          null,
          2
        ),
      ],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return {
    get state() {
      return state;
    },
    get activeNotes() {
      return activeNotes;
    },
    get pendingBatch() {
      return pendingBatch;
    },
    get recordedBatches() {
      return recordedBatches;
    },
    start,
    stop,
    recordMessage,
    flush,
    download,
    snapshot,
    reset,
    buildTypedEvents,
  } as MidiRecorderExports & { buildTypedEvents(): Float64Array };
}
