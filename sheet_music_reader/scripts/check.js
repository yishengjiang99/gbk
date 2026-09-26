import { buildSwedenMidi, midiSummary } from "../src/swedenMidi.js";

const midi = buildSwedenMidi();
const header = String.fromCharCode(...midi.slice(0, 4));
const summary = midiSummary(midi);

if (header !== "MThd") {
  throw new Error(`Expected MThd header, got ${header}`);
}

if (summary.tracks !== 2) {
  throw new Error(`Expected 2 tracks, got ${summary.tracks}`);
}

if (summary.ticksPerQuarter !== 480) {
  throw new Error(`Expected 480 TPQ, got ${summary.ticksPerQuarter}`);
}

console.log(`OK: ${summary.bytes} bytes, ${summary.tracks} tracks, ${summary.ticksPerQuarter} TPQ`);
