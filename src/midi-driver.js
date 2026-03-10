function normalizeMidiData(data) {
  if (data == null) return null;
  if (Array.isArray(data)) return data;
  if (ArrayBuffer.isView(data)) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

export function createMidiMessageHandler({ onNoteOn, onNoteOff, onProgramChange }) {
  const bankMsb = new Uint8Array(16);
  const bankLsb = new Uint8Array(16);

  return {
    handleMidiMessage(data) {
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
}) {
  if (!navigator.requestMIDIAccess) {
    throw new Error("Web MIDI is not supported in this browser.");
  }

  const midi = await navigator.requestMIDIAccess({ sysex: false });
  const inputHandlers = new Map();
  let activeInputId = selectedInputId;
  const messageHandler = createMidiMessageHandler({ onNoteOn, onNoteOff, onProgramChange });

  function shouldHandle(inputId) {
    return activeInputId === "all" || activeInputId === inputId;
  }

  function attachInput(input) {
    if (!input || inputHandlers.has(input.id)) return;
    const handler = (event) => {
      if (!shouldHandle(input.id)) return;
      messageHandler.handleMidiMessage(event.data);
    };
    input.addEventListener("midimessage", handler);
    inputHandlers.set(input.id, { input, handler });
  }

  function detachInputById(inputId) {
    const rec = inputHandlers.get(inputId);
    if (!rec) return;
    rec.input.removeEventListener("midimessage", rec.handler);
    inputHandlers.delete(inputId);
  }

  function refreshInputs() {
    const liveIds = new Set();
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

  midi.onstatechange = refreshInputs;
  refreshInputs();

  return {
    setSelectedInput(inputId) {
      activeInputId = inputId || "all";
    },
    disconnect() {
      midi.onstatechange = null;
      for (const inputId of inputHandlers.keys()) {
        detachInputById(inputId);
      }
      onStateChange?.({ connected: 0, names: [], inputs: [] });
    },
  };
}
