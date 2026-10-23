import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./support/compose-setup.ts";
import { tickToSec } from "../src/workstation/timing.ts";
import { parseSmf } from "../src/workstation/smf.ts";
import { renderProjectOffline } from "../src/audio/offline-renderer.ts";
import { loadSoundFont } from "../src/audio/soundfont-loader.ts";

async function midnight() {
  const s = setup();
  const { call, c } = s;
  assert.ok((await call("gbk_create_project", { name: "Midnight Invention", tempo: 108, timeSignature: [4, 4], key: "C minor", ppq: 480 })).ok);
  const tr = await call("gbk_create_track", { tracks: [
    { name: "Violin", program: 40, role: "melody", pan: 40 }, { name: "Viola", program: 41, role: "harmony", pan: 56 },
    { name: "Cello", program: 42, role: "bass", pan: 84 }, { name: "Harpsichord", program: 6, role: "accompaniment", pan: 64 }] });
  assert.ok(tr.ok && tr.data.committed);
  assert.ok((await call("gbk_set_tempo_map", { events: [{ bar: 1, bpm: 108 }] })).ok);
  assert.ok((await call("gbk_set_time_signature_map", { events: [{ bar: 1, numerator: 4, denominator: 4 }] })).ok);
  assert.ok((await call("gbk_set_song_structure", { sections: [{ name: "Introduction", startBar: 1, bars: 4, energy: 0.35 }, { name: "Theme", startBar: 5, bars: 12, energy: 0.7 }, { name: "Development", startBar: 17, bars: 12, energy: 0.95 }, { name: "Coda", startBar: 29, bars: 4, energy: 0.5 }] })).ok);
  const g = await call("gbk_generate_arrangement", { style: "baroque", key: "C minor", tempo: 108, bars: 32, seed: 12345, voices: 4, complexity: 4, instrumentation: ["violin", "viola", "cello", "harpsichord"], features: { counterpoint: true, dynamicExpression: true, articulation: true, cadences: true } });
  assert.ok(g.ok, JSON.stringify(g.error));
  return { ...s, g, trackIds: tr.data.trackIds as string[] };
}

test("Midnight Invention: deterministic 32-bar baroque arrangement on the four created tracks", async () => {
  const { c, g, trackIds } = await midnight();
  assert.equal(g.data.committed, true);
  assert.equal(c.project.tracks.length, 4, "reuses the created tracks");
  for (const id of trackIds) assert.ok(c.project.notes.filter((n) => n.trackId === id).length > 40, `track ${id} has material`);
  assert.ok(g.data.totalNotes > 400, `notes ${g.data.totalNotes}`);
  const end = Math.max(...c.project.notes.map((n) => n.tick + n.duration));
  assert.ok(end <= 32 * 1920);
  assert.ok(Math.abs(tickToSec(c.project, 32 * 1920) - 32 * 4 * 60 / 108) < 1e-3);
  assert.ok(c.project.ccs.some((x) => x.controller === 11) && c.project.ccs.some((x) => x.controller === 1));
  const ranges = g.data.tracks as { name: string; range: [number, number] }[];
  const vio = ranges.find((t) => t.name === "Violin")!.range, cel = ranges.find((t) => t.name === "Cello")!.range;
  assert.ok(vio[0] >= 55 && cel[1] <= 72 && cel[0] >= 36);
  assert.ok(g.data.metrics.repeatedNoteRatio < 0.5);
  // same seed -> same notes
  const again = await midnight();
  const sig = (p: typeof c.project) => p.notes.map((n) => `${n.tick}:${n.pitch}:${n.duration}:${n.velocity}`).join(",");
  assert.equal(sig(again.c.project), sig(c.project));
});

test("Midnight Invention: CC curve committed in session, MIDI export round-trips, offline render is valid", async () => {
  const { c, call, trackIds } = await midnight();
  const cc = await call("gbk_generate_cc_curve", { trackIds: trackIds.slice(0, 3), controller: 11, shape: "swell", from: 60, peak: 120, to: 70, range: { unit: "bars", start: 17, end: 28 } });
  assert.ok(cc.ok);
  const cm = await call("gbk_commit_proposal", { proposalId: cc.data.proposalId });
  assert.ok(cm.ok, JSON.stringify(cm.error));
  const midi = await call("gbk_prepare_midi_export", { download: false });
  assert.ok(midi.ok);
  const back = parseSmf(c.prepareMidiExport().bytes);
  assert.equal(back.notes.length, c.project.notes.length);
  assert.equal(back.tempos[0].microPerQuarter, Math.round(60e6 / 108));
  assert.ok(back.ccs.filter((x) => x.controller === 11).length >= c.project.ccs.filter((x) => x.controller === 11).length);
  const r = await renderProjectOffline(c.project, { sampleRate: 44100, channels: 2, format: "pcm16", tailSeconds: 3 }, undefined, undefined, { soundFont: await loadSoundFont() });
  assert.ok(Math.abs(r.durationSeconds - (32 * 4 * 60 / 108 + 3)) < 0.01, `dur ${r.durationSeconds}`);
  assert.ok(r.peakDbFS > -30 && r.clippedSamples === 0, `peak ${r.peakDbFS} clip ${r.clippedSamples}`);
  assert.deepEqual(r.instruments.map((i) => i.program), [40, 41, 42, 6]);
  assert.ok(r.instruments.every((i) => !i.substituted && !i.muted));
});

test("other styles + primitives produce real notes", async () => {
  const { call, c } = setup();
  await call("gbk_create_project", { name: "pop", tempo: 120, key: "G major" });
  const g = await call("gbk_generate_arrangement", { style: "pop", bars: 8, seed: 3 });
  assert.ok(g.ok, JSON.stringify(g.error));
  assert.ok(c.project.tracks.some((t) => t.channel === 9));
  const piano = c.project.tracks[0].id;
  const before = c.project.notes.length;
  for (const [transform, extra] of [["transpose", { semitones: 12 }], ["quantize", { grid: 0.25 }], ["humanize", { amount: 8 }], ["articulation", { articulation: "staccato" }], ["phrase_dynamics", {}], ["variation", { variation: "ornament" }], ["invert", { axis: 67 }], ["retrograde", {}]] as const) {
    const r = await call("gbk_transform_notes", { trackId: piano, range: { unit: "bars", start: 1, end: 2 }, transform, ...extra });
    assert.ok(r.ok, `${transform}: ${JSON.stringify(r.error)}`);
  }
  const seq = await call("gbk_transform_notes", { trackId: piano, range: { unit: "bars", start: 1, end: 1 }, transform: "sequence", times: 2, semitones: -2 });
  assert.ok(seq.ok && seq.data.resultNotes > 0);
  const t = await call("gbk_create_track", { name: "Flute", program: 73 });
  for (const kind of ["melody", "bass", "chords", "arpeggio", "alberti", "walking_bass"]) assert.ok((await call("gbk_generate_part", { trackId: t.data.trackIds[0], range: { unit: "bars", start: 9, end: 12 }, kind, seed: 5 })).ok, kind);
  assert.ok((await call("gbk_generate_part", { trackId: t.data.trackIds[0], range: { unit: "bars", start: 1, end: 4 }, kind: "counterpoint", againstTrackId: piano })).ok);
  assert.ok((await call("gbk_orchestrate", { sourceTrackId: piano, targetTrackId: t.data.trackIds[0], range: { unit: "bars", start: 1, end: 4 }, semitones: 12 })).ok);
  assert.ok(c.project.notes.length > before);
});
