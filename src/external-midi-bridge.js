function isRawMidiPayload(payload) {
  return Array.isArray(payload) || ArrayBuffer.isView(payload) || payload instanceof ArrayBuffer;
}

export function createExternalMidiBridge({
  windowLike,
  onMidiData,
  onMidiInfo,
  onStatusChange,
  onConnect,
  onDisconnect,
  parentOrigin = "*",
}) {
  let externalMidiPort = null;

  function disconnectExternalMidiPort() {
    const port = externalMidiPort;
    if (!port) return;
    port.onmessage = null;
    try {
      port.close();
    } catch {
      // MessagePort.close() is optional across environments.
    }
    externalMidiPort = null;
    onDisconnect?.();
  }

  function handleExternalMidiPayload(payload) {
    if (payload == null) return false;
    if (isRawMidiPayload(payload)) {
      return onMidiData?.(payload) ?? false;
    }
    if (typeof payload !== "object") return false;
    if (payload.type === "midi" || payload.type === "midimessage") {
      return onMidiData?.(payload.data) ?? false;
    }
    if (payload.type === "midiInfo") {
      onMidiInfo?.(payload);
      return true;
    }
    if (payload.type === "disconnect") {
      disconnectExternalMidiPort();
      onStatusChange?.("Embedded MIDI disconnected");
      return true;
    }
    return false;
  }

  function attachExternalMidiPort(port) {
    if (!port) return;
    disconnectExternalMidiPort();
    externalMidiPort = port;
    port.onmessage = (event) => {
      handleExternalMidiPayload(event.data);
    };
    port.start?.();
    onConnect?.(port);
    onStatusChange?.("Embedded MIDI connected");
    port.postMessage({ type: "sf2:midi-connected" });
  }

  function onWindowMessage(event) {
    if (windowLike.parent === windowLike || event.source !== windowLike.parent) return;
    const payload = event.data;
    if (payload?.type === "sf2:connect-midi") {
      attachExternalMidiPort(event.ports?.[0] ?? null);
      return;
    }
    if (payload?.type === "sf2:disconnect-midi") {
      disconnectExternalMidiPort();
      onStatusChange?.("Embedded MIDI disconnected");
      return;
    }
    if (payload?.type === "sf2:midi") {
      handleExternalMidiPayload({ type: "midi", data: payload.data });
      return;
    }
    if (payload?.type === "midiInfo" || payload?.type === "sf2:midiInfo") {
      handleExternalMidiPayload(
        payload?.type === "sf2:midiInfo" ? { ...payload, type: "midiInfo" } : payload
      );
    }
  }

  return {
    start() {
      windowLike.addEventListener("message", onWindowMessage);
      if (windowLike.parent !== windowLike) {
        windowLike.parent.postMessage({ type: "sf2:midi-bridge-ready" }, parentOrigin);
      }
    },
    dispose() {
      windowLike.removeEventListener("message", onWindowMessage);
      disconnectExternalMidiPort();
    },
    handleExternalMidiPayload,
    attachExternalMidiPort,
    disconnectExternalMidiPort,
  };
}
