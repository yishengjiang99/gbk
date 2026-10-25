import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readMidi, mergeOps, isMidiFile, importMidiFile } from "../src/workstation/midi-import.ts";
import { WorkstationController } from "../src/workstation/controller.ts";
import { emptyProject } from "../src/workstation/model.ts";

const buf = readFileSync(new URL("./fixtures/import-test.mid", import.meta.url));
const file = (b: Uint8Array, name = "import-test.mid") => ({ name, type: "audio/midi", arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }) as unknown as File;

test("readMidi: type 1 fixture -> tracks per MIDI track (conductor dropped), programs, tempo/time sig, CC, pitch bend", () => {
  const p = readMidi(buf, "import-test.mid");
  assert.equal(p.name, "import-test"); assert.equal(p.ppq, 96);
  assert.deepEqual(p.tracks.map((t) => [t.name, t.channel]), [["Piano", 0], ["Violin", 1]]);
  assert.equal(p.notes.length, 3);
  assert.deepEqual(p.programs.map((g) => g.program), [0, 40]);
  assert.equal(p.tempos[0].microPerQuarter, 500000); assert.deepEqual([p.timeSigs[0].numerator, p.timeSigs[0].denominator], [3, 4]);
  assert.ok(p.ccs.some((c) => c.controller === 1 && c.value === 32)); assert.ok(p.ccs.some((c) => c.controller === 7 && c.value === 100));
  assert.equal(p.pitchBends[0].value, 0x50 << 7);
});

test("readMidi: clear errors for empty, garbage, notes-less files; isMidiFile by name/type", () => {
  assert.throws(() => readMidi(new Uint8Array(0), "x.mid"), /empty/);
  assert.throws(() => readMidi(new TextEncoder().encode("hello world"), "x.mid"), /Not a readable MIDI file/);
  const noNotes = new Uint8Array([...buf.subarray(0, 14 + 8 + 30)]); // header + conductor only; ntrks says 3
  assert.throws(() => readMidi(noNotes, "x.mid"));
  assert.ok(isMidiFile({ name: "A.MID", type: "" })); assert.ok(isMidiFile({ name: "song", type: "audio/x-midi" })); assert.ok(!isMidiFile({ name: "x.json", type: "application/json" }));
});

test("import: new project replaces; merge adds tracks via undoable ops with ticks rescaled to project PPQ", async () => {
  const c = new WorkstationController(emptyProject("Mine", 480)); c.host.checkpoint = async () => {};
  await importMidiFile(file(buf), c, "merge");
  assert.equal(c.project.name, "Mine"); assert.deepEqual(c.project.tracks.map((t) => t.name), ["Piano", "Violin"]);
  const n = c.project.notes.find((x) => x.pitch === 0x40)!; assert.equal(n.tick, 480); assert.equal(n.duration, 480); // 96 ticks @96 -> 480 @480
  assert.ok(c.project.programs.some((g) => g.program === 40));
  assert.ok(c.project.pitchBends.length === 1 && c.project.pitchBends[0].tick === 240);
  assert.ok(c.undo()); assert.equal(c.project.tracks.length, 0);
  await importMidiFile(file(buf), c, "new"); assert.equal(c.project.name, "import-test"); assert.equal(c.project.tracks.length, 2);
  assert.equal(mergeOps(emptyProject(), readMidi(buf, "a.mid")).filter((o) => o.op === "addTrack").length, 2);
});
