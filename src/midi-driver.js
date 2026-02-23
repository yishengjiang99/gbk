export async function createMidiDriver({
  onNoteOn,
  onNoteOff,
  onProgramChange,
  onStateChange,
  selectedInputId = "all",
}) {
  if (!navigator.requestMIDIAccess) {
    return null;
  }

  const midi = await navigator.requestMIDIAccess({ sysex: false });
  const inputHandlers = new Map();
  let activeInputId = selectedInputId;
  const bankMsb = new Uint8Array(16);
  const bankLsb = new Uint8Array(16);
  const currentProgram = new Uint8Array(16);
  const hasProgram = new Uint8Array(16);

  function clamp7bit(value) {
    return Number(value) & 0x7f;
  }

  function getBank(channel) {
    return ((bankMsb[channel] & 0x7f) << 7) | (bankLsb[channel] & 0x7f);
  }

  function emitProgramChange(program, channel) {
    onProgramChange?.(program & 0x7f, getBank(channel), channel);
  }

  function setChannelProgram(channel, program, bank = null) {
    const ch = clamp7bit(channel) & 0x0f;
    currentProgram[ch] = clamp7bit(program);
    hasProgram[ch] = 1;
    if (bank != null && Number.isFinite(Number(bank))) {
      const value = Number(bank) & 0x3fff;
      bankMsb[ch] = (value >> 7) & 0x7f;
      bankLsb[ch] = value & 0x7f;
    }
  }

  function shouldHandle(inputId) {
    return activeInputId === "all" || activeInputId === inputId;
  }

  function attachInput(input) {
    if (!input || inputHandlers.has(input.id)) return;
    const handler = (event) => {
      if (!shouldHandle(input.id)) return;
      const [status = 0, note = 0, velocity = 0] = event.data ?? [];
      const command = status & 0xf0;
      const channel = 0;

      if (command === 0x90 && velocity > 0) {
        onNoteOn?.(note & 0x7f, velocity & 0x7f, channel);
        return;
      }
      if (command === 0x80 || (command === 0x90 && velocity === 0)) {
        onNoteOff?.(note & 0x7f, channel);
        return;
      }
      if (command === 0xb0) {
        const cc = note & 0x7f;
        const value = velocity & 0x7f;
        if (cc === 0) bankMsb[channel] = value;
        if (cc === 32) bankLsb[channel] = value;
        if ((cc === 0 || cc === 32) && hasProgram[channel]) {
          emitProgramChange(currentProgram[channel], channel);
        }
        return;
      }
      if (command === 0xc0) {
        const program = note & 0x7f;
        setChannelProgram(channel, program);
        emitProgramChange(program, channel);
      }
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
    setChannelProgram,
    disconnect() {
      midi.onstatechange = null;
      for (const inputId of inputHandlers.keys()) {
        detachInputById(inputId);
      }
      onStateChange?.({ connected: 0, names: [], inputs: [] });
    },
  };
}
