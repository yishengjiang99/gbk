// Downloads the three Phase 2 ONNX weights from homr's public release into
// omr-homr-web/models/ directory (gitignored). Run: npm run fetch:models
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { get } from "node:https";

const RELEASE = "https://github.com/liebharc/homr/releases/download/onnx_checkpoints";
const MODELS = [
  { file: "segnet_model_fp16.onnx", bytes: 28667207 },
  { file: "transformer_encoder_model_fp16.onnx", bytes: 26466256 },
  { file: "transformer_decoder_model_fp32.onnx", bytes: 47309835 },
  // fp32 encoder is test-only: the wasm EP used by node tests cannot run fp16.
  { file: "transformer_encoder_model_fp32.onnx", bytes: 52861122 },
];

const root = dirname(fileURLToPath(import.meta.url));
const destDir = join(root, "..", "models");
mkdirSync(destDir, { recursive: true });

function download(url, dest) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { "User-Agent": "omr-homr-web" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(download(res.headers.location, dest));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const out = createWriteStream(dest);
      res.pipe(out);
      out.on("finish", () => resolve());
      out.on("error", reject);
    }).on("error", reject);
  });
}

for (const { file, bytes } of MODELS) {
  const dest = join(destDir, file);
  if (existsSync(dest) && statSync(dest).size === bytes) {
    console.log(`ok (cached): ${file}`);
    continue;
  }
  console.log(`downloading ${file} ...`);
  await download(`${RELEASE}/${file}`, dest);
  const size = statSync(dest).size;
  if (size !== bytes) throw new Error(`size mismatch for ${file}: ${size} != ${bytes}`);
  console.log(`ok: ${file} (${(size / 1048576).toFixed(1)} MB)`);
}
console.log("done ->", destDir);
