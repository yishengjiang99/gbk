// Build step (part of `npm run build`, after gen:midi-manifest):
//  1. Ensures the bundled SoundFonts are present in soundfonts/ (pinned fetch,
//     sha256-verified — see scripts/fetch-soundfonts.mjs).
//  2. Copies the bundled fonts into public/static/ so `vite build` ships them
//     in dist/static on both GitHub Pages and compose.grepawk.com.
//  3. Writes public/static/soundfont-manifest.json, which the app fetches at
//     runtime to populate the SoundFont picker (src/App.tsx). The large
//     server-delivery font (FluidR3 GM) is listed only for compose builds
//     (GBK_SOUNDFONT_SERVER=1, set by `npm run build:compose`); its bytes live
//     outside the releases in /var/www/gbk-composer/soundfonts/ on the server
//     and are served at its catalog `serverPath` (see deploy/nginx.conf).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(join(root, "soundfonts", "catalog.json"), "utf8"));
const includeServer = process.env.GBK_SOUNDFONT_SERVER === "1";

execFileSync("node", [join(root, "scripts", "fetch-soundfonts.mjs")], { stdio: "inherit" });

const manifest = [];
for (const font of catalog.fonts) {
  const entry = {
    id: font.id,
    label: font.label,
    file: font.file,
    bytes: font.bytes,
    description: font.description,
    license: font.license,
    source: font.source,
    ...(font.default ? { default: true } : {}),
  };
  if (font.delivery === "bundled") {
    const src = join(root, "soundfonts", font.file);
    const dest = join(root, "public", "static", font.file);
    if (!existsSync(src)) throw new Error(`bundled SoundFont missing after fetch: ${src}`);
    copyFileSync(src, dest);
    entry.path = `static/${font.file}`;
  } else if (font.delivery === "server") {
    if (!includeServer) continue;
    entry.path = font.serverPath;
  }
  manifest.push(entry);
}
const out = join(root, "public", "static", "soundfont-manifest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`soundfont-manifest ready -> public/static/soundfont-manifest.json (${manifest.length} fonts${includeServer ? ", incl. server fonts" : ""})`);
