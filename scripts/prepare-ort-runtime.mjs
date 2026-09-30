// Stages the self-hosted onnxruntime-web WASM runtime files into
// public/ort-runtime/ so `vite build` ships them same-origin and the app no
// longer depends on cdn.jsdelivr.net at runtime.
//
// Source of truth is the installed onnxruntime-web npm package: the staged
// files are copied from node_modules/onnxruntime-web/dist/, so they always
// agree with the bundled JS version by construction (no version skew).
// Run automatically as part of `npm run build`; safe to run by hand too.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "node_modules", "onnxruntime-web");
const srcDir = join(pkgDir, "dist");
const destDir = join(root, "public", "ort-runtime");

// The WASM runtime files onnxruntime-web fetches from ort.env.wasm.wasmPaths
// at session-creation time: the default SIMD-threaded build plus the jsep
// (WebGPU), jspi and asyncify variants the loader may select per browser/EP.
const WASM_FILE_RE = /^ort-wasm-simd-threaded(\..*)?\.(mjs|wasm)$/;

if (!existsSync(srcDir)) {
  throw new Error(
    `onnxruntime-web dist not found at ${srcDir} — run \`npm install\` first`,
  );
}
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const files = readdirSync(srcDir).filter((f) => WASM_FILE_RE.test(f));
if (files.length === 0) {
  throw new Error(`no onnxruntime-web WASM runtime files found in ${srcDir}`);
}
mkdirSync(destDir, { recursive: true });
for (const file of files) {
  copyFileSync(join(srcDir, file), join(destDir, file));
}
console.log(
  `ort-runtime ready -> public/ort-runtime/ (${files.length} files, onnxruntime-web ${pkg.version})`,
);
