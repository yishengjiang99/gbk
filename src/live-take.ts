// Player-side live take: a passive tap on the player's live input (computer
// keyboard triggers in App.tsx and Web MIDI through the midi-driver handlers).
// Events are captured as raw channel-0 MIDI bytes in the existing recorder
// (src/midi-recorder.ts) and exported with the repo's recorder serializer
// (recorderEventsToSmf: format 0 SMF, 480 PPQ, 120 BPM). The tap never alters
// the sounding path; it only observes the same values the handlers send to
// the live worklet.

import { createMidiRecorder, type MidiRecorderEvent } from "./midi-recorder.ts";
import { recorderEventsToSmf } from "./workstation/recording.ts";

export interface LiveTakeNote {
  note: number;
  velocity: number;
  startSec: number;
  durationSec: number;
}

export interface LiveTakeFile {
  name: string;
  bytes: Uint8Array;
}

/** The snapshot + actions App hands to the player surface for the take UI. */
export interface LiveTakeControls {
  armed: boolean;
  noteCount: number;
  eventCount: number;
  hasUnsaved: boolean;
  notes: LiveTakeNote[];
  elapsedSec: number;
  /** Confirm-if-unsaved + arm; returns false when the user cancels. */
  onNewFile(): boolean;
  takeFile(): LiveTakeFile | null;
  markSaved(): void;
}

export interface LiveTakeCapture {
  readonly armed: boolean;
  /** Start a fresh take: clears the buffer and arms capture from now. */
  arm(): void;
  noteOn(note: number, velocity: number): void;
  noteOff(note: number): void;
  controlChange(controller: number, value: number): void;
  programChange(program: number): void;
  pitchBend(value: number): void;
  channelPressure(value: number): void;
  polyPressure(note: number, value: number): void;
  /** Notes captured since the last arm/save (drives the overwrite confirm). */
  hasUnsavedNotes(): boolean;
  noteCount(): number;
  eventCount(): number;
  elapsedSec(): number;
  /** Completed notes plus still-held notes (held ones extend to now). */
  notes(): LiveTakeNote[];
  /** Serialize the take, closing any still-held notes at the take's end. */
  toFile(at?: Date): LiveTakeFile | null;
  markSaved(): void;
}

function takeFileName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `gbk-take-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.mid`
  );
}

export function createLiveTakeCapture(now: () => number = () => performance.now()): LiveTakeCapture {
  const recorder = createMidiRecorder();
  let armed = false;
  let armWallMs = 0;
  let firstWallMs: number | null = null;
  let noteOnsTotal = 0;
  let noteOnsAtSave = 0;

  function feed(bytes: number[]): void {
    if (!armed) return;
    const t = now();
    if (firstWallMs == null) firstWallMs = t;
    if (bytes[0] === 0x90 && (bytes[2] ?? 0) > 0) noteOnsTotal += 1;
    recorder.recordMessage(t, bytes);
  }

  // The recorder anchors its deltas at the first message; the take starts at
  // arm time, so shift by the lead-in between arming and the first event.
  function leadInMs(): number {
    return firstWallMs == null ? 0 : Math.max(0, firstWallMs - armWallMs);
  }

  function takeEvents(): MidiRecorderEvent[] {
    const lead = leadInMs();
    if (lead === 0) return recorder.events();
    return recorder.events().map((e) => ({ deltaMs: e.deltaMs + lead, bytes: e.bytes }));
  }

  function pairNotes(events: readonly MidiRecorderEvent[], endMs: number): LiveTakeNote[] {
    const open = new Map<number, { startMs: number; velocity: number }[]>();
    const done: LiveTakeNote[] = [];
    const close = (note: number, atMs: number) => {
      const queue = open.get(note);
      const started = queue?.shift();
      if (started) {
        done.push({
          note,
          velocity: started.velocity,
          startSec: started.startMs / 1000,
          durationSec: Math.max(0, atMs - started.startMs) / 1000,
        });
      }
    };
    for (const e of events) {
      const [status, d1 = 0, d2 = 0] = e.bytes;
      if (status === 0x90 && d2 > 0) {
        const queue = open.get(d1) ?? [];
        queue.push({ startMs: e.deltaMs, velocity: d2 });
        open.set(d1, queue);
      } else if (status === 0x80 || (status === 0x90 && d2 === 0)) {
        close(d1, e.deltaMs);
      }
    }
    for (const [note, queue] of open) {
      for (const started of queue) {
        done.push({
          note,
          velocity: started.velocity,
          startSec: started.startMs / 1000,
          durationSec: Math.max(0, endMs - started.startMs) / 1000,
        });
      }
    }
    return done.sort((a, b) => a.startSec - b.startSec || a.note - b.note);
  }

  return {
    get armed() {
      return armed;
    },
    arm() {
      recorder.start();
      armed = true;
      armWallMs = now();
      firstWallMs = null;
      noteOnsTotal = 0;
      noteOnsAtSave = 0;
    },
    noteOn(note, velocity) {
      feed([0x90, note & 0x7f, velocity & 0x7f]);
    },
    noteOff(note) {
      feed([0x80, note & 0x7f, 0]);
    },
    controlChange(controller, value) {
      feed([0xb0, controller & 0x7f, value & 0x7f]);
    },
    programChange(program) {
      feed([0xc0, program & 0x7f]);
    },
    pitchBend(value) {
      const v = Math.max(0, Math.min(0x3fff, Math.round(value)));
      feed([0xe0, v & 0x7f, (v >> 7) & 0x7f]);
    },
    channelPressure(value) {
      feed([0xd0, value & 0x7f]);
    },
    polyPressure(note, value) {
      feed([0xa0, note & 0x7f, value & 0x7f]);
    },
    hasUnsavedNotes() {
      return noteOnsTotal > noteOnsAtSave;
    },
    noteCount() {
      return noteOnsTotal;
    },
    eventCount() {
      return recorder.events().length;
    },
    elapsedSec() {
      if (!armed) return 0;
      return Math.max(0, (now() - armWallMs) / 1000);
    },
    notes() {
      if (!armed) return [];
      return pairNotes(takeEvents(), Math.max(0, now() - armWallMs));
    },
    toFile(at: Date = new Date()) {
      if (!armed) return null;
      const events = takeEvents();
      if (events.length === 0) return null;
      const endMs = Math.max(events[events.length - 1].deltaMs, (now() - armWallMs));
      // Close notes still held at save time so the file has no dangling note-ons.
      const open = new Map<number, number>();
      for (const e of events) {
        const [status, d1 = 0, d2 = 0] = e.bytes;
        if (status === 0x90 && d2 > 0) open.set(d1, (open.get(d1) ?? 0) + 1);
        else if (status === 0x80 || (status === 0x90 && d2 === 0)) {
          const n = (open.get(d1) ?? 0) - 1;
          if (n <= 0) open.delete(d1);
          else open.set(d1, n);
        }
      }
      const closed = [...events];
      for (const note of open.keys()) closed.push({ deltaMs: endMs, bytes: [0x80, note, 0] });
      return { name: takeFileName(at), bytes: recorderEventsToSmf(closed) };
    },
    markSaved() {
      noteOnsAtSave = noteOnsTotal;
    },
  };
}
