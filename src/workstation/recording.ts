// Recorder output (ms-timestamped raw MIDI) -> SMF so it plays through the player and opens in the workstation.
import { encVlq } from "./smf.ts";
import type { MidiRecorderEvent } from "../midi-recorder.ts";

/** 480 PPQ at 120 bpm: 1 ms = 0.96 ticks. Channel-voice messages only (sysex/realtime dropped). */
export function recorderEventsToSmf(events: readonly MidiRecorderEvent[]): Uint8Array {
  const trk: number[] = [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20];
  const sorted = [...events].filter((e) => e.bytes.length && e.bytes[0] >= 0x80 && e.bytes[0] < 0xf0).sort((a, b) => a.deltaMs - b.deltaMs);
  let last = 0;
  for (const e of sorted) {
    const tick = Math.max(0, Math.round(e.deltaMs * 0.96));
    const hi = e.bytes[0] & 0xf0; const len = hi === 0xc0 || hi === 0xd0 ? 2 : 3;
    trk.push(...encVlq(tick - last), ...e.bytes.slice(0, len).map((b, i) => (i ? b & 0x7f : b)));
    last = tick;
  }
  trk.push(0, 0xff, 0x2f, 0);
  const n = trk.length;
  return new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0, 0x4d, 0x54, 0x72, 0x6b, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...trk]);
}
