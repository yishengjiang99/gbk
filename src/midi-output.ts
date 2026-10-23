import { controllerStateAt, ctlToBytes, type CtlPlayEvent } from "./workstation/controller-events.ts";
export interface MidiOutputNote {
  note: number;
  velocity: number;
  channel: number;
  startSec: number;
  durationSec: number;
}

export interface MidiOutputPlayEvent {
  type: string;
  sec: number;
  channel?: number;
  note?: number;
  velocity?: number;
  program?: number;
  bank?: number;
  controller?: number;
  value?: number;
}

export interface MidiOutputSong {
  tracks: Array<{
    notes: MidiOutputNote[];
    playEvents: MidiOutputPlayEvent[];
  }>;
}

export interface MidiSendEvent {
  sec: number;
  order: number;
  bytes: number[];
}

export function buildMidiSendEvents(song: MidiOutputSong, startSec: number): MidiSendEvent[] {
  const events: MidiSendEvent[] = [];
  const latestProgramByChannel = new Map<number, { program: number; bank: number }>();

  for (const track of song.tracks) {
    for (const event of track.playEvents) {
      if (event.type === "program" && event.sec < startSec) {
        latestProgramByChannel.set((event.channel ?? 0) & 0x0f, {
          program: event.program ?? 0,
          bank: event.bank ?? 0,
        });
      }
    }
  }

  // Controller state (CC/bend/pressure) at the start point so MIDI out matches realtime/offline.
  if (startSec > 0) for (const track of song.tracks) for (const ev of controllerStateAt(track.playEvents as never, startSec)) {
    if (ev.seq < -1000) continue; // skip reset + mixer-default base layer for external devices
    events.push({ sec: startSec, order: -0.5, bytes: ctlToBytes(ev) });
  }

  for (const [channel, programEvent] of latestProgramByChannel) {
    const bank = programEvent.bank;
    events.push({ sec: startSec, order: -3, bytes: [0xb0 | channel, 0, (bank >> 7) & 0x7f] });
    events.push({ sec: startSec, order: -2, bytes: [0xb0 | channel, 32, bank & 0x7f] });
    events.push({ sec: startSec, order: -1, bytes: [0xc0 | channel, programEvent.program & 0x7f] });
  }

  for (const track of song.tracks) {
    for (const note of track.notes) {
      if (note.startSec < startSec && note.startSec + note.durationSec > startSec) {
        const channel = note.channel & 0x0f;
        events.push({
          sec: startSec,
          order: 4,
          bytes: [0x90 | channel, note.note & 0x7f, note.velocity & 0x7f],
        });
      }
    }

    for (const event of track.playEvents) {
      if (event.sec < startSec) continue;
      const channel = (event.channel ?? 0) & 0x0f;
      if (event.type === "program") {
        const bank = event.bank ?? 0;
        events.push({ sec: event.sec, order: 0, bytes: [0xb0 | channel, 0, (bank >> 7) & 0x7f] });
        events.push({ sec: event.sec, order: 1, bytes: [0xb0 | channel, 32, bank & 0x7f] });
        events.push({ sec: event.sec, order: 2, bytes: [0xc0 | channel, (event.program ?? 0) & 0x7f] });
      } else if (event.type === "noteOff") {
        events.push({ sec: event.sec, order: 3, bytes: [0x80 | channel, (event.note ?? 0) & 0x7f, 64] });
      } else if (event.type === "cc" || event.type === "pitchBend" || event.type === "channelPressure" || event.type === "polyPressure") {
        events.push({ sec: event.sec, order: 5, bytes: ctlToBytes({ ...(event as CtlPlayEvent), channel, seq: 0 }) });
      } else if (event.type === "noteOn") {
        events.push({ sec: event.sec, order: 4, bytes: [0x90 | channel, (event.note ?? 0) & 0x7f, (event.velocity ?? 0) & 0x7f] });
      }
    }
  }

  return events.sort((a, b) => a.sec - b.sec || a.order - b.order);
}
