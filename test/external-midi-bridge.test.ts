import test from "node:test";
import assert from "node:assert/strict";

import { createExternalMidiBridge, type WindowLike } from "../src/external-midi-bridge.ts";

class FakePort {
  messages: unknown[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  started = false;
  closed = false;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  dispatch(data: unknown): void {
    this.onmessage?.({ data });
  }
}

class FakeParent {
  messages: { message: unknown; origin: string }[] = [];

  postMessage(message: unknown, origin: string): void {
    this.messages.push({ message, origin });
  }
}

class FakeWindow {
  parent: FakeParent;
  listeners = new Map<string, (event: unknown) => void>();

  constructor(parent: FakeParent) {
    this.parent = parent;
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.set(type, handler);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    if (this.listeners.get(type) === handler) {
      this.listeners.delete(type);
    }
  }

  postMessage(_message: unknown, _origin: string): void {
    // not called on the child window in tests
  }

  dispatchMessage(event: unknown): void {
    this.listeners.get("message")?.(event);
  }
}

test("external bridge announces readiness and routes midi from MessagePort", async () => {
  const parent = new FakeParent();
  const windowLike = new FakeWindow(parent);
  const port = new FakePort();
  const midiPayloads: number[][] = [];
  const statuses: string[] = [];

  const bridge = createExternalMidiBridge({
    windowLike: windowLike as unknown as WindowLike,
    onMidiData: (data) => {
      midiPayloads.push(Array.from(data as ArrayLike<number>));
      return true;
    },
    onStatusChange: (status) => statuses.push(status),
  });

  bridge.start();

  assert.deepEqual(parent.messages, [
    { message: { type: "sf2:midi-bridge-ready" }, origin: "*" },
  ]);

  windowLike.dispatchMessage({
    source: parent,
    data: { type: "sf2:connect-midi" },
    ports: [port],
  });

  assert.equal(port.started, true);
  assert.deepEqual(port.messages, [{ type: "sf2:midi-connected" }]);
  assert.deepEqual(statuses, ["Embedded MIDI connected"]);

  port.dispatch({ type: "midi", data: [0x90, 60, 99] });

  assert.deepEqual(midiPayloads, [[0x90, 60, 99]]);
});

test("external bridge accepts direct parent sf2:midi messages and disconnects cleanly", async () => {
  const parent = new FakeParent();
  const windowLike = new FakeWindow(parent);
  const port = new FakePort();
  const midiPayloads: number[][] = [];
  const statuses: string[] = [];

  const bridge = createExternalMidiBridge({
    windowLike: windowLike as unknown as WindowLike,
    onMidiData: (data) => {
      midiPayloads.push(Array.from(data as ArrayLike<number>));
      return true;
    },
    onStatusChange: (status) => statuses.push(status),
  });

  bridge.start();
  windowLike.dispatchMessage({
    source: parent,
    data: { type: "sf2:connect-midi" },
    ports: [port],
  });

  windowLike.dispatchMessage({
    source: parent,
    data: { type: "sf2:midi", data: new Uint8Array([0x80, 60, 0]) },
    ports: [],
  });

  windowLike.dispatchMessage({
    source: parent,
    data: { type: "sf2:disconnect-midi" },
    ports: [],
  });

  assert.deepEqual(midiPayloads, [[0x80, 60, 0]]);
  assert.equal(port.closed, true);
  assert.deepEqual(statuses, [
    "Embedded MIDI connected",
    "Embedded MIDI disconnected",
  ]);

  bridge.dispose();
});

test("external bridge forwards midiInfo payloads", async () => {
  const parent = new FakeParent();
  const windowLike = new FakeWindow(parent);
  const infos: Record<string, unknown>[] = [];

  const bridge = createExternalMidiBridge({
    windowLike: windowLike as unknown as WindowLike,
    onMidiData: () => true,
    onMidiInfo: (info) => infos.push(info),
  });

  bridge.start();
  windowLike.dispatchMessage({
    source: parent,
    data: { type: "sf2:midi", data: [0x90, 60, 100] },
    ports: [],
  });
  windowLike.dispatchMessage({
    source: parent,
    data: { type: "midiInfo", infoType: "tempo", bpm: 92 },
    ports: [],
  });

  assert.deepEqual(infos, [{ type: "midiInfo", infoType: "tempo", bpm: 92 }]);
});

test("external bridge ignores non-parent messages", async () => {
  const parent = new FakeParent();
  const stranger = new FakeParent();
  const windowLike = new FakeWindow(parent);
  const port = new FakePort();
  let connected = false;

  const bridge = createExternalMidiBridge({
    windowLike: windowLike as unknown as WindowLike,
    onMidiData: () => true,
    onConnect: () => {
      connected = true;
    },
  });

  bridge.start();
  windowLike.dispatchMessage({
    source: stranger,
    data: { type: "sf2:connect-midi" },
    ports: [port],
  });

  assert.equal(connected, false);
  assert.equal(port.started, false);
});
