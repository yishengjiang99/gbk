// Download SoundFont bytes with progress (uncompressed bytes / known size) and a Cache Storage layer for immutable
// (content-hashed) URLs. Shared by the studio player and the headless renderer.
import { isImmutableSoundFontUrl, knownSoundFontBytes } from "./soundfont-assets.ts";

const CACHE = "gbk-soundfonts-v1";
export interface FetchBytesOptions {
  signal?: AbortSignal; onProgress?: (loaded: number, total: number | null) => void; fetchImpl?: typeof fetch;
  /** Total tries for transient failures (network error, 408/425/429/5xx, a body cut off mid-stream). Default 3. */
  attempts?: number; /** Backoff before retry n (1-based); default 500 ms, 1.5 s, 4.5 s... Tests pass 0. */ backoffMs?: (n: number) => number;
}
/** Statuses worth retrying; any other HTTP error (404, 403...) fails at once. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const isAbort = (e: unknown, signal?: AbortSignal) => !!signal?.aborted || (e as { name?: string })?.name === "AbortError";
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((ok, fail) => {
  if (ms <= 0) return ok();
  const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); ok(); }, ms);
  const onAbort = () => { clearTimeout(t); fail(Object.assign(new Error("aborted"), { name: "AbortError" })); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

async function cacheOpen(): Promise<Cache | null> {
  try { return typeof caches !== "undefined" ? await caches.open(CACHE) : null; } catch { return null; }
}

/** fetchSoundFontBytes with retry + exponential backoff: the 31 MB GeneralUser-GS download was the most common
 *  render failure (telemetry audit, 29 SOUNDFONT fetch failures). Aborts and non-transient HTTP errors are not retried. */
export async function fetchSoundFontBytes(url: string, o: FetchBytesOptions = {}): Promise<Uint8Array> {
  const attempts = Math.max(1, Math.floor(o.attempts ?? 3)); const backoff = o.backoffMs ?? ((n: number) => 500 * 3 ** (n - 1));
  for (let n = 1; ; n++) {
    try { return await fetchOnce(url, o); }
    catch (e) {
      const st = (e as { status?: number }).status;
      if (n >= attempts || isAbort(e, o.signal) || (st !== undefined && !RETRYABLE_STATUS.has(st))) throw e;
      await sleep(backoff(n), o.signal);
    }
  }
}

async function fetchOnce(url: string, o: FetchBytesOptions): Promise<Uint8Array> {
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
  // A connection dropped mid-download can end the stream "cleanly" with fewer bytes: retry instead of parsing a stub.
  if (!fromCache && known != null && bytes.length < known) throw new Error(`SoundFont download truncated (${bytes.length} of ${known} bytes)`);
  if (cache && !fromCache && (known == null || bytes.length === known)) {
    void cache.put(url, new Response(bytes as unknown as BodyInit, { headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) } })).catch(() => undefined);
  }
  return bytes;
}
