// Content-addressed SoundFont URLs. Bundled fonts are served at static/sf/<name>.<sha256[0:12]>.sf2 (immutable, cached
// for a year, precompressed .gz next to them), so a deploy never invalidates the browser's copy. The plain
// static/<name>.sf2 copy still ships for the server-side renderer and old links. The Vite plugin in vite.config.ts writes
// the hashed copies at build time and maps them back to public/static/<name>.sf2 in dev.
import catalog from "../../soundfonts/catalog.json";

export interface CatalogFont { id: string; file: string; bytes: number; sha256: string; delivery: string; default?: boolean; label: string }
export const CATALOG_FONTS = (catalog as { fonts: CatalogFont[] }).fonts;
export const hashedSoundFontPath = (f: { file: string; sha256: string }) => `static/sf/${f.file.replace(/\.sf2$/i, "")}.${f.sha256.slice(0, 12)}.sf2`;
const def = CATALOG_FONTS.find((f) => f.default) ?? CATALOG_FONTS[0];
/** Base-relative URL path of the default SoundFont ("static/sf/GeneralUser-GS.<hash>.sf2"). */
export const DEFAULT_SOUNDFONT_PATH = hashedSoundFontPath(def);
export const DEFAULT_SOUNDFONT_BYTES = def.bytes;
export const DEFAULT_SOUNDFONT_LABEL = def.file;
/** Known uncompressed size for a hashed/plain font URL (content-length is the compressed size when gzip is used). */
export function knownSoundFontBytes(url: string): number | null {
  for (const f of CATALOG_FONTS) if (url.endsWith(hashedSoundFontPath(f)) || url.endsWith(`/${f.file}`)) return f.bytes;
  return null;
}
/** Hashed URLs never change content: cache them in Cache Storage so repeat visits skip the network. */
export const isImmutableSoundFontUrl = (url: string) => /\/static\/sf\/[^/]+\.[0-9a-f]{12}\.sf2$/.test(url.split("?")[0]);
