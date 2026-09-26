import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const staticDir = path.join(root, "public", "static");
const outFile = path.join(staticDir, "midi-manifest.json");

function isMidi(name) {
  return /\.mid(i)?$/i.test(name);
}

async function main() {
  const entries = await readdir(staticDir, { withFileTypes: true });
  const midiFiles = entries
    .filter((e) => e.isFile() && isMidi(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const manifest = midiFiles.map((name) => ({
    name,
    path: `static/${encodeURIComponent(name)}`,
  }));

  await writeFile(outFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  process.stdout.write(`Generated ${path.relative(root, outFile)} (${manifest.length} files)\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

