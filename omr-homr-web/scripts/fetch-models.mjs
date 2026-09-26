// Downloads the pinned homr ONNX checkpoints into omr-homr-web/models/
// (gitignored). Run: npm run fetch:models
//
// Versions and SHA-256s mirror yishengjiang99/omr-sheet-cam models.lock
// (SegNet 308 fp16, encoder 465 fp16, decoder 465 fp32), plus the encoder 465
// fp32 build from the same release for the WASM path (src/omr-sheet-bridge.ts
// uses it when WebGPU is unavailable; node tests use it too). Each release
// asset is a .zip; the listed .onnx is extracted from it with `unzip` and
// written under the filename the app loads.
//
// Idempotent: a file whose SHA-256 already matches is skipped. Anything else
// is downloaded, extracted and verified; a mismatching file is never left in
// models/, and the script exits non-zero on any failure.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { get } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE = "https://github.com/liebharc/homr/releases/download/onnx_checkpoints";
const MODELS = [
  {
    file: "segnet_model_fp16.onnx",
    zip: "segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f_fp16.zip",
    entry: "segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f_fp16.onnx",
    sha256: "60f495496cb41473c0521d0811d8f44b9d5cff892d287974a8aebb3eaee2fa83",
  },
  {
    file: "transformer_encoder_model_fp16.onnx",
    zip: "encoder_pytorch_model_465-597144cab54c8f6d0f6c9619df5c5312694eadd6_fp16.zip",
    entry: "encoder_pytorch_model_465-597144cab54c8f6d0f6c9619df5c5312694eadd6_fp16.onnx",
    sha256: "50823c061533328f5e64df016d3ed16eb9071a9f5c5ee8621646cf9ac9c8a992",
  },
  {
    file: "transformer_decoder_model_fp32.onnx",
    zip: "decoder_pytorch_model_465-597144cab54c8f6d0f6c9619df5c5312694eadd6.zip",
    entry: "decoder_pytorch_model_465-597144cab54c8f6d0f6c9619df5c5312694eadd6.onnx",
    sha256: "18801c1e3657bdea1b031db90b10d66e15accfc1d607780f09a9e059133e886a",
  },
  {
    // fp32 encoder: WASM fallback in the browser and the node tests (no fp16 on wasm EP).
    file: "transformer_encoder_model_fp32.onnx",
    zip: "encoder_pytorch_model_465-597144cab54c8f6d0f6c9619df5c5312694eadd6.zip",
    entry: "encoder_pytorch_model_465-597144cab54c8f6d0f6c9619df5c5312694eadd6.onnx",
    sha256: "92bd18338dc8da3c9b00185008ab14719ff9f912efe785ca42d7b623e06e0c6b",
  },
];

const root = dirname(fileURLToPath(import.meta.url));
const destDir = join(root, "..", "models");
mkdirSync(destDir, { recursive: true });
// Drop scratch dirs left behind by an interrupted earlier run.
for (const name of readdirSync(destDir)) {
  if (name.startsWith(".fetch-")) rmSync(join(destDir, name), { recursive: true, force: true });
}

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { "User-Agent": "omr-homr-web" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error(`too many redirects for ${url}`));
        resolve(download(new URL(res.headers.location, url).href, dest, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const out = createWriteStream(dest);
      res.on("error", reject);
      res.pipe(out);
      out.on("finish", () => resolve());
      out.on("error", reject);
    }).on("error", reject);
  });
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

// Scratch dir inside models/ so the final rename never crosses filesystems.
const tmp = mkdtempSync(join(destDir, ".fetch-"));
let fetched = 0;
let skipped = 0;
try {
  for (const { file, zip, entry, sha256: want } of MODELS) {
    const dest = join(destDir, file);
    if (existsSync(dest)) {
      const have = await sha256(dest);
      if (have === want) {
        console.log(`skip   ${file} (sha256 ok)`);
        skipped++;
        continue;
      }
      console.log(`stale  ${file} (have ${have}, want ${want}) - re-downloading`);
      rmSync(dest, { force: true });
    }

    const url = `${RELEASE}/${zip}`;
    const zipPath = join(tmp, zip);
    const outDir = join(tmp, "x");
    console.log(`fetch  ${url}`);
    await download(url, zipPath);
    execFileSync("unzip", ["-tq", zipPath], { stdio: ["ignore", "ignore", "inherit"] });
    execFileSync("unzip", ["-oq", zipPath, entry, "-d", outDir], { stdio: "inherit" });
    const got = join(outDir, entry);
    const have = await sha256(got);
    if (have !== want) {
      rmSync(got, { force: true });
      throw new Error(`sha256 mismatch for ${file} (${entry} from ${zip}): got ${have}, want ${want}`);
    }
    renameSync(got, `${dest}.part`);
    renameSync(`${dest}.part`, dest);
    rmSync(zipPath, { force: true });
    console.log(`ok     ${file} <- ${entry}`);
    fetched++;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`done: ${fetched} fetched, ${skipped} skipped -> ${destDir}`);
