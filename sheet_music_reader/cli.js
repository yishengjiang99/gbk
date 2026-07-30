#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildSwedenMidi, getDefaultFilename, midiSummary } from "./src/swedenMidi.js";

const outputPath = resolve(process.argv[2] ?? getDefaultFilename());
const midi = buildSwedenMidi();

await writeFile(outputPath, midi);

const summary = midiSummary(midi);
console.log(`Wrote ${outputPath}`);
console.log(`MIDI: ${summary.bytes} bytes, ${summary.tracks} tracks, ${summary.ticksPerQuarter} TPQ`);
