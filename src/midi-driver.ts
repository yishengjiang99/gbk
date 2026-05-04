export type MidiData = number[] | ArrayBufferView | ArrayBuffer | null;

export interface MidiDriverCallbacks {
  onNoteOn?: (note: number, velocity: number, channel: number) => void;
  onNoteOff?: (note: number, channel: number) => void;
  onProgramChange?: (program: number, bank: number, channel: number) => void;
}

export interface MidiStateChange {
  connected: number;
  names: string[];
  inputs: { id: string; name: string }[];
}

export interface MidiDriverOptions extends MidiDriverCallbacks {
  onStateChange?: (state: MidiStateChange) => void;
  selectedInputId?: string;
}

export interface MidiMessageHandler {
  handleMidiMessage(data: MidiData): boolean;
}

export interface MidiDriver {
  setSelectedInput(inputId: string): void;
  disconnect(): void;
}

export function isMidiPermissionDeniedError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const rec = err as { name?: unknown; message?: unknown };
  const name = typeof rec.name === "string" ? rec.name : "";
  const message = typeof rec.message === "string" ? rec.message : "";
  return (
    name === "NotAllowedError" ||
    /Permission to use Web MIDI API was not granted/i.test(message) ||
    /permission\b.*\b(web\s*)?midi\b.*\b(denied|not granted)/i.test(message)
  );
}

function normalizeMidiData(data: MidiData): ArrayLike<number> | null {
  if (data == null) return null;
  if (Array.isArray(data)) return data;
  if (ArrayBuffer.isView(data)) return data as unknown as ArrayLike<number>;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

export function createMidiMessageHandler({
  onNoteOn,
  onNoteOff,
  onProgramChange,
}: MidiDriverCallbacks): MidiMessageHandler {
  const bankMsb = new Uint8Array(16);
  const bankLsb = new Uint8Array(16);

  return {
    handleMidiMessage(data: MidiData): boolean {
      const bytes = normalizeMidiData(data);
      if (!bytes || bytes.length === 0) return false;

      const status = Number(bytes[0]) || 0;
      const data1 = Number(bytes[1]) || 0;
      const data2 = Number(bytes[2]) || 0;
      const command = status & 0xf0;
      const channel = status & 0x0f;

      if (command === 0x90 && data2 > 0) {
        onNoteOn?.(data1 & 0x7f, data2 & 0x7f, channel);
        return true;
      }
      if (command === 0x80 || (command === 0x90 && data2 === 0)) {
        onNoteOff?.(data1 & 0x7f, channel);
        return true;
      }
      if (command === 0xb0) {
        const cc = data1 & 0x7f;
        const value = data2 & 0x7f;
        if (cc === 0) bankMsb[channel] = value;
        if (cc === 32) bankLsb[channel] = value;
        return true;
      }
      if (command === 0xc0) {
        const program = data1 & 0x7f;
        const bank = ((bankMsb[channel] & 0x7f) << 7) | (bankLsb[channel] & 0x7f);
        onProgramChange?.(program, bank, channel);
        return true;
      }
      return false;
    },
  };
}

export async function createMidiDriver({
  onNoteOn,
  onNoteOff,
  onProgramChange,
  onStateChange,
  selectedInputId = "all",
}: MidiDriverOptions): Promise<MidiDriver> {
  if (!navigator.requestMIDIAccess) {
    throw new Error("Web MIDI is not supported in this browser.");
  }

  const midi = await navigator.requestMIDIAccess({ sysex: false });

  type InputRecord = { input: MIDIInput; handler: (event: MIDIMessageEvent) => void };
  const inputHandlers = new Map<string, InputRecord>();
  let activeInputId = selectedInputId;
  const messageHandler = createMidiMessageHandler({ onNoteOn, onNoteOff, onProgramChange });

  function shouldHandle(inputId: string): boolean {
    return activeInputId === "all" || activeInputId === inputId;
  }

  function attachInput(input: MIDIInput): void {
    if (!input || inputHandlers.has(input.id)) return;
    const handler = (event: MIDIMessageEvent): void => {
      if (!shouldHandle(input.id)) return;
      messageHandler.handleMidiMessage(event.data);
    };
    input.addEventListener("midimessage", handler);
    inputHandlers.set(input.id, { input, handler });
  }

  function detachInputById(inputId: string): void {
    const rec = inputHandlers.get(inputId);
    if (!rec) return;
    rec.input.removeEventListener("midimessage", rec.handler);
    inputHandlers.delete(inputId);
  }

  function refreshInputs(): void {
    const liveIds = new Set<string>();
    for (const input of midi.inputs.values()) {
      liveIds.add(input.id);
      attachInput(input);
    }
    for (const inputId of inputHandlers.keys()) {
      if (!liveIds.has(inputId)) detachInputById(inputId);
    }
    const inputs = [...inputHandlers.values()].map((v) => ({
      id: v.input.id,
      name: v.input.name || v.input.id,
    }));
    onStateChange?.({ connected: inputHandlers.size, names: inputs.map((i) => i.name), inputs });
  }

  midi.onstatechange = () => refreshInputs();
  refreshInputs();

  return {
    setSelectedInput(inputId: string): void {
      activeInputId = inputId || "all";
    },
    disconnect(): void {
      midi.onstatechange = null;
      for (const inputId of inputHandlers.keys()) {
        detachInputById(inputId);
      }
      onStateChange?.({ connected: 0, names: [], inputs: [] });
    },
  };
}
