import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WorkstationController } from "../src/workstation/controller.ts";
import { parseSmf, serializeSmf } from "../src/workstation/smf.ts";
import { runTool, type ToolResult } from "../src/webmcp/tools.ts";
import { buildAllTools } from "../src/webmcp/registry.ts";
import { tickToSec, bars } from "../src/workstation/timing.ts";
import { parseKey } from "../src/music/keys.ts";
import { primeSoundFontCache } from "../src/audio/soundfont-loader.ts";
import { parseSoundFont } from "../src/audio/soundfont-loader.ts";
import { migrateProject } from "../src/workstation/persistence.ts";

primeSoundFontCache("/static/GeneralUser-GS.sf2", parseSoundFont(new Uint8Array(readFileSync("public/static/GeneralUser-GS.sf2"))).sf);

export function setup(initial?: Uint8Array) {
  const c = new WorkstationController(initial ? parseSmf(initial, "user song") : undefined);
  const saved: string[] = [];
  c.host.checkpoint = async (p) => { saved.push(p.id); };
  const tools = new Map(buildAllTools(c).map((t) => [t.name, t]));
  const call = async (name: string, args: unknown = {}, signal = new AbortController().signal): Promise<ToolResult & { data: any }> => {
    const t = tools.get(name); if (!t) throw new Error(`no tool ${name}`);
    return runTool(c, t, args, signal) as never;
  };
  return { c, call, saved, tools };
}

test("gbk_create_project: new id, maps, ppq, key, empty data, checkpoints the previous project", async () => {
  const { c, call, saved } = setup(readFileSync("public/static/bizet_carmen_act-1_05_habanera_(c)yogore.mid"));
  const prev = c.project.id;
  const r = await call("gbk_create_project", { name: "Midnight Invention", tempo: 108, timeSignature: [4, 4], key: "C minor", ppq: 480 });
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.notEqual(r.data.projectId, prev);
  assert.deepEqual(saved, [prev]);
  assert.equal(c.project.ppq, 480); assert.equal(c.project.tempos[0].microPerQuarter, Math.round(60e6 / 108));
  assert.equal(c.project.meta?.key, "C minor"); assert.equal(c.project.meta?.owner, "agent");
  assert.equal(c.project.tracks.length + c.project.notes.length + c.project.ccs.length, 0);
  assert.equal(c.autonomousAllowed(), true);
  const bad = await call("gbk_create_project", { name: "x", key: "H minor" });
  assert.equal(bad.error!.code, "INVALID_ARGUMENT");
});

test("gbk_create_track: batch, stable ids, channel allocation, percussion, programs, mix", async () => {
  const { c, call } = setup();
  await call("gbk_create_project", { name: "t", tempo: 100 });
  const r = await call("gbk_create_track", { tracks: [
    { name: "Violin", program: 40, role: "melody", volume: 100, pan: 40, expression: 110 },
    { name: "Viola", program: 41, role: "harmony" }, { name: "Cello", program: 42, role: "bass" },
    { name: "Drums", role: "percussion" }] });
  assert.ok(r.ok, JSON.stringify(r.error)); assert.equal(r.data.committed, true);
  assert.equal(r.data.trackIds.length, 4);
  assert.deepEqual(c.project.tracks.map((t) => t.channel), [0, 1, 2, 9]);
  assert.equal(c.project.tracks[0].mix.pan, 40); assert.equal(c.project.tracks[0].mix.expression, 110);
  assert.equal(c.project.programs.find((g) => g.trackId === r.data.trackIds[2])!.program, 42);
  const one = await call("gbk_create_track", { name: "Harpsichord", program: 6 });
  assert.equal(c.project.tracks.length, 5); assert.equal(one.data.tracks[0].channel, 3);
  const sub = await call("gbk_create_track", { name: "Weird", program: 5, bankMsb: 99 });
  assert.ok(sub.warnings.some((w) => /not in SoundFont/.test(w)));
  const invalid = await call("gbk_create_track", { name: "x", program: 300 });
  assert.equal(invalid.ok, false);
});

test("tempo and meter maps by bar; seconds follow the map; song structure persists and exports", async () => {
  const { c, call } = setup();
  await call("gbk_create_project", { name: "maps", tempo: 108, key: "C minor" });
  const m = await call("gbk_set_time_signature_map", { events: [{ bar: 1, numerator: 4, denominator: 4 }, { bar: 9, numerator: 3, denominator: 4 }, { bar: 11, numerator: 6, denominator: 8 }] });
  assert.ok(m.ok, JSON.stringify(m.error));
  assert.deepEqual(c.project.timeSigs.map((t) => t.tick), [0, 8 * 1920, 8 * 1920 + 2 * 1440]);
  const t = await call("gbk_set_tempo_map", { events: [{ bar: 1, bpm: 108 }, { bar: 17, bpm: 116 }, { bar: 33, bpm: 92 }] });
  assert.ok(t.ok);
  const b17 = bars(c.project, 1e6).find((b) => b.index === 17)!.tick;
  assert.equal(c.project.tempos[1].tick, b17);
  // 8 bars 4/4 + 2 bars 3/4 + 6 bars 6/8 = 32 + 6 + 18 quarter = 56 quarters at 108 BPM
  assert.ok(Math.abs(tickToSec(c.project, b17) - 56 * 60 / 108) < 1e-3);
  const bad = await call("gbk_set_tempo_map", { events: [{ bar: 3, bpm: 100 }] });
  assert.equal(bad.ok, false);
  const s = await call("gbk_set_song_structure", { sections: [{ name: "Intro", startBar: 1, bars: 8, energy: 0.3 }, { name: "Theme", startBar: 9, bars: 16, energy: 0.7 }] });
  assert.ok(s.ok); assert.equal(c.project.meta!.sections!.length, 2);
  const overlap = await call("gbk_set_song_structure", { sections: [{ name: "A", startBar: 1, bars: 8 }, { name: "B", startBar: 5, bars: 4 }] });
  assert.equal(overlap.error!.code, "INVALID_RANGE");
  const smf = serializeSmf(c.project);
  const txt = Buffer.from(smf).toString("latin1");
  assert.ok(txt.includes("Intro") && txt.includes("Theme"));
  assert.ok(Buffer.from(smf).includes(Buffer.from([0xff, 0x59, 2, 0xfd, 1]))); // C minor = 3 flats
  assert.deepEqual(migrateProject(JSON.parse(JSON.stringify(c.project)))!.meta!.sections!.length, 2);
  assert.equal(parseKey("Eb major").sf, -3); assert.equal(parseKey("f# minor").tonic, 6);
});

test("existing user project: compose edits become proposals needing Accept; session never leaks", async () => {
  const { c, call } = setup(readFileSync("public/static/bizet_carmen_act-1_05_habanera_(c)yogore.mid"));
  const r = await call("gbk_create_track", { name: "New", program: 0 });
  assert.ok(r.ok); assert.equal(r.data.committed, false); assert.ok(r.data.proposalId);
  const commit = await call("gbk_commit_proposal", { proposalId: r.data.proposalId });
  assert.equal(commit.error!.code, "USER_APPROVAL_REQUIRED");
  // session for a new project ends when the user loads another project
  await call("gbk_create_project", { name: "agent", replaceCurrent: true });
  assert.equal(c.autonomousAllowed(), true);
  const agentId = c.project.id;
  c.load(parseSmf(readFileSync("public/static/bizet_carmen_act-1_05_habanera_(c)yogore.mid"), "user"));
  assert.equal(c.getSession(), null); assert.equal(c.autonomousAllowed(agentId), false);
  const again = await call("gbk_create_track", { name: "x" });
  assert.equal(again.data.committed, false);
});

test("user can discard autonomous work and end the session", async () => {
  const { c, call } = setup();
  await call("gbk_create_project", { name: "a" });
  await call("gbk_create_track", { name: "v", program: 40 });
  await call("gbk_set_song_structure", { sections: [{ name: "A", startBar: 1, bars: 4 }] });
  assert.equal(c.project.tracks.length, 1);
  assert.equal(c.discardAutonomousWork(), true);
  assert.equal(c.project.tracks.length, 0); assert.equal(c.getSession(), null);
  const r = await call("gbk_create_track", { name: "v" });
  assert.equal(r.data.committed, false);
});
