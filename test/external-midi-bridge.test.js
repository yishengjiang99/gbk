import test from "node:test";
import assert from "node:assert/strict";

import { createExternalMidiBridge } from "../src/external-midi-bridge.js";

class FakePort {
  constructor() {
    this.messages = [];
    this.onmessage = null;
    this.started = false;
    this.closed = false;
  }

  postMessage(message) {
    this.messages.push(message);
  }

  start() {
    this.started = true;
  }

  close() {
    this.closed = true;
  }

  dispatch(data) {
    this.onmessage?.({ data });
  }
}

class FakeParent {
  constructor() {
    this.messages = [];
  }

  postMessage(message, origin) {
    this.messages.push({ message, origin });
  }
}

class FakeWindow {
  constructor(parent) {
    this.parent = parent;
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  removeEventListener(type, handler) {
    if (this.listeners.get(type) === handler) {
      this.listeners.delete(type);
    }
  }

  dispatchMessage(event) {
    this.listeners.get("message")?.(event);
  }
}

test("external bridge announces readiness and routes midi from MessagePort", async () => {
  const parent = new FakeParent();
  const windowLike = new FakeWindow(parent);
  const port = new FakePort();
  const midiPayloads = [];
  const statuses = [];

  const bridge = createExternalMidiBridge({
    windowLike,
    onMidiData: (data) => {
      midiPayloads.push(Array.from(data));
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
  const midiPayloads = [];
  const statuses = [];

  const bridge = createExternalMidiBridge({
    windowLike,
    onMidiData: (data) => {
      midiPayloads.push(Array.from(data));
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

test("external bridge ignores non-parent messages", async () => {
  const parent = new FakeParent();
  const stranger = new FakeParent();
  const windowLike = new FakeWindow(parent);
  const port = new FakePort();
  let connected = false;

  const bridge = createExternalMidiBridge({
    windowLike,
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
