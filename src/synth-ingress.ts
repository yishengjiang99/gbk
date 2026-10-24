// Unified realtime ingress for the SF2 synth engine.
//
// Every realtime event source — the SMF scheduler worker (per-track MessagePorts), workstation
// live input (LiveInputSession -> Sf2LiveSink), and player live input (Web MIDI / embedded bridge
// via midi-driver.ts) — used to hand-assemble its own engine messages, and each kept its own copy
// of the CC0/CC32 bank folding. The copies drifted (the player path dropped CCs, bend and
// pressure for years). This module is the ONE place that defines:
//
//   1. the wire shape of every engine event (the `synthEvent` builders),
//   2. the typed sink a source talks to (SynthIngress, built by createSynthIngress), and
//   3. the bank-select folding (BankSelectTracker).
//
// Adapters keep their intentional semantics: the scheduler stays per-track and tempo-driven and
// escalates program changes to the main thread for preset resolution; the workstation session
// collapses input onto the selected track and records takes; the player path targets channel 0.
// Only the event construction and bank folding are shared. Seek/loop controller-state restoration
// is likewise shared, from src/workstation/controller-events.ts (controllerStateAt / ctlToSynth),
// which the scheduler, the offline renderer and MIDI-out already use.
import type { SynthEvent } from "./sf2-renderer.ts";
import type { SF2Region } from "./sf2/soundfont.ts";

/** Anything that accepts one engine message: a worklet MessagePort, or Sf2SynthEngine.dispatchEvent. */
export type SynthEventSink = (msg: SynthEvent) => void;

/**
 * The wire shape of every realtime engine event, in one place. These are exactly the message
 * objects the three sources used to build inline; Sf2Processor forwards them to
 * Sf2SynthEngine.dispatchEvent unchanged.
 */
export const synthEvent = {
  noteOn: (channel: number, note: number, velocity: number): SynthEvent => ({ type: "noteOn", channel, note, velocity }),
  noteOff: (channel: number, note: number): SynthEvent => ({ type: "noteOff", channel, note }),
  controlChange: (channel: number, controller: number, value: number): SynthEvent => ({ type: "controlChange", channel, controller, value }),
  /** `value` is the raw 14-bit bend, 0..16383 with 8192 at center (carried in the `velocity` field, as the engine expects). */
  pitchBend: (channel: number, value: number): SynthEvent => ({ type: "pitchBend", channel, velocity: value }),
  channelPressure: (channel: number, value: number): SynthEvent => ({ type: "channelPressure", channel, value }),
  polyPressure: (channel: number, note: number, value: number): SynthEvent => ({ type: "polyPressure", channel, note, value }),
  /** `channel` omitted installs the engine-global preset list; with a channel, that channel's list.
   *  A null region list clears the list (the engine reads an absent `regions` as null). */
  setPreset: (regions: SF2Region[] | null, channel?: number): SynthEvent =>
    channel === undefined
      ? { type: "setPreset", regions: regions ?? undefined }
      : { type: "setPreset", channel, regions: regions ?? undefined },
};

/**
 * The engine-facing event sink every realtime source adapts to. Values are MIDI-domain:
 * channels 0..15, notes/controllers/values 0..127, pitch bend 14-bit 0..16383.
 */
export interface SynthIngress {
  noteOn(channel: number, note: number, velocity: number): void;
  noteOff(channel: number, note: number): void;
  controlChange(channel: number, controller: number, value: number): void;
  pitchBend(channel: number, value: number): void;
  channelPressure(channel: number, value: number): void;
  polyPressure(channel: number, note: number, value: number): void;
  /**
   * Program change with bank already folded (feed the adapter's BankSelectTracker every CC and
   * pass `tracker.bank(channel)`). Default delivery is the engine's own `programChange`, which
   * reads its bank from CC0 state — so CC0 must reach the sink as a controlChange first (both raw
   * decoders forward it). Sources whose presets are resolved outside the engine (player,
   * scheduler) pass `onProgramChange` to createSynthIngress instead and receive (channel,
   * program, bank) to resolve into regions, delivered back via setPreset.
   */
  programChange(channel: number, program: number, bank: number): void;
  /** Install preset regions: engine-global when `channel` is omitted, per-channel otherwise. */
  setPreset(regions: SF2Region[] | null, channel?: number): void;
  /** CC123: key-off every sounding note on the channel (sustain/sostenuto deferral still applies). */
  allNotesOff(channel: number): void;
  /** CC120: kill every voice on the channel immediately, no release envelope. */
  allSoundOff(channel: number): void;
}

export interface SynthIngressOptions {
  /** Replaces engine programChange delivery: the source resolves (program, bank) to regions itself. */
  onProgramChange?: (channel: number, program: number, bank: number) => void;
}

/** Build a SynthIngress that serializes every call to an engine message through `send`. */
export function createSynthIngress(send: SynthEventSink, opts: SynthIngressOptions = {}): SynthIngress {
  return {
    noteOn: (channel, note, velocity) => send(synthEvent.noteOn(channel, note, velocity)),
    noteOff: (channel, note) => send(synthEvent.noteOff(channel, note)),
    controlChange: (channel, controller, value) => send(synthEvent.controlChange(channel, controller, value)),
    pitchBend: (channel, value) => send(synthEvent.pitchBend(channel, value)),
    channelPressure: (channel, value) => send(synthEvent.channelPressure(channel, value)),
    polyPressure: (channel, note, value) => send(synthEvent.polyPressure(channel, note, value)),
    programChange: (channel, program, bank) => {
      if (opts.onProgramChange) { opts.onProgramChange(channel, program, bank); return; }
      send({ type: "programChange", channel, program });
    },
    setPreset: (regions, channel) => send(synthEvent.setPreset(regions, channel)),
    allNotesOff: (channel) => send(synthEvent.controlChange(channel, 123, 0)),
    allSoundOff: (channel) => send(synthEvent.controlChange(channel, 120, 0)),
  };
}

/**
 * Per-channel CC0 (bank MSB) / CC32 (bank LSB) state, folded into the bank of the next program
 * change: bank = (msb << 7) | lsb. ONE implementation, shared by the raw-MIDI handler
 * (midi-driver.ts, which also forwards the CCs themselves) and the SMF parser
 * (midi-timer.worker.ts, which consumes them into the program event instead of routing them).
 */
export class BankSelectTracker {
  private msb = new Uint8Array(16);
  private lsb = new Uint8Array(16);

  /** Observe one control change on a channel; non-bank CCs are ignored. */
  observe(controller: number, value: number, channel: number): void {
    const ch = channel & 0x0f;
    if (controller === 0) this.msb[ch] = value & 0x7f;
    else if (controller === 32) this.lsb[ch] = value & 0x7f;
  }

  /** The folded bank for a channel: (CC0 << 7) | CC32, each 7-bit. */
  bank(channel: number): number {
    const ch = channel & 0x0f;
    return ((this.msb[ch] & 0x7f) << 7) | (this.lsb[ch] & 0x7f);
  }

  reset(): void {
    this.msb.fill(0);
    this.lsb.fill(0);
  }
}
