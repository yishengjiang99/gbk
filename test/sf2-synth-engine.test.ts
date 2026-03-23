import test from "node:test";
import assert from "node:assert/strict";

import { Sf2SynthEngine } from "../src/sf2-renderer.ts";
import type { SF2Region } from "../sf2-parser.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal SF2Region suitable for synthesis testing. */
function makeRegion(overrides: Partial<SF2Region> = {}): SF2Region {
  const SR = 44100;
  const len = SR; // 1 second of audio
  const dataL = new Float32Array(len);
  // Fill with a simple constant (0.5) so output is predictable
  dataL.fill(0.5);

  return {
    keyRange: [0, 127],
    velRange: [0, 127],
    sample: {
      dataL,
      dataR: null,
      sampleRate: SR,
      start: 0,
      end: len,
      loopStart: 0,
      loopEnd: len,
    },
    sampleModes: 1, // loop continuous
    originalKey: 60,
    overridingRootKey: null,
    coarseTune: 0,
    fineTune: 0,
    scaleTuning: 100,
    initialAttenuationCb: 0,
    pan: 0,
    // Very fast envelopes so audio is audible in a small render buffer
    volEnv: { delayTc: -32768, attackTc: -32768, holdTc: -12000, decayTc: -32768, sustainCb: 0, releaseTc: -12000 },
    modEnv: { delayTc: -32768, attackTc: -32768, holdTc: -12000, decayTc: -32768, sustain: 0, releaseTc: -12000 },
    initialFilterFcCents: 13500, // fully open filter
    initialFilterQCb: 0,
    modEnvToFilterFcCents: 0,
    modLfoToFilterFcCents: 0,
    modLfoDelayTc: -32768,
    modLfoFreqCents: 0,
    modLfoToPitchCents: 0,
    vibLfoDelayTc: -32768,
    vibLfoFreqCents: 0,
    vibLfoToPitchCents: 0,
    exclusiveClass: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constructor / configuration
// ---------------------------------------------------------------------------

test("Sf2SynthEngine constructs with default state", () => {
  const engine = new Sf2SynthEngine(44100);
  assert.equal(engine.outSr, 44100);
  assert.equal(engine.voices.length, 0);
  assert.equal(engine.regions.length, 0);
  assert.equal(engine.maxVoices, 64);
  assert.equal(engine.cc7Volume, 100);
  assert.equal(engine.cc10Pan, 64);
  assert.equal(engine.cc11Expression, 127);
});

test("Sf2SynthEngine setMaxVoices enforces minimum of 1", () => {
  const engine = new Sf2SynthEngine(44100);
  engine.setMaxVoices(0);
  assert.equal(engine.maxVoices, 1);
  engine.setMaxVoices(32);
  assert.equal(engine.maxVoices, 32);
});

// ---------------------------------------------------------------------------
// setPreset
// ---------------------------------------------------------------------------

test("dispatchEvent setPreset replaces global regions and clears voices", () => {
  const engine = new Sf2SynthEngine(44100);
  const region = makeRegion();
  engine.dispatchEvent({ type: "noteOn", note: 60, velocity: 100 });
  // Voices won't be created because no regions, but let's set one directly
  engine.regions = [region];
  engine.dispatchEvent({ type: "setPreset", regions: [] });
  assert.equal(engine.regions.length, 0);
  assert.equal(engine.voices.length, 0);
});

test("dispatchEvent setPreset with valid regions stores them", () => {
  const engine = new Sf2SynthEngine(44100);
  const region = makeRegion();
  engine.dispatchEvent({ type: "setPreset", regions: [region] });
  assert.equal(engine.regions.length, 1);
});

// ---------------------------------------------------------------------------
// pickRegions
// ---------------------------------------------------------------------------

test("pickRegions returns matching regions for note and velocity", () => {
  const engine = new Sf2SynthEngine(44100);
  const r1 = makeRegion({ keyRange: [60, 72], velRange: [64, 127] });
  const r2 = makeRegion({ keyRange: [0, 59], velRange: [0, 127] });
  engine.regions = [r1, r2];

  assert.deepEqual(engine.pickRegions(64, 100), [r1]);
  assert.deepEqual(engine.pickRegions(40, 80), [r2]);
  assert.deepEqual(engine.pickRegions(64, 40), []); // vel 40 < 64
});

test("pickRegions returns empty array when no regions loaded", () => {
  const engine = new Sf2SynthEngine(44100);
  assert.deepEqual(engine.pickRegions(60, 100), []);
});

// ---------------------------------------------------------------------------
// noteOn / noteOff / voice management
// ---------------------------------------------------------------------------

test("dispatchEvent noteOn with no matching regions creates no voices", () => {
  const engine = new Sf2SynthEngine(44100);
  // No regions loaded
  engine.dispatchEvent({ type: "noteOn", note: 60, velocity: 100 });
  assert.equal(engine.voices.length, 0);
});

test("dispatchEvent noteOn creates a voice for a matching region", () => {
  const engine = new Sf2SynthEngine(44100);
  engine.dispatchEvent({ type: "setPreset", regions: [makeRegion()] });
  engine.dispatchEvent({ type: "noteOn", note: 60, velocity: 100 });
  assert.equal(engine.voices.length, 1);
  assert.equal(engine.voices[0].note, 60);
  assert.equal(engine.voices[0].velocity, 100);
});

test("dispatchEvent noteOff puts matching voice into release", () => {
  const engine = new Sf2SynthEngine(44100);
  engine.dispatchEvent({ type: "setPreset", regions: [makeRegion()] });
  engine.dispatchEvent({ type: "noteOn", note: 60, velocity: 100 });
  assert.equal(engine.voices.length, 1);
  engine.dispatchEvent({ type: "noteOff", note: 60 });
  // Voice should now be in release stage
  assert.equal(engine.voices[0].volEnv.stage, "release");
});

test("dispatchEvent noteOff does not affect voices for different notes", () => {
  const engine = new Sf2SynthEngine(44100);
  engine.dispatchEvent({ type: "setPreset", regions: [makeRegion()] });
  engine.dispatchEvent({ type: "noteOn", note: 60, velocity: 100 });
  engine.dispatchEvent({ type: "noteOff", note: 64 }); // different note
  assert.notEqual(engine.voices[0].volEnv.stage, "release");
});

// ---------------------------------------------------------------------------
// Polyphony limiting
// ---------------------------------------------------------------------------

test("ensurePolyphony drops quietest voice when maxVoices is reached", () => {
  const engine = new Sf2SynthEngine(44100, { maxVoices: 2 });
  engine.dispatchEvent({ type: "setPreset", regions: [makeRegion()] });

  engine.dispatchEvent({ type: "noteOn", note: 60, velocity: 100 });
  engine.dispatchEvent({ type: "noteOn", note: 62, velocity: 100 });
  assert.equal(engine.voices.length, 2);

  // Adding a third note should trigger polyphony management (drop the quietest)
  engine.dispatchEvent({ type: "noteOn", note: 64, velocity: 100 });
  assert.equal(engine.voices.length, 2);
});

// ---------------------------------------------------------------------------
// setControllers
// ---------------------------------------------------------------------------

test("dispatchEvent setControllers updates global CCs", () => {
  const engine = new Sf2SynthEngine(44100);
  engine.dispatchEvent({ type: "setControllers", cc7Volume: 80, cc10Pan: 80, cc11Expression: 90 });
  assert.equal(engine.cc7Volume, 80);
  assert.equal(engine.cc10Pan, 80);
  assert.equal(engine.cc11Expression, 90);
});

test("dispatchEvent setControllers clamps CC values to 0-127", () => {
  const engine = new Sf2SynthEngine(44100);
  engine.dispatchEvent({ type: "setControllers", cc7Volume: 200, cc10Pan: -5 });
  assert.equal(engine.cc7Volume, 127);
  assert.equal(engine.cc10Pan, 0);
});

// ---------------------------------------------------------------------------
// Track-based state
// ---------------------------------------------------------------------------

test("setTrackStates stores per-track regions and parameters", () => {
  const engine = new Sf2SynthEngine(44100);
  const region = makeRegion();
  engine.setTrackStates([
    { trackIndex: 0, regions: [region], cc7Volume: 90, cc10Pan: 32, cc11Expression: 100, pan: 0.5, gain: 0.8 },
  ]);
  assert.equal(engine.trackStates.size, 1);
  const ts = engine.trackStates.get(0)!;
  assert.equal(ts.cc7Volume, 90);
  assert.equal(ts.cc10Pan, 32);
  assert.equal(ts.gain, 0.8);
  assert.equal(ts.regions.length, 1);
});

test("setTrackStates clears active voices", () => {
  const engine = new Sf2SynthEngine(44100);
  engine.dispatchEvent({ type: "setPreset", regions: [makeRegion()] });
  engine.dispatchEvent({ type: "noteOn", note: 60, velocity: 100 });
  assert.equal(engine.voices.length, 1);

  engine.setTrackStates([]);
  assert.equal(engine.voices.length, 0);
});

// ---------------------------------------------------------------------------
// renderRange produces audio
// ---------------------------------------------------------------------------

test("renderRange fills silence when no voices are active", () => {
  const engine = new Sf2SynthEngine(44100);
  const outL = new Float32Array(128);
  const outR = new Float32Array(128);
  outL.fill(1); // pre-fill to confirm it gets zeroed
  outR.fill(1);
  engine.renderRange(outL, outR);
  assert.ok(outL.every((v) => v === 0), "outL should be silent with no voices");
  assert.ok(outR.every((v) => v === 0), "outR should be silent with no voices");
});

test("renderRange produces non-zero output after noteOn", () => {
  const engine = new Sf2SynthEngine(44100);
  engine.dispatchEvent({ type: "setPreset", regions: [makeRegion()] });
  engine.dispatchEvent({ type: "noteOn", note: 60, velocity: 127 });

  const outL = new Float32Array(256);
  const outR = new Float32Array(256);
  engine.renderRange(outL, outR);

  const hasSignal = outL.some((v) => Math.abs(v) > 1e-6);
  assert.ok(hasSignal, "renderRange should produce non-zero audio after noteOn");
});

test("renderRange removes finished voices after sample playback ends", () => {
  const SR = 44100;
  const shortLen = 32; // very short sample
  const dataL = new Float32Array(shortLen).fill(0.5);
  const region = makeRegion({
    sample: { dataL, dataR: null, sampleRate: SR, start: 0, end: shortLen, loopStart: 0, loopEnd: shortLen },
    sampleModes: 0, // no looping — voice finishes when sample ends
  });

  const engine = new Sf2SynthEngine(SR);
  engine.dispatchEvent({ type: "setPreset", regions: [region] });
  engine.dispatchEvent({ type: "noteOn", note: 60, velocity: 127 });
  assert.equal(engine.voices.length, 1);

  // Render enough samples for the voice to exhaust the short sample
  const outL = new Float32Array(SR); // 1 second
  const outR = new Float32Array(SR);
  engine.renderRange(outL, outR);

  // Voice should have been cleaned up
  assert.equal(engine.voices.length, 0);
});

// ---------------------------------------------------------------------------
// exclusive class (choke groups)
// ---------------------------------------------------------------------------

test("chokeExclusive releases voices with the same exclusive class", () => {
  const engine = new Sf2SynthEngine(44100);
  const region = makeRegion({ exclusiveClass: 1 });
  engine.dispatchEvent({ type: "setPreset", regions: [region] });

  engine.dispatchEvent({ type: "noteOn", note: 60, velocity: 100 });
  assert.equal(engine.voices.length, 1);
  // Start a second note with same exclusive class — should choke the first
  engine.dispatchEvent({ type: "noteOn", note: 62, velocity: 100 });
  // The first voice should now be in release
  assert.equal(engine.voices[0].volEnv.stage, "release");
});
