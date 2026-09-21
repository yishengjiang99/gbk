export interface MidiRecorderEvent {
  deltaMs: number;
  bytes: number[];
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

const HEADER_FIELDS = 3; // deltaMs, byteCount, channelCommandHint
const MAX_MIDI_MESSAGE_BYTES = 3;
const EVENT_BYTE_LENGTH = HEADER_FIELDS + MAX_MIDI_MESSAGE_BYTES;

function noteKey(channel: number, note: number): string {
  return `${channel}:${note}`;
}

function isChannelMessage(status: number): boolean {
  const high = status & 0xf0;
  return high >= 0x80 && high <= 0xe0;
}

function getMessageLength(status: number): number {
  const high = status & 0xf0;
  if (high >= 0x80 && high <= 0xe0) {
    if (high === 0xc0 || high === 0xd0) return 2;
    return 3;
  }
  switch (status) {
    case 0xf1:
    case 0xf3:
      return 2;
    case 0xf2:
      return 3;
    case 0xf0:
    case 0xf7:
      return 0;
    case 0xf4:
    case 0xf5:
    case 0xf6:
    case 0xf8:
    case 0xf9:
    case 0xfa:
    case 0xfb:
    case 0xfc:
    case 0xfd:
    case 0xfe:
    case 0xff:
      return 1;
    default:
      return 0;
  }
}

function normalizeEventBytes(bytes: number[]): number[] {
  // Keep the full message as decoded; do not drop trailing zero data bytes
  // because 0 is a valid MIDI value (e.g., velocity 0, bank LSB 0).
  return bytes.slice();
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
  let runningStatus: number | null = null;
  let sysexBuffer: number[] | null = null;

  function transition(next: RecorderState): void {
    if (state === next) return;
    if (next === "recording") {
      startMs = null;
      batchStartMs = null;
      runningStatus = null;
      sysexBuffer = null;
    }
    state = next;
  }

  function normalizeBytes(data: ArrayLike<number>): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < data.length; i++) {
      const b = Number(data[i]) & 0xff;
      if (b === 0xf0) {
        sysexBuffer = [];
      } else if (b === 0xf7) {
        if (sysexBuffer) {
          sysexBuffer.push(b);
          bytes.push(...sysexBuffer);
          sysexBuffer = null;
          continue;
        }
      }
      if (sysexBuffer) {
        sysexBuffer.push(b);
      } else {
        bytes.push(b);
      }
    }
    return bytes;
  }

  function decodeChannelMessage(status: number, data1: number, data2: number): void {
    const command = status & 0xf0;
    const channel = status & 0x0f;

    if (command === 0x90 && data2 > 0) {
      activeNotes.set(noteKey(channel, data1), {
        note: data1,
        channel,
        velocity: data2,
        onMs: pendingBatch[pendingBatch.length - 1]?.deltaMs ?? 0,
      });
    } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
      activeNotes.delete(noteKey(channel, data1));
    } else if (command === 0xb0 && data1 === 123) {
      for (const key of activeNotes.keys()) {
        if (activeNotes.get(key)!.channel === channel) {
          activeNotes.delete(key);
        }
      }
    }
  }

  function recordMessage(timestampMs: number, data: ArrayLike<number>): void {
    if (state !== "recording" || data.length === 0) return;

    if (startMs == null) {
      startMs = timestampMs;
    }
    const deltaMs = timestampMs - startMs;

    const raw = normalizeBytes(data);
    if (raw.length === 0) return;

    const messages: number[][] = [];
    let i = 0;
    while (i < raw.length) {
      const status = raw[i];
      if (status === 0xf0) {
        const end = raw.indexOf(0xf7, i);
        if (end >= 0) {
          messages.push(raw.slice(i, end + 1));
          i = end + 1;
          continue;
        }
        messages.push(raw.slice(i));
        break;
      }

      if (status & 0x80) {
        runningStatus = isChannelMessage(status) ? status : null;
      } else if (runningStatus != null && isChannelMessage(runningStatus)) {
        messages.push([runningStatus, status, ...raw.slice(i + 1)]);
        i += getMessageLength(runningStatus) - 1;
        continue;
      }

      const len = getMessageLength(status);
      if (len > 0) {
        messages.push(raw.slice(i, i + len));
        i += len;
      } else {
        messages.push([status]);
        i += 1;
      }
    }

    for (const msg of messages) {
      if (msg.length === 0) continue;
      const status = msg[0];
      const channelCommandHint = isChannelMessage(status) ? status : 0;
      if (channelCommandHint && msg.length >= 2) {
        decodeChannelMessage(status, msg[1] ?? 0, msg[2] ?? 0);
      }

      if (batchStartMs == null) {
        batchStartMs = deltaMs;
      }
      pendingBatch.push({ deltaMs, bytes: normalizeEventBytes(msg) });

      if (pendingBatch.length >= BATCH_SIZE) {
        pushBatch();
      }
    }
  }

  function encodeEvents(events: MidiRecorderEvent[]): Float64Array {
    const out = new Float64Array(events.length * EVENT_BYTE_LENGTH);
    let offset = 0;
    for (const ev of events) {
      out[offset++] = ev.deltaMs;
      out[offset++] = ev.bytes.length;
      const hint = ev.bytes.length > 0 && isChannelMessage(ev.bytes[0]) ? ev.bytes[0] : 0;
      out[offset++] = hint;
      for (let i = 0; i < MAX_MIDI_MESSAGE_BYTES; i++) {
        out[offset++] = ev.bytes[i] ?? 0;
      }
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

  function stop(): void {
    if (state !== "recording") return;
    if (sysexBuffer && sysexBuffer.length > 0) {
      pendingBatch.push({
        deltaMs: pendingBatch[pendingBatch.length - 1]?.deltaMs ?? 0,
        bytes: sysexBuffer,
      });
      sysexBuffer = null;
    }
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
    runningStatus = null;
    sysexBuffer = null;
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
    function writeEvent(ev: MidiRecorderEvent): void {
      out[offset++] = ev.deltaMs;
      out[offset++] = ev.bytes.length;
      const hint = ev.bytes.length > 0 && isChannelMessage(ev.bytes[0]) ? ev.bytes[0] : 0;
      out[offset++] = hint;
      for (let i = 0; i < MAX_MIDI_MESSAGE_BYTES; i++) {
        out[offset++] = ev.bytes[i] ?? 0;
      }
    }
    for (const batch of recordedBatches) {
      for (const ev of batch.events) writeEvent(ev);
    }
    for (const ev of pendingBatch) writeEvent(ev);
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
            version: 2,
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
