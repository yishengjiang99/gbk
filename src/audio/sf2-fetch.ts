// Download SoundFont bytes with progress (uncompressed bytes / known size) and a Cache Storage layer for immutable
// (content-hashed) URLs. Shared by the studio player and the headless renderer.
import { isImmutableSoundFontUrl, knownSoundFontBytes } from "./soundfont-assets.ts";

const CACHE = "gbk-soundfonts-v1";
export interface FetchBytesOptions { signal?: AbortSignal; onProgress?: (loaded: number, total: number | null) => void; fetchImpl?: typeof fetch }

async function cacheOpen(): Promise<Cache | null> {
  try { return typeof caches !== "undefined" ? await caches.open(CACHE) : null; } catch { return null; }
}

export async function fetchSoundFontBytes(url: string, o: FetchBytesOptions = {}): Promise<Uint8Array> {
  const immutable = isImmutableSoundFontUrl(new URL(url, typeof location !== "undefined" ? location.href : "http://x/").pathname);
  const cache = immutable ? await cacheOpen() : null;
  const known = knownSoundFontBytes(url.split("?")[0]);
  let res: Response | undefined = cache ? await cache.match(url).catch(() => undefined) : undefined;
  const fromCache = !!res;
  if (!res) {
    res = await (o.fetchImpl ?? globalThis.fetch)(url, { signal: o.signal });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  }
  // content-length is the *compressed* size under Content-Encoding; the catalog knows the real size.
  const total = known ?? (Number(res.headers.get("content-length")) || null);
  let bytes: Uint8Array;
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader(); const parts: Uint8Array[] = []; let loaded = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); loaded += value.length; o.onProgress?.(loaded, total); }
    bytes = new Uint8Array(loaded); let off = 0; for (const p of parts) { bytes.set(p, off); off += p.length; }
  } else bytes = new Uint8Array(await res.arrayBuffer());
  if (cache && !fromCache && (known == null || bytes.length === known)) {
    void cache.put(url, new Response(bytes as unknown as BodyInit, { headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) } })).catch(() => undefined);
  }
  return bytes;
}
