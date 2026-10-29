import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./support/compose-setup.ts";
import { emptyProject, DEFAULT_MIX, type Project } from "../src/workstation/model.ts";

/** A two-track project (melody + drums) with a declared key and sections. */
function songProject(): Project {
  const p = emptyProject("Test Song", 480);
  p.tracks = [
    { id: "t_mel", name: "Melody", channel: 0, color: "#fff176", mix: { ...DEFAULT_MIX }, visible: true, role: "melody" },
    { id: "t_drm", name: "Drums", channel: 9, color: "#e57373", mix: { ...DEFAULT_MIX }, visible: true, role: "percussion" },
  ];
  p.programs = [{ id: "pg1", trackId: "t_mel", channel: 0, tick: 0, program: 40, bankMsb: 0, bankLsb: 0 }];
  p.notes = [
    { id: "n1", trackId: "t_mel", channel: 0, tick: 0, duration: 480, pitch: 67, velocity: 100 },
    { id: "n2", trackId: "t_mel", channel: 0, tick: 480, duration: 480, pitch: 63, velocity: 90 },
    { id: "n3", trackId: "t_drm", channel: 9, tick: 0, duration: 120, pitch: 36, velocity: 110 },
  ];
  p.endTick = 960;
  p.meta = { key: "C minor", sections: [{ name: "Exposition", startBar: 1, bars: 8 }] };
  return p;
}

test("project summary exposes key, sections and per-track facts (#162 step 3)", async () => {
  const { c, call } = setup();
  c.load(songProject());
  const s = await call("gbk_get_project_summary");
  assert.ok(s.ok);
  const d = s.data as { key: { name: string; estimated: boolean }; sections: { name: string }[]; tracks: { id: string; program: { program: number } | null; isPercussion: boolean; noteCount: number; minPitch: number | null; maxPitch: number | null }[] };
  assert.deepEqual(d.key, { name: "C minor", estimated: false }, "declared meta.key wins and is not flagged estimated");
  assert.equal(d.sections.length, 1); assert.equal(d.sections[0].name, "Exposition");
  const mel = d.tracks.find((t) => t.id === "t_mel")!;
  assert.equal(mel.program?.program, 40);
  assert.equal(mel.isPercussion, false);
  assert.equal(mel.noteCount, 2); assert.equal(mel.minPitch, 63); assert.equal(mel.maxPitch, 67);
  const drm = d.tracks.find((t) => t.id === "t_drm")!;
  assert.equal(drm.isPercussion, true, "channel 9 is percussion");
  assert.equal(drm.program, null);
});

test("project summary estimates the key (flagged) when meta.key is absent", async () => {
  const { c, call } = setup();
  const p = songProject(); p.meta = {};
  // A fuller C-minor collection (the 3-note fixture is honestly ambiguous with Eb major).
  p.notes = [60, 63, 67, 72, 65, 68, 70, 67, 60].map((pitch, i) => ({ id: `e${i}`, trackId: "t_mel", channel: 0, tick: i * 480, duration: 480, pitch, velocity: 95 }));
  p.endTick = 480 * 9;
  c.load(p);
  const s = await call("gbk_get_project_summary");
  const d = s.data as { key: { name: string; estimated: boolean } | null };
  assert.ok(d.key); assert.equal(d.key.estimated, true);
  assert.equal(d.key.name, "C minor");
});

test("project summary on an empty project reports key null and no tracks", async () => {
  const { call } = setup();
  const s = await call("gbk_get_project_summary");
  const d = s.data as { key: unknown; sections: unknown[]; tracks: unknown[] };
  assert.equal(d.key, null); assert.deepEqual(d.sections, []); assert.deepEqual(d.tracks, []);
});
