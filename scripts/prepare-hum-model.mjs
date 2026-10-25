// Stages the Spotify Basic Pitch ONNX model (ICASSP 2022) into
// public/hum-models/ so `vite build` ships it same-origin at /hum-models/
// for the Hum-to-composer transcription worker (src/hum/).
// Pinned download, never a committed binary (same pattern as the OMR
// models): source is the basic-pitch v0.4.0 tag, byte-identical to the
// model inside the PyPI basic-pitch 0.4.0 wheel
// (basic_pitch/saved_models/icassp_2022/nmp.onnx). Apache-2.0; the LICENSE
// is staged next to the model. Run automatically as part of `npm run build`.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "public", "hum-models");
const MODEL_URL = "https://raw.githubusercontent.com/spotify/basic-pitch/v0.4.0/basic_pitch/saved_models/icassp_2022/nmp.onnx";
const MODEL_SHA256 = "2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec";
const LICENSE_URL = "https://raw.githubusercontent.com/spotify/basic-pitch/v0.4.0/LICENSE";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

mkdirSync(destDir, { recursive: true });
const modelPath = join(destDir, "basic-pitch.onnx");
if (existsSync(modelPath) && sha256(readFileSync(modelPath)) === MODEL_SHA256) {
  console.log("hum-model ready (cached) -> public/hum-models/basic-pitch.onnx");
} else {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`hum model download failed: ${res.status} ${MODEL_URL}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== MODEL_SHA256) throw new Error(`hum model sha256 mismatch: ${got} != ${MODEL_SHA256}`);
  writeFileSync(modelPath, buf);
  console.log(`hum-model ready -> public/hum-models/basic-pitch.onnx (${buf.length} bytes, sha256 verified)`);
}
const licensePath = join(destDir, "LICENSE-basic-pitch.txt");
if (!existsSync(licensePath)) {
  const res = await fetch(LICENSE_URL);
  if (!res.ok) throw new Error(`license download failed: ${res.status} ${LICENSE_URL}`);
  const text = await res.text();
  if (!/Apache License/.test(text.slice(0, 512))) throw new Error("unexpected LICENSE content from basic-pitch repo");
  writeFileSync(licensePath, text);
  console.log("hum-model license staged -> public/hum-models/LICENSE-basic-pitch.txt");
}
