import type { SF2Region } from "../sf2-parser.ts";

export interface MidiEventRouterOptions {
  onNoteOn: (note: number, velocity: number, channel: number) => void;
  onNoteOff: (note: number, channel: number) => void;
  onProgramChange: (program: number, bank: number, channel: number) => void;
  onControllers?: (channel: number, cc: number, value: number) => void;
  onPitchBend?: (channel: number, value: number) => void;
  onChannelPressure?: (channel: number, value: number) => void;
  onPolyPressure?: (channel: number, note: number, value: number) => void;
}

export interface MidiEventRouter {
  handleMidiMessage(data: ArrayLike<number>): boolean;
}

export function createMidiEventRouter(options: MidiEventRouterOptions): MidiEventRouter {
  const bankMsb = new Uint8Array(16);
  const bankLsb = new Uint8Array(16);

  function normalizeData(data: ArrayLike<number>): ArrayLike<number> | null {
    if (data == null || data.length === 0) return null;
    return data;
  }

  return {
    handleMidiMessage(data: ArrayLike<number>): boolean {
      const bytes = normalizeData(data);
      if (!bytes) return false;

      const status = Number(bytes[0]) || 0;
      const data1 = Number(bytes[1]) || 0;
      const data2 = Number(bytes[2]) || 0;
      const command = status & 0xf0;
      const channel = status & 0x0f;

      if (command === 0x90 && data2 > 0) {
        options.onNoteOn(data1 & 0x7f, data2 & 0x7f, channel);
        return true;
      }
      if (command === 0x80 || (command === 0x90 && data2 === 0)) {
        options.onNoteOff(data1 & 0x7f, channel);
        return true;
      }
      if (command === 0xb0) {
        const cc = data1 & 0x7f;
        const value = data2 & 0x7f;
        if (cc === 0) bankMsb[channel] = value;
        if (cc === 32) bankLsb[channel] = value;
        options.onControllers?.(channel, cc, value);
        return true;
      }
      if (command === 0xc0) {
        const program = data1 & 0x7f;
        const bank = ((bankMsb[channel] & 0x7f) << 7) | (bankLsb[channel] & 0x7f);
        options.onProgramChange(program, bank, channel);
        return true;
      }
      if (command === 0xd0) {
        options.onChannelPressure?.(channel, data1 & 0x7f);
        return true;
      }
      if (command === 0xa0) {
        options.onPolyPressure?.(channel, data1 & 0x7f, data2 & 0x7f);
        return true;
      }
      if (command === 0xe0) {
        const bend = ((data2 & 0x7f) << 7) | (data1 & 0x7f);
        options.onPitchBend?.(channel, bend - 8192);
        return true;
      }
      return false;
    },
  };
}

export interface SynthEventRouterOptions {
  getRegionsForPreset: (presetIndex: number) => SF2Region[];
  resolvePresetIndex: (program: number, bank: number) => number | null;
  fallbackPresetIndex: number;
  onSendEvent: (event: Record<string, unknown>) => void;
  trackIndex?: number | null;
}

export function midiBytesToSynthEvent(
  bytes: number[],
  options: SynthEventRouterOptions
): Record<string, unknown> | null {
  if (bytes.length === 0) return null;
  const status = bytes[0];
  const command = status & 0xf0;
  const channel = status & 0x0f;
  const d1 = bytes[1] ?? 0;
  const d2 = bytes[2] ?? 0;

  if (command === 0x90 && d2 > 0) {
    return { type: "noteOn", channel, note: d1 & 0x7f, velocity: d2 & 0x7f, trackIndex: options.trackIndex ?? null };
  }
  if (command === 0x80 || (command === 0x90 && d2 === 0)) {
    return { type: "noteOff", channel, note: d1 & 0x7f, trackIndex: options.trackIndex ?? null };
  }
  if (command === 0xc0) {
    const program = d1 & 0x7f;
    // Bank is resolved externally from CC 0 / 32 state.
    const presetIndex = options.resolvePresetIndex(program, 0) ?? options.fallbackPresetIndex;
    return {
      type: "setPreset",
      trackIndex: options.trackIndex ?? null,
      regions: options.getRegionsForPreset(presetIndex),
    };
  }
  if (command === 0xb0) {
    return {
      type: "setControllers",
      trackIndex: options.trackIndex ?? null,
      channel,
      cc: d1 & 0x7f,
      value: d2 & 0x7f,
    };
  }
  if (command === 0xe0) {
    const bend = ((d2 & 0x7f) << 7) | (d1 & 0x7f);
    return { type: "pitchBend", channel, value: bend - 8192, trackIndex: options.trackIndex ?? null };
  }
  if (command === 0xa0) {
    return { type: "polyPressure", channel, note: d1 & 0x7f, value: d2 & 0x7f, trackIndex: options.trackIndex ?? null };
  }
  if (command === 0xd0) {
    return { type: "channelPressure", channel, value: d1 & 0x7f, trackIndex: options.trackIndex ?? null };
  }
  return null;
}
