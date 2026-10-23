// Renderer/voice-tool SoundFont parity, autoPan default + explicit-pan precedence, track volume fader and CC91 truth.
import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./support/compose-setup.ts";
import { bindRendererSoundFont } from "../src/audio/renderer-host.ts";
import { renderProjectOffline, type OfflineRenderOptions } from "../src/audio/offline-renderer.ts";
import { parseWavHeader } from "../src/audio/audio-validation.ts";
import { Sf2SynthEngine } from "../src/sf2-renderer.ts";
import { peekSoundFont } from "../src/audio/soundfont-loader.ts";
import { CC_CAPS } from "../src/webmcp/tools.ts";

const OPT: OfflineRenderOptions = { sampleRate: 44100, channels: 2, format: "float32", tailSeconds: 1, normalize: "off" };
async function song(tracks: { name: string; program: number; channel?: number }[]) {
  const s = setup(); bindRendererSoundFont(s.c);
  await s.call("gbk_create_project", { name: "Parity", tempo: 120, replaceCurrent: true });
  const r = await s.call("gbk_create_track", { tracks });
  const ids: string[] = r.data.trackIds;
  for (const id of ids) await s.call("gbk_generate_part", { trackId: id, range: { unit: "bars", start: 1, end: 2 }, kind: "melody", seed: 3 });
  return { ...s, ids };
}
const pcm = (b: Uint8Array) => { const h = parseWavHeader(b); return new Float32Array(b.buffer.slice(b.byteOffset + h.dataOffset, b.byteOffset + h.dataOffset + h.dataBytes)); };
const chDb = (s: Float32Array, ch: number) => { let e = 0; for (let i = ch; i < s.length; i += 2) e += s[i] ** 2; return 10 * Math.log10(e / (s.length / 2) + 1e-30); };
const db = (s: Float32Array) => 10 * Math.log10((s.reduce((a, x) => a + x * x, 0) / s.length) + 1e-30);

test("voice settings, preset list and the renderer resolve identical presets (violin/violin/viola/cello + drums)", async () => {
  const { c, call, ids } = await song([{ name: "Violin I", program: 40 }, { name: "Violin II", program: 40 }, { name: "Viola", program: 41 }, { name: "Cello", program: 42 }, { name: "Drums", program: 0, channel: 9 }]);
  const r = await renderProjectOffline(c.project, OPT, undefined, undefined, { soundFont: peekSoundFont()! });
  const list = await call("gbk_list_presets", { limit: 500 });
  assert.equal(list.ok, true); assert.deepEqual(list.warnings, []); assert.ok(list.data.length > 100);
  for (const [i, id] of ids.entries()) {
    const vs = await call("gbk_get_voice_settings", { trackId: id });
    assert.equal(vs.ok, true); assert.deepEqual(vs.warnings.filter((w: string) => /SoundFont/.test(w)), []);
    const inst = r.instruments[i];
    assert.equal(vs.data.preset.name, inst.presetName, `track ${i}`);
    const listed = list.data.find((x: { index: number }) => x.index === vs.data.preset.index);
    assert.deepEqual([listed.bank, listed.program, listed.name], [inst.bank, inst.program, inst.presetName]);
    assert.ok(vs.data.zones.length > 0);
  }
  assert.deepEqual(r.instruments.map((x) => x.program).slice(0, 4), [40, 40, 41, 42]);
  assert.equal(r.instruments[4].bank, 128);
  console.log(`# presets: ${r.instruments.map((x) => `${x.presetName} (${x.bank}:${x.program})`).join(", ")}`);
});

test("gbk_render_wav: autoPan defaults to off; explicit mix pan always wins; report shows the real pan", async () => {
  const { c, call, ids } = await song([{ name: "Violin", program: 40 }, { name: "Cello", program: 42 }]);
  const def = await call("gbk_render_wav", { output: "artifact", normalize: "off" });
  assert.equal(def.ok, true, JSON.stringify(def.error));
  assert.deepEqual(def.data.instruments.map((x: { pan: number; panSource: string }) => [x.pan, x.panSource]), [[0, "centre"], [0, "centre"]]);
  assert.equal((await call("gbk_set_track_mix", { trackId: ids[1], pan: 20 })).ok, true);
  const auto = await call("gbk_render_wav", { output: "artifact", normalize: "off", autoPan: true });
  const [v, ce] = auto.data.instruments;
  assert.deepEqual([v.pan, v.panSource], [-0.75, "auto"]);                  // no explicit pan -> seated
  assert.equal(ce.panSource, "mix"); assert.ok(Math.abs(ce.pan - (20 - 64) / 63) < 0.001); // explicit pan kept (not +0.65)
  const solo = await renderProjectOffline({ ...c.project, tracks: c.project.tracks.map((t, i) => ({ ...t, mix: { ...t.mix, mute: i === 0 } })) }, { ...OPT, autoPan: true }, undefined, undefined, { soundFont: peekSoundFont()! });
  const s = pcm(solo.bytes); assert.ok(chDb(s, 0) - chDb(s, 1) > 6, `cello panned left by its explicit pan: ${(chDb(s, 0) - chDb(s, 1)).toFixed(1)} dB`);
});

test("track volume (gbk_set_track_mix / slider) measurably changes the render, also over authored CC7", async () => {
  const { c, call, ids } = await song([{ name: "Piano", program: 0 }]);
  const render = async () => pcm((await renderProjectOffline(c.project, OPT, undefined, undefined, { soundFont: peekSoundFont()! })).bytes);
  const full = db(await render());
  await call("gbk_set_track_mix", { trackId: ids[0], volume: 50 });
  const half = db(await render());
  const r = await call("gbk_render_wav", { output: "artifact", normalize: "off" });
  console.log(`# volume 100 -> ${full.toFixed(2)} dB RMS, volume 50 -> ${half.toFixed(2)} dB (delta ${(half - full).toFixed(2)}), report faderDb ${r.data.instruments[0].faderDb}`);
  assert.ok(full - half > 10 && full - half < 14, `half volume ~ -12 dB, got ${(half - full).toFixed(2)}`);
  assert.equal(r.data.instruments[0].volume, 50); assert.ok(Math.abs(r.data.instruments[0].faderDb - 40 * Math.log10(0.5)) < 0.01);
});

test("fader works on top of authored CC7 (old behaviour: CC7 automation silently replaced the mix volume)", async () => {
  const { c, ids } = await song([{ name: "Piano", program: 0 }]);
  const p = structuredClone(c.project);
  p.ccs.push({ id: "cc7", trackId: ids[0], channel: p.tracks[0].channel, controller: 7, tick: 0, value: 110 } as never);
  const at = async (vol: number) => { const q = structuredClone(p); q.tracks[0].mix.volume = vol; return db(pcm((await renderProjectOffline(q, OPT, undefined, undefined, { soundFont: peekSoundFont()! })).bytes)); };
  const d = (await at(100)) - (await at(50));
  assert.ok(d > 10 && d < 14, `delta ${d.toFixed(2)}`);
});

test("master volume (live engine masterGainDb) scales output", () => {
  const sf = peekSoundFont()!.sf; const regions = sf.regionList(sf.resolvePresetIndex(0, 0)!);
  const run = (gainDb: number) => {
    const e = new Sf2SynthEngine(44100); e.masterDynamicsEnabled = false; e.masterGainDb = gainDb;
    e.dispatchEvent({ type: "setPreset", regions }); e.dispatchEvent({ type: "noteOn", note: 60, velocity: 100, channel: 0 });
    const L = new Float32Array(22050), R = new Float32Array(22050); e.renderRange(L, R); return db(L);
  };
  assert.ok(Math.abs(run(-3) - run(-23) - 20) < 0.01);
});

test("CC91/CC93 are reported audible (reverb/chorus are audible since the Freeverb return fix)", () => {
  assert.equal(CC_CAPS[91].audible, true); assert.equal(CC_CAPS[93].audible, true);
});
