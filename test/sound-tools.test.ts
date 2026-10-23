import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { WorkstationController } from "../src/workstation/controller.ts";
import { parseSmf, serializeSmf } from "../src/workstation/smf.ts";
import { migrateProject } from "../src/workstation/persistence.ts";
import { buildAllTools } from "../src/webmcp/registry.ts";
import { runTool, type ToolResult } from "../src/webmcp/tools.ts";
import { SF2SoundFont } from "../src/sf2/soundfont.ts";
import { Sf2SynthEngine } from "../src/sf2-renderer.ts";

const GU = "public/static/GeneralUser-GS.sf2";
const sf = existsSync(GU) ? new SF2SoundFont(new Uint8Array(readFileSync(GU))) : null;

function setup() {
  const c = new WorkstationController(parseSmf(readFileSync("public/static/bizet_carmen_act-1_05_habanera_(c)yogore.mid"), "carmen"));
  if (sf) c.host.trackRegions = () => ({ presetIndex: 0, presetName: "piano", regions: sf.regionList(0) });
  c.approvalHandler = async () => true;
  const tools = new Map(buildAllTools(c).map((t) => [t.name, t]));
  const call = (name: string, args: unknown = {}) => runTool(c, tools.get(name)!, args, new AbortController().signal) as Promise<ToolResult & { data: any }>;
  const tid = c.project.tracks.find((t) => c.project.notes.some((n) => n.trackId === t.id))!.id;
  return { c, call, tid };
}

test("capabilities report reverb/chorus + voice editing truthfully", async () => {
  const { call } = setup();
  const r = await call("gbk_get_capabilities");
  assert.equal(r.data.controllers[91].audible, true); assert.equal(r.data.controllers[93].audible, true);
  assert.ok(r.data.effects.reverb && r.data.voiceEditing.tools.includes("gbk_propose_voice_patch"));
  assert.ok(!JSON.stringify(r.data.unsupported).includes("reverb/chorus"));
});

test("get_voice_settings: human units + effective sends (zone + CC91 + override)", { skip: !sf && "no SoundFont" }, async () => {
  const { c, call, tid } = setup();
  const r = await call("gbk_get_voice_settings", { trackId: tid, key: 60 });
  assert.ok(r.ok, JSON.stringify(r.error)); assert.ok(r.data.zones.length > 0);
  const z = r.data.zones[0];
  assert.equal(z.generators.volEnvRelease.unit, "seconds"); assert.equal(z.generators.filterCutoff.unit, "Hz");
  const before = z.effectiveSends.reverb.effectivePercent;
  c.edit([{ op: "setCC", trackId: tid, channel: c.project.tracks.find((t) => t.id === tid)!.channel, controller: 91, startTick: 0, endTick: 0, mode: "replace", points: [{ tick: 0, value: 127 }] }]);
  const p = await call("gbk_propose_voice_patch", { trackId: tid, edits: [{ param: "reverbSend", mode: "add", value: 15 }] });
  await c.commitProposal(p.data.proposalId, { source: "user" });
  const after = (await call("gbk_get_voice_settings", { trackId: tid, key: 60 })).data.zones[0].effectiveSends.reverb;
  assert.ok(after.ccModulatorPercent > 0, JSON.stringify(after));
  assert.equal(after.overridePercent, 15);
  assert.ok(Math.abs(after.effectivePercent - Math.min(100, before + after.ccModulatorPercent + 15)) < 0.1, `${before} -> ${JSON.stringify(after)}`);
  // The engine renders exactly the reported send.
  const e = new Sf2SynthEngine(44100); const ch = c.project.tracks.find((t) => t.id === tid)!.channel;
  e.dispatchEvent({ type: "setPreset", regions: sf!.regionList(0) }); e.setVoiceOverrides(-1, c.project.sound!.tracks[tid]);
  e.dispatchEvent({ type: "controlChange", channel: ch, controller: 91, value: 127 });
  e.dispatchEvent({ type: "noteOn", channel: ch, note: 60, velocity: 100 });
  assert.ok(Math.abs(e.debugVoice(0)!.reverbAmt * 100 - after.effectivePercent) < 0.1, `${e.debugVoice(0)!.reverbAmt}`);
});

test("voice patch: validation ranges, proposal -> commit -> undo/redo, persistence, MIDI export NRPN", async () => {
  const { c, call, tid } = setup();
  const bad = await call("gbk_propose_voice_patch", { trackId: tid, edits: [{ param: "volEnvRelease", mode: "set", value: 500 }] });
  assert.equal(bad.ok, false); assert.equal(bad.error!.code, "INVALID_ARGUMENT"); assert.match(bad.error!.message, /outside the SF2 range/);
  const bad2 = await call("gbk_propose_voice_patch", { trackId: tid, edits: [{ param: "volEnvRelease", mode: "add", value: 1 }] });
  assert.equal(bad2.ok, false);
  const rev0 = c.project.revision;
  const p = await call("gbk_propose_voice_patch", { trackId: tid, edits: [{ param: "volEnvRelease", mode: "set", value: 3 }, { param: "reverbSend", mode: "add", value: 30 }, { param: "filterCutoff", mode: "set", value: 4000, keyLo: 60, keyHi: 72 }] });
  assert.ok(p.ok, JSON.stringify(p.error)); assert.equal(c.project.revision, rev0); assert.equal(c.project.sound, undefined);
  assert.ok(p.data.range.endTick > p.data.range.startTick);
  const fx = await call("gbk_set_effects", { roomSize: 0.9, reverbLevel: 0.8 });
  assert.ok(fx.ok);
  const fxBad = await call("gbk_set_effects", { roomSize: 3 }); assert.equal(fxBad.ok, false);
  const commit = await call("gbk_commit_proposal", { proposalId: p.data.proposalId });
  assert.ok(commit.ok, JSON.stringify(commit.error));
  assert.deepEqual(c.project.sound!.tracks[tid].map((o) => o.gen), [38, 16, 8]);
  assert.equal(c.project.sound!.tracks[tid][0].value, Math.round(1200 * Math.log2(3)));
  // fx proposal is now stale (revision moved): re-propose and commit
  const fx2 = await call("gbk_set_effects", { roomSize: 0.9, reverbLevel: 0.8 });
  await call("gbk_commit_proposal", { proposalId: fx2.data.proposalId });
  assert.equal(c.project.sound!.effects!.roomSize, 0.9);
  assert.ok(c.undo()); assert.equal(c.project.sound!.effects, null);
  assert.ok(c.undo()); assert.equal((c.project.sound as { tracks: Record<string, unknown> } | undefined)?.tracks[tid], undefined);
  assert.ok(c.redo()); assert.ok(c.redo()); assert.equal(c.project.sound!.effects!.roomSize, 0.9);
  // persistence round-trip
  const back = migrateProject(JSON.parse(JSON.stringify(c.project)))!;
  assert.deepEqual(back.sound, c.project.sound);
  assert.equal(migrateProject({ ...JSON.parse(JSON.stringify(c.project)), sound: 5 })!.sound, undefined);
  // MIDI export: the additive reverb override becomes SF2 NRPN (99=120, 98=16); internal player SMF has none.
  const ex = c.prepareMidiExport().bytes, internal = serializeSmf(c.project);
  const ch = c.project.tracks.find((t) => t.id === tid)!.channel;
  const has = (b: Uint8Array) => { for (let i = 0; i + 5 < b.length; i++) if (b[i] === (0xb0 | ch) && b[i + 1] === 99 && b[i + 2] === 120) return true; return false; };
  assert.ok(has(ex)); assert.ok(!has(internal));
  const re = parseSmf(ex, "re");
  const nr = re.ccs.filter((e) => e.controller === 98 && e.value === 16 && e.tick === 0);
  assert.ok(nr.length >= 1);
  // replaying those CCs in the engine reproduces the +30 % send
  const e = new Sf2SynthEngine(44100);
  const ccs = re.ccs.filter((x) => x.tick === 0 && x.channel === ch && [99, 98, 38, 6].includes(x.controller));
  for (const x of ccs) e.dispatchEvent({ type: "controlChange", channel: ch, controller: x.controller, value: x.value });
  assert.equal(e.debugNrpn(ch, 16), 300);
});
