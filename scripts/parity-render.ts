// usage: node --import tsx/esm scripts/parity-render.ts <scenario.json> <out.f32>
// Cross-engine parity tool (same scenario format as sf2player-swift `sf2-parity-render`):
// renders through this engine and writes interleaved little-endian Float32 L/R frames.
import { readFileSync, writeFileSync } from "node:fs";
import { renderScenario, type Scenario } from "../src/sf2/parity.ts";

const [scenPath, outPath] = process.argv.slice(2);
if (!scenPath || !outPath) { console.error("usage: parity-render scenario.json out.f32"); process.exit(2); }
const scen = JSON.parse(readFileSync(scenPath, "utf8")) as Scenario;
const { left, right } = renderScenario(scen, (p) => new Uint8Array(readFileSync(p)));
const out = new Float32Array(left.length * 2);
for (let i = 0; i < left.length; i++) { out[2 * i] = left[i]; out[2 * i + 1] = right[i]; }
writeFileSync(outPath, new Uint8Array(out.buffer));
