import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const staticDir = path.join(root, "public", "static");
const outFile = path.join(staticDir, "midi-manifest.json");
const remoteStaticUrl = "https://grepawk.com/static/";

function isMidi(name) {
  return /\.mid(i)?$/i.test(name);
}

function parseNginxIndexFileNames(html, predicate) {
  const files = new Set();
  const hrefRe = /href="([^"]+)"/gi;
  let match = hrefRe.exec(html);
  while (match) {
    const href = match[1];
    if (href && !href.endsWith("/")) {
      try {
        const url = new URL(href, remoteStaticUrl);
        const rawName = url.pathname.split("/").pop() ?? "";
        const name = decodeURIComponent(rawName);
        if (name && predicate(name)) {
          files.add(name);
        }
      } catch {
        // Ignore malformed href entries.
      }
    }
    match = hrefRe.exec(html);
  }
  return Array.from(files);
}

async function getRemoteMidiFiles() {
  try {
    const response = await fetch(remoteStaticUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const html = await response.text();
    return parseNginxIndexFileNames(html, isMidi);
  } catch (err) {
    process.stderr.write(`Warning: failed to load ${remoteStaticUrl} (${err.message})\n`);
    return [];
  }
}

async function main() {
  const entries = await readdir(staticDir, { withFileTypes: true });
  const localMidiFiles = entries
    .filter((e) => e.isFile() && isMidi(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  const remoteMidiFiles = (await getRemoteMidiFiles()).sort((a, b) => a.localeCompare(b));

  const byName = new Map();
  for (const name of localMidiFiles) {
    byName.set(name.toLowerCase(), {
      name,
      path: `static/${encodeURIComponent(name)}`,
    });
  }
  for (const name of remoteMidiFiles) {
    const key = name.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, {
        name,
        path: `${remoteStaticUrl}${encodeURIComponent(name)}`,
      });
    }
  }
  const manifest = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));

  await writeFile(outFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  process.stdout.write(`Generated ${path.relative(root, outFile)} (${manifest.length} files)\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
