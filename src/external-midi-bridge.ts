export interface WindowLike {
  readonly parent: WindowLike;
  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: boolean | AddEventListenerOptions
  ): void;
  removeEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: boolean | EventListenerOptions
  ): void;
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
}

export interface ExternalMidiBridgeOptions {
  windowLike: WindowLike;
  onMidiData?: (data: number[] | ArrayBufferView | ArrayBuffer) => boolean;
  onMidiInfo?: (payload: Record<string, unknown>) => void;
  onStatusChange?: (status: string) => void;
  onConnect?: (port: MessagePort) => void;
  onDisconnect?: () => void;
  parentOrigin?: string;
}

export interface ExternalMidiBridge {
  start(): void;
  dispose(): void;
  handleExternalMidiPayload(payload: unknown): boolean;
  attachExternalMidiPort(port: MessagePort | null): void;
  disconnectExternalMidiPort(): void;
}

function isRawMidiPayload(
  payload: unknown
): payload is number[] | ArrayBufferView | ArrayBuffer {
  return (
    Array.isArray(payload) ||
    ArrayBuffer.isView(payload) ||
    payload instanceof ArrayBuffer
  );
}

export function createExternalMidiBridge({
  windowLike,
  onMidiData,
  onMidiInfo,
  onStatusChange,
  onConnect,
  onDisconnect,
  parentOrigin = "*",
}: ExternalMidiBridgeOptions): ExternalMidiBridge {
  let externalMidiPort: MessagePort | null = null;

  function disconnectExternalMidiPort(): void {
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

  function handleExternalMidiPayload(payload: unknown): boolean {
    if (payload == null) return false;
    if (isRawMidiPayload(payload)) {
      return onMidiData?.(payload) ?? false;
    }
    if (typeof payload !== "object") return false;
    const obj = payload as Record<string, unknown>;
    if (obj["type"] === "midi" || obj["type"] === "midimessage") {
      const rawData = obj["data"];
      if (!isRawMidiPayload(rawData)) return false;
      return onMidiData?.(rawData) ?? false;
    }
    if (obj["type"] === "midiInfo") {
      onMidiInfo?.(obj);
      return true;
    }
    if (obj["type"] === "disconnect") {
      disconnectExternalMidiPort();
      onStatusChange?.("Embedded MIDI disconnected");
      return true;
    }
    return false;
  }

  function attachExternalMidiPort(port: MessagePort | null): void {
    if (!port) return;
    disconnectExternalMidiPort();
    externalMidiPort = port;
    port.onmessage = (event: MessageEvent): void => {
      handleExternalMidiPayload(event.data);
    };
    port.start();
    onConnect?.(port);
    onStatusChange?.("Embedded MIDI connected");
    port.postMessage({ type: "sf2:midi-connected" });
  }

  function onWindowMessage(event: Event): void {
    const msgEvent = event as MessageEvent;
    if (
      windowLike.parent === windowLike ||
      // msgEvent.source is MessageEventSource (Window | MessagePort | ServiceWorker | null);
      // windowLike.parent is WindowLike. Both refer to the same frame object at runtime,
      // so we compare via unknown to avoid an incompatible-type TS error.
      (msgEvent.source as unknown) !== windowLike.parent
    )
      return;
    const payload = msgEvent.data as Record<string, unknown> | null;
    if (payload?.["type"] === "sf2:connect-midi") {
      attachExternalMidiPort(msgEvent.ports?.[0] ?? null);
      return;
    }
    if (payload?.["type"] === "sf2:disconnect-midi") {
      disconnectExternalMidiPort();
      onStatusChange?.("Embedded MIDI disconnected");
      return;
    }
    if (payload?.["type"] === "sf2:midi") {
      handleExternalMidiPayload({ type: "midi", data: payload["data"] });
      return;
    }
    if (payload?.["type"] === "midiInfo" || payload?.["type"] === "sf2:midiInfo") {
      handleExternalMidiPayload(
        payload?.["type"] === "sf2:midiInfo"
          ? { ...payload, type: "midiInfo" }
          : payload
      );
    }
  }

  return {
    start(): void {
      windowLike.addEventListener("message", onWindowMessage);
      if (windowLike.parent !== windowLike) {
        windowLike.parent.postMessage({ type: "sf2:midi-bridge-ready" }, parentOrigin);
      }
    },
    dispose(): void {
      windowLike.removeEventListener("message", onWindowMessage);
      disconnectExternalMidiPort();
    },
    handleExternalMidiPayload,
    attachExternalMidiPort,
    disconnectExternalMidiPort,
  };
}
