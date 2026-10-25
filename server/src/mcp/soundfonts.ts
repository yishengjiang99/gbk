// SoundFont catalog access for the MCP surface. The pinned catalog
// (soundfonts/catalog.json) is the single source of truth shared with the web
// SoundFont picker and the build scripts (fetch/prepare-soundfonts). This
// module resolves catalog ids and reports, per font, whether the connected
// Studio tab could actually load it from THIS deployment. Production releases
// do not ship the catalog itself, so the catalog's generated form —
// dist/static/soundfont-manifest.json, written by prepare-soundfonts from the
// same catalog — is the fallback source (delivery is recovered from the entry
// path: bundled entries point at static/<file>, server entries at their
// /soundfonts/ serverPath).
//
//   delivery "bundled" — ships in the app build: dist/static/<file> (or the
//                        public/static source, or the soundfonts/ fetch cache).
//   delivery "server"  — too large to bundle; lives outside the releases in
//                        the persistent server soundfonts dir (deploy.sh syncs
//                        it to /var/www/gbk-composer/soundfonts/, nginx serves
//                        it at the catalog serverPath). Also found in the
//                        soundfonts/ fetch cache on a checkout that ran
//                        `fetch:soundfonts --server`.
//
// Both render executors consume this module (see browser-render.ts): the
// headless server pool resolves the selected font to a file it reads itself,
// and the Studio tab loads the same font from this origin. File presence on
// the server is the availability signal for both: a bundled font present in
// dist/static is servable at /static/<file>, and a server font present in the
// persistent dir is servable at its serverPath.
//
// Listing descriptions are read from the SF2 binaries themselves (readSf2Binary:
// the INFO chunk + preset directory) whenever a font is installed; catalog copy
// is only the fallback for fonts this deployment does not have.
import { existsSync, readFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.ts";
import { McpError } from "./errors.ts";

export interface SoundFontCatalogEntry {
  id: string; label: string; description: string; bytes: number; license: string;
  delivery: "bundled" | "server"; file: string; default?: boolean; serverPath?: string;
}

export interface SoundFontView {
  id: string; label: string; description: string; bytes: number; license: string;
  delivery: "bundled" | "server"; file: string;
  /** URL path a client of this deployment fetches the font from. */
  path: string;
  /** The catalog default (what renders use when no soundFont is requested). */
  default: boolean;
  /** True for the font a render with no soundFont parameter will use. */
  active: boolean;
  /** The font file is present in this deployment right now (the Studio tab can load it). */
  available: boolean;
  /** Descriptive metadata read from the SF2 binary itself (INFO chunk), when installed. */
  info?: Sf2BinaryInfo;
  /** Preset directory read from the binary's phdr chunk, when installed. */
  presets?: Sf2PresetLite[];
  presetCount?: number;
}

/** SF2 INFO chunk fields (the binary's own descriptive metadata). */
export interface Sf2BinaryInfo {
  name?: string; comment?: string; copyright?: string; engineer?: string;
  product?: string; software?: string; created?: string; soundEngine?: string; version?: string;
}
export interface Sf2PresetLite { bank: number; program: number; name: string }

const INFO_KEYS: Record<string, keyof Sf2BinaryInfo> = {
  INAM: "name", ICMT: "comment", ICOP: "copyright", IENG: "engineer",
  IPRD: "product", ISFT: "software", ICRD: "created", isng: "soundEngine",
};

/**
 * Read a SoundFont's own descriptive data — the INFO chunk (name, comment,
 * copyright, engineer, …) and the preset directory (phdr) — straight from the
 * binary, without parsing samples: the reader walks RIFF chunk headers and
 * seeks past the sample data. Returns null for non-SF2 or unreadable files.
 */
export function readSf2Binary(path: string): { info: Sf2BinaryInfo; presets: Sf2PresetLite[] } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const read = (off: number, len: number): Buffer => {
      const b = Buffer.alloc(len);
      return b.subarray(0, readSync(fd!, b, 0, len, off));
    };
    const head = read(0, 12);
    if (head.length < 12 || head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "sfbk") return null;
    const zstr = (b: Buffer) => b.toString("latin1").replace(/\0[\s\S]*$/, "").trim();
    const info: Sf2BinaryInfo = {};
    let presets: Sf2PresetLite[] = [];
    let haveInfo = false, havePresets = false;
    let pos = 12;
    while (pos + 8 <= size && !(haveInfo && havePresets)) {
      const h = read(pos, 8);
      if (h.length < 8) break;
      const len = h.readUInt32LE(4);
      const body = pos + 8;
      if (h.toString("latin1", 0, 4) === "LIST" && len >= 4) {
        const kind = read(body, 4).toString("latin1");
        let p = body + 4;
        const end = body + len;
        if (kind === "INFO") {
          haveInfo = true;
          while (p + 8 <= end) {
            const sh = read(p, 8); const slen = sh.readUInt32LE(4); const tag = sh.toString("latin1", 0, 4);
            const key = INFO_KEYS[tag];
            if (key) { const v = zstr(read(p + 8, slen)); if (v) info[key] = v; }
            if (tag === "ifil") { const vb = read(p + 8, 4); if (vb.length === 4) info.version = `${vb.readUInt16LE(0)}.${vb.readUInt16LE(2)}`; }
            p += 8 + slen + (slen % 2);
          }
        } else if (kind === "pdta") {
          while (p + 8 <= end && !havePresets) {
            const sh = read(p, 8); const slen = sh.readUInt32LE(4);
            if (sh.toString("latin1", 0, 4) === "phdr") {
              const raw = read(p + 8, slen);
              const all: Sf2PresetLite[] = [];
              for (let o = 0; o + 38 <= slen; o += 38) {
                all.push({ name: zstr(raw.subarray(o, o + 20)), program: raw.readUInt16LE(o + 20), bank: raw.readUInt16LE(o + 22) });
              }
              presets = all.slice(0, -1); // last phdr record is the terminal sentinel
              havePresets = true;
            }
            p += 8 + slen + (slen % 2);
          }
        }
      }
      pos = body + len + (len % 2);
    }
    return { info, presets };
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * The listing description, read from the binary when the font is installed:
 * the INFO comment (ICMT, whitespace-collapsed, capped) when the bank carries
 * one; otherwise a composite of the binary's name, its preset directory and
 * its credits. Only a font that is not installed falls back to catalog copy.
 */
function binaryDescription(bin: { info: Sf2BinaryInfo; presets: Sf2PresetLite[] }): string | undefined {
  const comment = bin.info.comment?.replace(/\s+/g, " ").trim();
  if (comment) return comment.length > 300 ? `${comment.slice(0, 297)}…` : comment;
  if (!bin.presets.length) return undefined;
  const shown = bin.presets.slice(0, 4).map((p) => `bank ${p.bank} program ${p.program} "${p.name}"`).join("; ");
  const credits = [bin.info.copyright ? `Copyright: ${bin.info.copyright}.` : "", bin.info.engineer ? `By ${bin.info.engineer}.` : ""].filter(Boolean).join(" ");
  const text = `${bin.info.name ?? "SoundFont"}: ${bin.presets.length} preset${bin.presets.length === 1 ? "" : "s"} (${shown}${bin.presets.length > 4 ? "; …" : ""}).${credits ? ` ${credits}` : ""}`;
  return text.length > 300 ? `${text.slice(0, 297)}…` : text;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
/** Persistent server-delivery font dir on the compose host (see deploy/deploy.sh). */
const SERVER_FONT_DIR = "/var/www/gbk-composer/soundfonts";

let catalogCache: SoundFontCatalogEntry[] | null = null;

export function catalogPath(): string | null {
  const candidates = [join(process.cwd(), "soundfonts", "catalog.json"), join(repoRoot, "soundfonts", "catalog.json")];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

interface ManifestEntry { id: string; label: string; file: string; bytes: number; description: string; license: string; default?: boolean; path: string }

function manifestPath(): string | null {
  const candidates = [
    join(process.cwd(), "dist", "static", "soundfont-manifest.json"), join(repoRoot, "dist", "static", "soundfont-manifest.json"),
    join(process.cwd(), "public", "static", "soundfont-manifest.json"), join(repoRoot, "public", "static", "soundfont-manifest.json"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** Catalog entries recovered from the generated manifest (production releases ship it, not the catalog). */
function loadFromManifest(path: string): SoundFontCatalogEntry[] {
  let entries: ManifestEntry[];
  try { entries = JSON.parse(readFileSync(path, "utf8")) as ManifestEntry[]; }
  catch (e) { throw new McpError("INTERNAL_ERROR", `SoundFont manifest ${path} is not valid JSON: ${(e as Error).message}`); }
  if (!Array.isArray(entries) || !entries.length) throw new McpError("INTERNAL_ERROR", `SoundFont manifest ${path} has no fonts`);
  return entries.map((e) => ({
    id: e.id, label: e.label, description: e.description, bytes: e.bytes, license: e.license, file: e.file,
    delivery: e.path.startsWith("/") ? "server" as const : "bundled" as const,
    ...(e.default ? { default: true } : {}),
    ...(e.path.startsWith("/") ? { serverPath: e.path } : {}),
  }));
}

/** Parse the pinned catalog (or its generated manifest form). Throws INTERNAL_ERROR when neither
 *  exists or either is corrupt — that is a broken install, not an empty list. */
export function loadCatalog(): SoundFontCatalogEntry[] {
  if (catalogCache) return catalogCache;
  const path = catalogPath();
  if (!path) {
    const mp = manifestPath();
    if (mp) { catalogCache = loadFromManifest(mp); return catalogCache; }
    throw new McpError("INTERNAL_ERROR", "SoundFont catalog (soundfonts/catalog.json) and generated manifest (dist/static/soundfont-manifest.json) both not found on this server");
  }
  let parsed: { fonts?: SoundFontCatalogEntry[] };
  try { parsed = JSON.parse(readFileSync(path, "utf8")) as { fonts?: SoundFontCatalogEntry[] }; }
  catch (e) { throw new McpError("INTERNAL_ERROR", `SoundFont catalog ${path} is not valid JSON: ${(e as Error).message}`); }
  if (!Array.isArray(parsed.fonts) || !parsed.fonts.length) throw new McpError("INTERNAL_ERROR", `SoundFont catalog ${path} has no fonts`);
  catalogCache = parsed.fonts;
  return catalogCache;
}

export function catalogFont(id: string): SoundFontCatalogEntry | undefined {
  return loadCatalog().find((f) => f.id === id);
}

export function defaultFontId(): string {
  const fonts = loadCatalog();
  return (fonts.find((f) => f.default) ?? fonts.find((f) => f.delivery === "bundled") ?? fonts[0]).id;
}

/** The URL path the Studio tab fetches this font from on this deployment. */
export function fontUrlPath(font: SoundFontCatalogEntry): string {
  return font.delivery === "server" ? (font.serverPath ?? `/soundfonts/${font.file}`) : `static/${font.file}`;
}

/** Candidate filesystem locations for a catalog font in this deployment, most specific first. */
export function fontFileCandidates(cfg: Config, font: SoundFontCatalogEntry): string[] {
  const out: string[] = [];
  // If the operator relocated the default font, sibling fonts in the same dir win.
  if (cfg.mcp.soundFontPath) out.push(join(dirname(cfg.mcp.soundFontPath), font.file));
  if (font.delivery === "server") out.push(join(SERVER_FONT_DIR, font.file));
  else {
    out.push(
      join(process.cwd(), "dist", "static", font.file),
      join(repoRoot, "dist", "static", font.file),
      join(process.cwd(), "public", "static", font.file),
      join(repoRoot, "public", "static", font.file),
    );
  }
  // The pinned fetch cache (dev checkouts; deploy.sh also fetches server fonts here before syncing).
  out.push(join(process.cwd(), "soundfonts", font.file), join(repoRoot, "soundfonts", font.file));
  // Vendored user-provided uploads are committed in-repo under soundfonts/vendor/.
  out.push(join(process.cwd(), "soundfonts", "vendor", font.file), join(repoRoot, "soundfonts", "vendor", font.file));
  return [...new Set(out)];
}

/** First existing file for a catalog font, or null when the font is not installed in this deployment. */
export function resolveFontFile(cfg: Config, font: SoundFontCatalogEntry): string | null {
  for (const c of fontFileCandidates(cfg, font)) if (existsSync(c)) return c;
  return null;
}

export function listSoundFonts(cfg: Config): SoundFontView[] {
  const activeId = defaultFontId();
  return loadCatalog().map((f) => {
    const file = resolveFontFile(cfg, f);
    // Descriptions come from the SF2 binary itself whenever it is installed
    // (INFO comment, else its name + preset directory + credits); the catalog
    // copy is only the fallback for fonts this deployment does not have.
    const bin = file ? readSf2Binary(file) : null;
    return {
      id: f.id, label: f.label, description: (bin ? binaryDescription(bin) : undefined) ?? f.description, bytes: f.bytes, license: f.license,
      delivery: f.delivery, file: f.file, path: fontUrlPath(f),
      default: !!f.default, active: f.id === activeId,
      available: file !== null,
      ...(bin ? { info: bin.info, presets: bin.presets, presetCount: bin.presets.length } : {}),
    };
  });
}

/** Validate a render's soundFont selection at submit time, before any job exists:
 *  unknown id -> INVALID_ARGUMENT; known but not installed in this deployment -> NOT_FOUND. */
export function resolveRenderFont(cfg: Config, id: string): SoundFontCatalogEntry {
  const font = catalogFont(id);
  if (!font) throw new McpError("INVALID_ARGUMENT", `unknown soundFont id ${JSON.stringify(id)}; call gbk_list_soundfonts for the catalog ids this server renders with`);
  if (!resolveFontFile(cfg, font)) throw new McpError("NOT_FOUND", `SoundFont ${JSON.stringify(font.id)} (${font.label}) is in the catalog but ${font.file} is not installed on this server`);
  return font;
}
