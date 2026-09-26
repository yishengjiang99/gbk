import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { generateBachMidi } from "../src/bach-generator.ts";
import { parseMidiBuffer } from "../src/midi-timer.worker.ts";
import { renderOfflineSequenceToAudioBuffer } from "../src/sf2-renderer.ts";
import { parseSF2 } from "../sf2-parser.ts";

class TestAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  private channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

test("generateBachMidi creates a parseable multi-track MIDI file", () => {
  const generated = generateBachMidi({ seed: 12345 });
  const song = parseMidiBuffer(generated.midiData);

  assert.equal(generated.fileName, "generated-bach-12345.mid");
  assert.equal(song.tracks.length, 4);
  assert.equal(song.bpm, 92);
  assert.equal(song.timeSig, "4/4");
  assert.ok(song.durationSec > 0);
  assert.ok(song.tracks.reduce((sum, track) => sum + track.notes.length, 0) > 0);
});

test("generated Bach render has audible signal in the opening seconds", () => {
  const sf2 = parseSF2(new Uint8Array(readFileSync("public/static/GeneralUser-GS.sf2")));
  const presets = sf2.pdta.phdr.slice(0, -1);
  const resolvePreset = (program: number, bank: number): number => {
    const exact = presets.findIndex((preset) => preset.preset === program && preset.bank === bank);
    if (exact >= 0) return exact;
    const bankZero = presets.findIndex((preset) => preset.preset === program && preset.bank === 0);
    if (bankZero >= 0) return bankZero;
    const anyBank = presets.findIndex((preset) => preset.preset === program);
    return anyBank >= 0 ? anyBank : 0;
  };

  const song = parseMidiBuffer(generateBachMidi({ seed: 12345 }).midiData);
  const sampleRate = 44100;
  const tracks = [];
  const events = [];

  for (const track of song.tracks) {
    const programEvent = track.playEvents.find((event) => event.type === "program");
    const presetIndex =
      programEvent?.type === "program"
        ? resolvePreset(programEvent.program, programEvent.bank)
        : 0;
    tracks.push({
      trackIndex: track.index,
      regions: sf2.buildRegionsForPreset(presetIndex, {
        decodeToFloat32: true,
        normalize: true,
        includeStereoLinks: true,
      }),
      cc7Volume: 100,
      cc10Pan: 64,
      cc11Expression: 127,
      pan: 0,
      gain: 1,
    });

    for (const event of track.playEvents) {
      const frame = Math.max(0, Math.round(event.sec * sampleRate));
      if (event.type === "noteOn") {
        events.push({
          frame,
          seq: event.seq ?? 0,
          type: "noteOn",
          trackIndex: track.index,
          channel: event.channel,
          note: event.note,
          velocity: event.velocity,
        });
      } else if (event.type === "noteOff") {
        events.push({
          frame,
          seq: event.seq ?? 0,
          type: "noteOff",
          trackIndex: track.index,
          channel: event.channel,
          note: event.note,
        });
      }
    }
  }

  const audioBuffer = new TestAudioBuffer(2, sampleRate * 2, sampleRate);
  renderOfflineSequenceToAudioBuffer({
    audioBuffer: audioBuffer as unknown as AudioBuffer,
    tracks,
    events,
    maxVoices: 128,
  });

  const out = audioBuffer.getChannelData(0);
  const firstSecondPeak = out
    .subarray(0, sampleRate)
    .reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0);
  assert.ok(firstSecondPeak > 0.005, `opening peak ${firstSecondPeak} should be audible`);
});
