// Copies the (gitignored, fetched) OMR ONNX weights into public/omr-models/
// so `vite build` ships them at /omr-models/ on the deployed site.
// Run automatically as part of `npm run build`; safe to run by hand too.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "omr-homr-web", "models");
const destDir = join(root, "public", "omr-models");

// 1. Make sure the weights exist (downloads ~155 MB on first run, skips when cached).
execFileSync("node", [join(root, "omr-homr-web", "scripts", "fetch-models.mjs")], {
  stdio: "inherit",
});

// 2. Copy every .onnx into public/omr-models/.
mkdirSync(destDir, { recursive: true });
const copied = [];
for (const file of readdirSync(srcDir)) {
  if (!file.endsWith(".onnx")) continue;
  copyFileSync(join(srcDir, file), join(destDir, file));
  copied.push(file);
}
if (copied.length === 0) throw new Error(`no .onnx files found in ${srcDir}`);
console.log(`omr-models ready -> public/omr-models/ (${copied.length} files)`);
