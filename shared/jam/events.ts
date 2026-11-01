// Live Jam event protocol v1 (jam.events.v1 / jam.control.v1 data channels). Binary, little-endian.
// Full field table: docs/live-jam/protocol.md.
//
// Packet = 1..MAX_EVENTS_PER_PACKET records of RECORD_BYTES each. Record 0 is new; later records are redundant
// copies of recent critical events (attacks/releases/pedal) that receivers dedupe by sequence number.
// Snapshot records (kind SNAPSHOT) carry an extra 20-byte held-state payload and are always sent alone.

export const EVENTS_PROTOCOL_VERSION = 1;
export const RECORD_BYTES = 28;
export const SNAPSHOT_EXTRA_BYTES = 20;
export const MAX_EVENTS_PER_PACKET = 4;
export const MAX_PACKET_BYTES = 1200;

export const Kind = { NOTE_ON: 1, NOTE_OFF: 2, CC: 3, BEND: 4, CHANNEL_PRESSURE: 5, POLY_PRESSURE: 6, PROGRAM: 7, PANIC: 8, SNAPSHOT: 9 } as const;
export type KindCode = (typeof Kind)[keyof typeof Kind];

/** One MIDI-domain live event. Times are integer microseconds in the room timebase (safe below 2^53). */
export interface JamEvent {
  kind: KindCode;
  generation: number;        // u16, sender connection generation (wraps)
  seq: number;               // u32, per-source sequence (wraps; compared with serial arithmetic)
  roomTimeUs: number;        // f64 holding an integer: capture time mapped to the room clock
  stream: number;            // u8 source/stream id within the participant
  channel: number;           // u8 0..15
  a: number;                 // u8 note / controller / program / pressure / bend LSB
  b: number;                 // u8 velocity / value / bend MSB / bank MSB
  noteId: number;            // u32 note instance id (note on/off), 0 otherwise
  instrumentRevision: number;// u16
  clockRevision: number;     // u16 sender's clock-mapping revision
  /** SNAPSHOT only: held keys (128-bit), sustain + sostenuto pedal state, as-of sequence = `seq`. */
  held?: Uint8Array; sustain?: number; sostenuto?: number;
}

export type DecodeError = "SHORT" | "VERSION" | "KIND" | "RANGE" | "SIZE";
const KINDS = new Set<number>(Object.values(Kind));

export function encodeRecord(e: JamEvent, dv: DataView, off: number): number {
  dv.setUint8(off, EVENTS_PROTOCOL_VERSION); dv.setUint8(off + 1, e.kind); dv.setUint16(off + 2, e.generation & 0xffff, true);
  dv.setUint32(off + 4, e.seq >>> 0, true); dv.setFloat64(off + 8, Math.round(e.roomTimeUs), true);
  dv.setUint8(off + 16, e.channel & 0x0f); dv.setUint8(off + 17, e.a & 0x7f); dv.setUint8(off + 18, e.b & 0x7f); dv.setUint8(off + 19, e.stream & 0xff);
  dv.setUint32(off + 20, e.noteId >>> 0, true); dv.setUint16(off + 24, e.instrumentRevision & 0xffff, true); dv.setUint16(off + 26, e.clockRevision & 0xffff, true);
  if (e.kind === Kind.SNAPSHOT) {
    const h = e.held ?? new Uint8Array(16); for (let i = 0; i < 16; i++) dv.setUint8(off + 28 + i, h[i] ?? 0);
    dv.setUint8(off + 44, e.sustain ?? 0); dv.setUint8(off + 45, e.sostenuto ?? 0); dv.setUint16(off + 46, 0, true);
    return RECORD_BYTES + SNAPSHOT_EXTRA_BYTES;
  }
  return RECORD_BYTES;
}

/** Encode `first` plus up to MAX_EVENTS_PER_PACKET-1 redundant records. */
export function encodePacket(first: JamEvent, redundant: JamEvent[] = []): Uint8Array {
  if (first.kind === Kind.SNAPSHOT) { const buf = new Uint8Array(RECORD_BYTES + SNAPSHOT_EXTRA_BYTES); encodeRecord(first, new DataView(buf.buffer), 0); return buf; }
  const rs = [first, ...redundant.filter((r) => r.kind !== Kind.SNAPSHOT).slice(0, MAX_EVENTS_PER_PACKET - 1)];
  const buf = new Uint8Array(rs.length * RECORD_BYTES); const dv = new DataView(buf.buffer);
  rs.forEach((r, i) => encodeRecord(r, dv, i * RECORD_BYTES));
  return buf;
}

export function decodePacket(bytes: Uint8Array): { ok: true; events: JamEvent[] } | { ok: false; error: DecodeError } {
  if (bytes.byteLength > MAX_PACKET_BYTES) return { ok: false, error: "SIZE" };
  if (bytes.byteLength < RECORD_BYTES) return { ok: false, error: "SHORT" };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const out: JamEvent[] = [];
  let off = 0;
  while (off < bytes.byteLength) {
    if (bytes.byteLength - off < RECORD_BYTES) return { ok: false, error: "SHORT" };
    if (dv.getUint8(off) !== EVENTS_PROTOCOL_VERSION) return { ok: false, error: "VERSION" };
    const kind = dv.getUint8(off + 1); if (!KINDS.has(kind)) return { ok: false, error: "KIND" };
    const t = dv.getFloat64(off + 8, true), ch = dv.getUint8(off + 16), a = dv.getUint8(off + 17), b = dv.getUint8(off + 18);
    if (!Number.isSafeInteger(t) || ch > 15 || a > 127 || b > 127) return { ok: false, error: "RANGE" };
    const e: JamEvent = { kind: kind as KindCode, generation: dv.getUint16(off + 2, true), seq: dv.getUint32(off + 4, true), roomTimeUs: t, channel: ch, a, b, stream: dv.getUint8(off + 19), noteId: dv.getUint32(off + 20, true), instrumentRevision: dv.getUint16(off + 24, true), clockRevision: dv.getUint16(off + 26, true) };
    off += RECORD_BYTES;
    if (kind === Kind.SNAPSHOT) {
      if (off !== RECORD_BYTES || bytes.byteLength !== RECORD_BYTES + SNAPSHOT_EXTRA_BYTES) return { ok: false, error: "SIZE" };
      e.held = bytes.slice(off, off + 16); e.sustain = dv.getUint8(off + 16); e.sostenuto = dv.getUint8(off + 17); off += SNAPSHOT_EXTRA_BYTES;
    }
    out.push(e);
  }
  if (out.length > MAX_EVENTS_PER_PACKET) return { ok: false, error: "SIZE" };
  return { ok: true, events: out };
}

/** JSON diagnostic form (identical fields; held as hex). */
export const eventToJson = (e: JamEvent) => ({ ...e, held: e.held ? [...e.held].map((x) => x.toString(16).padStart(2, "0")).join("") : undefined });

/** Serial-number arithmetic on u32 sequences: a is newer than b. */
export const seqNewer = (a: number, b: number) => { const d = (a - b) >>> 0; return d !== 0 && d < 0x80000000; };
export const seqDistance = (a: number, b: number) => ((a - b) | 0); // signed distance a-b

export const heldBit = (held: Uint8Array, note: number) => (held[note >> 3] >> (note & 7)) & 1;
export const setHeldBit = (held: Uint8Array, note: number, on: boolean) => { if (on) held[note >> 3] |= 1 << (note & 7); else held[note >> 3] &= ~(1 << (note & 7)); };

// Control channel (reliable, ordered): small JSON messages.
export type ControlMessage =
  | { t: "hello"; v: number; capabilities: string[] }
  | { t: "instrument"; revision: number; soundfont: string; bank: number; program: number; name: string }
  | { t: "probe"; id: number; t0: number }
  | { t: "probe-reply"; id: number; t0: number; t1: number; t2: number };
export const MAX_CONTROL_BYTES = 2048;
export function decodeControl(s: string): ControlMessage | null {
  if (s.length > MAX_CONTROL_BYTES) return null;
  try { const m = JSON.parse(s); return m && typeof m.t === "string" && ["hello", "instrument", "probe", "probe-reply"].includes(m.t) ? m as ControlMessage : null; } catch { return null; }
}
