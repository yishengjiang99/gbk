// Standalone SoundFont loader for headless rendering. Independent of React, the mounted player and any
// AudioContext: fetch (Vite base aware) -> parse/validate -> cache -> resolve bank/program with explicit
// substitution warnings.
import { SF2SoundFont, type SF2Region } from "../sf2/soundfont.ts";
import { RenderError, throwIfAborted } from "./render-error.ts";

export const DEFAULT_SOUNDFONT_FILE = "static/GeneralUser-GS.sf2";

/** Deployment base ("/gbk/" on GitHub Pages, "/" elsewhere). */
export function deploymentBase(): string {
  let base = "/";
  try { base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"; } catch { /* non-Vite runtime */ }
  return base.endsWith("/") ? base : `${base}/`;
}
export function defaultSoundFontUrl(): string { return `${deploymentBase()}${DEFAULT_SOUNDFONT_FILE}`; }

export interface LoadedSoundFont { sf: SF2SoundFont; url: string; label: string; bytes: number; presetCount: number }
export interface LoadOptions {
  url?: string; signal?: AbortSignal; onProgress?: (loaded: number, total: number | null) => void;
  fetchImpl?: typeof fetch; timeoutMs?: number;
}

const cache = new Map<string, Promise<LoadedSoundFont>>();
let active: LoadedSoundFont | null = null;
let lastLoaded: LoadedSoundFont | null = null;
/** Synchronously available font (user-selected, else the last successfully loaded one), or null. */
export function peekSoundFont(): LoadedSoundFont | null { return active ?? lastLoaded; }

/** Parse + validate SF2 bytes. Throws SOUNDFONT_INVALID. */
export function parseSoundFont(bytes: Uint8Array, url = "memory", label = url): LoadedSoundFont {
  let sf: SF2SoundFont;
  try { sf = new SF2SoundFont(bytes); } catch (e) { throw new RenderError("SOUNDFONT_INVALID", `not a valid SoundFont (${url}): ${(e as Error).message}`); }
  const presetCount = sf.presets.length;
  if (!presetCount || !sf.samples?.length) throw new RenderError("SOUNDFONT_INVALID", `SoundFont ${url} has no presets or samples`);
  return { sf, url, label, bytes: bytes.length, presetCount };
}

async function fetchSoundFont(url: string, o: LoadOptions): Promise<LoadedSoundFont> {
  const f = o.fetchImpl ?? globalThis.fetch;
  if (!f) throw new RenderError("SOUNDFONT_FETCH_FAILED", "fetch is not available in this runtime");
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 120_000);
  try {
    let res: Response;
    try { res = await f(url, { signal: ctl.signal }); } catch (e) {
      throwIfAborted(o.signal);
      throw new RenderError("SOUNDFONT_FETCH_FAILED", `could not fetch SoundFont ${url}: ${(e as Error).message}`);
    }
    if (!res.ok) throw new RenderError("SOUNDFONT_FETCH_FAILED", `SoundFont ${url}: HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || null;
    let bytes: Uint8Array;
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader(); const parts: Uint8Array[] = []; let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read().catch((e) => { throwIfAborted(o.signal); throw new RenderError("SOUNDFONT_FETCH_FAILED", `SoundFont download failed: ${(e as Error).message}`); });
        if (done) break;
        parts.push(value); loaded += value.length; o.onProgress?.(loaded, total);
      }
      bytes = new Uint8Array(loaded); let off = 0; for (const p of parts) { bytes.set(p, off); off += p.length; }
    } else { bytes = new Uint8Array(await res.arrayBuffer()); o.onProgress?.(bytes.length, bytes.length); }
    throwIfAborted(o.signal);
    return parseSoundFont(bytes, url, url.split("/").pop() ?? url);
  } finally { clearTimeout(timer); o.signal?.removeEventListener("abort", onAbort); }
}

/** Load (cached) the SoundFont for offline rendering: the user-selected one if registered, else the bundled GeneralUser GS. */
export async function loadSoundFont(o: LoadOptions = {}): Promise<LoadedSoundFont> {
  if (!o.url && active) return active;
  const url = o.url ?? defaultSoundFontUrl();
  let p = cache.get(url);
  if (!p) {
    p = fetchSoundFont(url, o);
    cache.set(url, p);
    p.then((x) => { lastLoaded = x; }, () => undefined);
    p.catch(() => { if (cache.get(url) === p) cache.delete(url); }); // failures (and cancellations) are retryable
  }
  // A cancelled caller stops waiting even if the shared download continues for other callers.
  if (o.signal) {
    const sig = o.signal;
    return await Promise.race([p, new Promise<never>((_, rej) => { if (sig.aborted) rej(new RenderError("OPERATION_CANCELLED", "cancelled")); sig.addEventListener("abort", () => rej(new RenderError("OPERATION_CANCELLED", "cancelled")), { once: true }); })]);
  }
  return p;
}

/** The app registers the SoundFont the user loaded/uploaded so offline renders use the same instruments. */
export function setActiveSoundFont(sf: SF2SoundFont | null, label = "user SoundFont", url = "memory:user") {
  active = sf ? { sf, url, label, bytes: 0, presetCount: sf.presets.length } : null;
}
export function getActiveSoundFont(): LoadedSoundFont | null { return active; }
/** Seed the URL cache with an already-parsed font (avoids a second 31 MB download in the app). */
export function primeSoundFontCache(url: string, sf: SF2SoundFont, label = url) {
  const x = { sf, url, label, bytes: 0, presetCount: sf.presets.length };
  cache.set(url, Promise.resolve(x)); lastLoaded = x;
}
export function clearSoundFontCache() { cache.clear(); active = null; lastLoaded = null; }

export interface ResolvedInstrument {
  requested: { bank: number; program: number; channel: number };
  presetIndex: number; presetName: string; bank: number; program: number;
  regions: SF2Region[]; substituted: boolean; warning?: string;
}

/** Bank/program -> preset regions. Channel 10 (index 9) uses the GM percussion bank 128. Substitutions are reported. */
export function resolveInstrument(sf: SF2SoundFont, program: number, bankMsb: number, channel: number, bankLsb = 0): ResolvedInstrument {
  const bank = channel === 9 ? 128 : bankMsb;
  const requested = { bank, program, channel };
  let idx = sf.resolvePresetIndex(program, bank);
  if (idx === null && channel === 9) idx = sf.resolvePresetIndex(0, 128);
  if (idx === null) throw new RenderError("INSTRUMENT_NOT_FOUND", `no preset for bank ${bank} program ${program} (and no bank-0 fallback) in this SoundFont`, requested);
  const h = sf.presets[idx];
  const substituted = h.bank !== bank || h.preset !== program;
  return {
    requested, presetIndex: idx, presetName: h.presetName, bank: h.bank, program: h.preset, regions: sf.regionList(idx), substituted,
    ...(substituted ? { warning: `bank ${bank}${bankLsb ? `/${bankLsb}` : ""} program ${program} (ch${channel + 1}) not in SoundFont; using "${h.presetName}" (bank ${h.bank} program ${h.preset})` } : {}),
  };
}

export function listPresets(sf: SF2SoundFont) {
  return sf.presets.map((h, index) => ({ index, bank: h.bank, program: h.preset, name: h.presetName }));
}
