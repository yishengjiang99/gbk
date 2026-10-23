// Live keyboard: key mapping, typing-target guard, recording into the selected track (undoable), Web MIDI with a fake MIDIAccess.
import test from "node:test";
import assert from "node:assert/strict";
import { WorkstationController } from "../src/workstation/controller.ts";
import { emptyProject } from "../src/workstation/model.ts";
import { LiveInputSession, keyAction, isTypingTarget, parseMidiMessage, type LiveSink } from "../src/workstation/live-input.ts";
import { MidiInputManager, MIDI_UNSUPPORTED_MESSAGE, MIDI_DENIED_MESSAGE } from "../src/workstation/midi-input.ts";

class FakeSink implements LiveSink {
  log: string[] = [];
  noteOn(t: string, n: number, v: number) { this.log.push(`on ${t} ${n} ${v}`); }
  noteOff(t: string, n: number) { this.log.push(`off ${t} ${n}`); }
  controlChange(t: string, c: number, v: number) { this.log.push(`cc ${t} ${c} ${v}`); }
  pitchBend(t: string, v: number) { this.log.push(`bend ${t} ${v}`); }
  allNotesOff() { this.log.push("panic"); }
}
function rig() {
  const c = new WorkstationController(emptyProject("Live", 480));
  c.edit([{ op: "addTrack", name: "Piano", channel: 0 }, { op: "addTrack", name: "Strings", channel: 3 }], { label: "tracks" });
  const [a, b] = c.project.tracks;
  let tick = 0;
  const sink = new FakeSink();
  const s = new LiveInputSession(c, sink, { tickNow: () => tick });
  return { c, a, b, sink, s, at: (t: number) => { tick = t; } };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test("DAW key mapping: A..K = C..C, Z/X octave, C/V velocity; out-of-range notes ignored", () => {
  const row = ["KeyA", "KeyW", "KeyS", "KeyE", "KeyD", "KeyF", "KeyT", "KeyG", "KeyY", "KeyH", "KeyU", "KeyJ", "KeyK"];
  assert.deepEqual(row.map((k) => (keyAction(k, 4) as { note: number }).note), [60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72]);
  assert.deepEqual(keyAction("KeyA", 2), { kind: "note", note: 36 });
  assert.deepEqual(keyAction("KeyZ", 4), { kind: "octave", delta: -1 });
  assert.deepEqual(keyAction("KeyX", 4), { kind: "octave", delta: 1 });
  assert.deepEqual(keyAction("KeyC", 4), { kind: "velocity", delta: -16 });
  assert.deepEqual(keyAction("KeyV", 4), { kind: "velocity", delta: 16 });
  assert.equal(keyAction("KeyQ", 4), null); assert.equal(keyAction("KeyK", 9), null);
});

test("keys are ignored while typing (inputs, textareas, selects, contenteditable, composer prompt)", () => {
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "text" }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "search" }), true);
  assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isTypingTarget({ tagName: "SELECT" }), true);
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "SPAN", closest: (q: string) => (q.includes("data-no-live-keys") ? {} : null) }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "range" }), false);
  assert.equal(isTypingTarget({ tagName: "BUTTON", closest: () => null }), false);
  assert.equal(isTypingTarget(null), false);
});

test("plays the selected track; lit keys; octave/velocity clamp", () => {
  const { c, b, sink, s } = rig();
  c.setSelection({ trackIds: [b.id] });
  s.noteOn(60, 90); assert.deepEqual(s.snapshot().active, [60]);
  s.noteOff(60); assert.deepEqual(s.snapshot().active, []);
  assert.deepEqual(sink.log, [`on ${b.id} 60 90`, `off ${b.id} 60`]);
  for (let i = 0; i < 20; i++) s.shiftOctave(1); assert.equal(s.octave, 8);
  for (let i = 0; i < 20; i++) s.shiftVelocity(-16); assert.equal(s.velocity, 1);
});

test("record: only when armed AND playing; notes with velocity + duration land on the selected track as one undo step", async () => {
  const { c, a, b, s, at } = rig();
  c.setSelection({ trackIds: [b.id] });
  s.noteOn(50); s.noteOff(50);                       // not armed -> nothing recorded
  s.setArmed(true); s.noteOn(51); s.noteOff(51);     // armed but stopped -> nothing recorded
  assert.equal(c.project.notes.length, 0);
  const rev0 = c.project.revision;
  c.updateTransport({ playing: true });
  at(480); s.noteOn(60, 100); at(960); s.noteOff(60);
  at(1000); s.controlChange(64, 127); s.noteOn(64, 70); at(1100); s.controlChange(64, 0);
  at(1200); s.controlChange(1, 40); s.pitchBend(10000);
  at(1440);                                           // 64 still held: closed at stop
  c.updateTransport({ playing: false }); await flush();
  const notes = c.project.notes.map((n) => [n.trackId, n.channel, n.pitch, n.tick, n.duration, n.velocity]);
  assert.deepEqual(notes, [[b.id, 3, 60, 480, 480, 100], [b.id, 3, 64, 1000, 440, 70]]);
  assert.ok(c.project.notes.every((n) => n.trackId !== a.id));
  assert.deepEqual(c.project.ccs.filter((x) => x.trackId === b.id).map((x) => [x.controller, x.tick, x.value]), [[64, 1000, 127], [64, 1100, 0], [1, 1200, 40]]);
  assert.deepEqual(c.project.pitchBends.map((x) => [x.trackId, x.tick, x.value]), [[b.id, 1200, 10000]]);
  assert.equal(c.project.revision, rev0 + 1, "one edit per take");
  assert.match(c.historyLabels().undo.slice(-1)[0], /record take \(2 notes\)/);
  assert.equal(c.undo(), true); assert.equal(c.project.notes.length, 0); assert.equal(c.project.pitchBends.length, 0);
});

test("disarming mid-take commits what was played", () => {
  const { c, a, s, at } = rig();
  c.setSelection({ trackIds: [a.id] }); s.setArmed(true); c.updateTransport({ playing: true });
  at(0); s.noteOn(72, 80); at(240); s.setArmed(false);
  assert.deepEqual(c.project.notes.map((n) => [n.pitch, n.duration, n.velocity]), [[72, 240, 80]]);
});

test("MIDI parsing: note on/off (vel 0 = off), CC, 14-bit pitch bend, realtime ignored", () => {
  assert.deepEqual(parseMidiMessage([0x93, 60, 100]), { type: "noteOn", channel: 3, note: 60, velocity: 100 });
  assert.deepEqual(parseMidiMessage([0x90, 60, 0]), { type: "noteOff", channel: 0, note: 60 });
  assert.deepEqual(parseMidiMessage([0x80, 60, 64]), { type: "noteOff", channel: 0, note: 60 });
  assert.deepEqual(parseMidiMessage([0xb0, 64, 127]), { type: "cc", channel: 0, controller: 64, value: 127 });
  assert.deepEqual(parseMidiMessage([0xe0, 0x00, 0x40]), { type: "bend", channel: 0, value: 8192 });
  assert.deepEqual(parseMidiMessage([0xe0, 0x7f, 0x7f]), { type: "bend", channel: 0, value: 16383 });
  assert.deepEqual(parseMidiMessage([0xf8]), { type: "other" });
});

// ---- fake Web MIDI -----------------------------------------------------------
class FakeInput {
  state = "connected"; private fns = new Set<(e: { data: Uint8Array }) => void>();
  constructor(public id: string, public name: string, public manufacturer = "Acme") {}
  addEventListener(_t: string, f: (e: { data: Uint8Array }) => void) { this.fns.add(f); }
  removeEventListener(_t: string, f: (e: { data: Uint8Array }) => void) { this.fns.delete(f); }
  send(...b: number[]) { for (const f of this.fns) f({ data: new Uint8Array(b) }); }
  get listeners() { return this.fns.size; }
}
class FakeAccess {
  map = new Map<string, FakeInput>(); onstatechange: ((e: unknown) => void) | null = null;
  inputs = { values: () => this.map.values() };
  plug(i: FakeInput) { this.map.set(i.id, i); this.onstatechange?.({ port: i }); }
  unplug(id: string) { const i = this.map.get(id)!; i.state = "disconnected"; this.map.delete(id); this.onstatechange?.({ port: i }); }
}

test("Web MIDI (fake MIDIAccess): device selection, hot-plug, notes/velocity, sustain, bend, mod wheel, other CCs -> selected track, live and recorded", async () => {
  const { c, b, sink, s, at } = rig();
  c.setSelection({ trackIds: [b.id] });
  const access = new FakeAccess(); const k1 = new FakeInput("in-1", "Keystation 49"); access.map.set(k1.id, k1);
  const m = new MidiInputManager({ requestMIDIAccess: async () => access as never }, (d) => s.handleMidi(d));
  const st = await m.enable();
  assert.equal(st.kind, "ready"); assert.match(st.message, /all inputs \(1\)/); assert.deepEqual(m.devices.map((d) => d.name), ["Keystation 49"]);
  // hot-plug a second device
  const k2 = new FakeInput("in-2", "Pad Controller"); access.plug(k2);
  assert.deepEqual(m.devices.map((d) => d.id), ["in-1", "in-2"]);
  // select only k1: k2 is ignored
  m.select("in-1"); k2.send(0x90, 40, 100); assert.equal(sink.log.length, 0);
  s.setArmed(true); c.updateTransport({ playing: true });
  at(0); k1.send(0x95, 60, 33);            // any channel -> selected track
  at(100); k1.send(0xb0, 64, 127);         // sustain
  at(120); k1.send(0xb0, 1, 90);           // mod wheel
  at(130); k1.send(0xb0, 74, 20);          // other CC (brightness)
  at(140); k1.send(0xe0, 0, 0x60);         // bend up
  at(480); k1.send(0x80, 60, 0);
  at(500); k1.send(0xb0, 64, 0);
  assert.deepEqual(sink.log, [`on ${b.id} 60 33`, `cc ${b.id} 64 127`, `cc ${b.id} 1 90`, `cc ${b.id} 74 20`, `bend ${b.id} ${0x60 << 7}`, `off ${b.id} 60`, `cc ${b.id} 64 0`]);
  c.updateTransport({ playing: false }); await flush();
  assert.deepEqual(c.project.notes.map((n) => [n.trackId, n.pitch, n.velocity, n.tick, n.duration]), [[b.id, 60, 33, 0, 480]]);
  assert.deepEqual(c.project.ccs.map((x) => [x.controller, x.tick, x.value]).sort((p, q) => p[1] - q[1]), [[64, 100, 127], [1, 120, 90], [74, 130, 20], [64, 500, 0]]);
  assert.deepEqual(c.project.pitchBends.map((x) => [x.tick, x.value]), [[140, 0x60 << 7]]);
  // unplug the selected device: listener removed, clear message
  access.unplug("in-1"); assert.equal(k1.listeners, 0);
  assert.match(m.status.message, /Selected MIDI device disconnected/);
  m.select("all"); assert.match(m.status.message, /all inputs \(1\)/);
  m.disable(); assert.equal(k2.listeners, 0); assert.equal(m.status.kind, "off");
});

test("Web MIDI unsupported (Safari) and permission denied give clear messages", async () => {
  const none = new MidiInputManager({}, () => undefined);
  assert.equal(none.supported, false);
  assert.deepEqual(await none.enable(), { kind: "unsupported", message: MIDI_UNSUPPORTED_MESSAGE });
  const denied = new MidiInputManager({ requestMIDIAccess: async () => { throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }); } }, () => undefined);
  assert.deepEqual(await denied.enable(), { kind: "denied", message: MIDI_DENIED_MESSAGE });
  const broken = new MidiInputManager({ requestMIDIAccess: async () => { throw new Error("boom"); } }, () => undefined);
  assert.equal((await broken.enable()).kind, "error");
});
