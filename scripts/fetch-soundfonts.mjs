// Downloads the pinned SoundFonts from soundfonts/catalog.json into soundfonts/
// (gitignored *.sf2; only catalog.json, README.md and licenses/ are committed).
// This is the repo's OMR-model pattern (omr-homr-web/scripts/fetch-models.mjs)
// applied to SoundFonts: provenance + sha256 pins live in the committed catalog,
// the large binaries are fetched at build/deploy time and verified, never committed.
//
// Usage:
//   node scripts/fetch-soundfonts.mjs            # bundled fonts only (build)
//   node scripts/fetch-soundfonts.mjs --server   # also the server-delivery fonts (compose deploy)
// Idempotent: a file whose sha256 already matches is skipped.
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { get } from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(join(root, "soundfonts", "catalog.json"), "utf8"));
const wantServer = process.argv.includes("--server");
const destDir = join(root, "soundfonts");
mkdirSync(destDir, { recursive: true });

function download(url, dest, redirects = 6) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { "User-Agent": "gbk-fetch-soundfonts" } }, (res) => {
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

async function shaOk(path, want) {
  return existsSync(path) && (await sha256(path)) === want;
}

let fetched = 0;
let skipped = 0;
for (const font of catalog.fonts) {
  if (font.delivery === "server" && !wantServer) continue;
  const dest = join(destDir, font.file);
  if (await shaOk(dest, font.sha256)) {
    console.log(`skip   ${font.file} (sha256 ok)`);
    skipped++;
    continue;
  }
  // The default font is also committed under public/static/ (historic); a verified
  // committed copy seeds soundfonts/ without a download.
  const committed = join(root, "public", "static", font.file);
  if (await shaOk(committed, font.sha256)) {
    copyFileSync(committed, dest);
    console.log(`seed   ${font.file} (from committed public/static copy, sha256 ok)`);
    skipped++;
    continue;
  }
  // Vendored fonts (user-provided uploads) are committed in-repo and have no
  // upstream URL: copy the vendored binary, sha-verified like a download.
  if (font.vendored) {
    const vendoredPath = join(root, font.vendored);
    if (!(await shaOk(vendoredPath, font.sha256))) throw new Error(`vendored SoundFont missing or sha256 mismatch: ${vendoredPath}`);
    copyFileSync(vendoredPath, dest);
    console.log(`seed   ${font.file} (from vendored ${font.vendored}, sha256 ok)`);
    skipped++;
    continue;
  }
  const tmp = `${dest}.part`;
  rmSync(tmp, { force: true });
  console.log(`fetch  ${font.file} (${(font.bytes / 1e6).toFixed(1)} MB) <- ${font.url}`);
  await download(font.url, tmp);
  const have = await sha256(tmp);
  if (have !== font.sha256) {
    rmSync(tmp, { force: true });
    throw new Error(`sha256 mismatch for ${font.file}: got ${have}, want ${font.sha256} (source ${font.source} @ ${font.sourceRef})`);
  }
  renameSync(tmp, dest);
  fetched++;
}
console.log(`soundfonts fetched: ${fetched}, already present: ${skipped}`);
