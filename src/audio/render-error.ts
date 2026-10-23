// Structured errors for the headless audio pipeline. Every failure rejects with one of these; nothing
// in src/audio reports success by returning undefined.
export type RenderErrorCode =
  | "SOUNDFONT_FETCH_FAILED" | "SOUNDFONT_INVALID" | "INSTRUMENT_NOT_FOUND" | "EMPTY_PROJECT" | "RENDER_TOO_LARGE"
  | "OPERATION_CANCELLED" | "NON_FINITE_SAMPLES" | "WAV_INVALID" | "UNEXPECTED_SILENCE" | "UNEXPECTED_CLIPPING"
  | "QUOTA_EXCEEDED" | "STORAGE_UNAVAILABLE" | "ARTIFACT_NOT_FOUND" | "DOWNLOAD_BLOCKED" | "INVALID_ARGUMENT" | "INTERNAL_ERROR";

export class RenderError extends Error {
  constructor(public code: RenderErrorCode, message: string, public details?: unknown) { super(message); this.name = "RenderError"; }
}

export function asRenderError(e: unknown, fallback: RenderErrorCode = "INTERNAL_ERROR"): RenderError {
  if (e instanceof RenderError) return e;
  const name = (e as { name?: string } | null)?.name;
  if (name === "AbortError") return new RenderError("OPERATION_CANCELLED", "cancelled");
  if (name === "QuotaExceededError") return new RenderError("QUOTA_EXCEEDED", (e as Error).message || "browser storage quota exceeded");
  return new RenderError(fallback, e instanceof Error ? e.message : String(e));
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RenderError("OPERATION_CANCELLED", "cancelled");
}

/** Yield to the event loop between render chunks (keeps the page responsive; not used to wait for state). */
export function yieldToEventLoop(): Promise<void> {
  const g = globalThis as { scheduler?: { yield?: () => Promise<void> }; setImmediate?: (f: () => void) => void };
  if (g.scheduler?.yield) return g.scheduler.yield();
  if (typeof MessageChannel !== "undefined" && typeof window !== "undefined") {
    return new Promise((res) => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); res(); }; ch.port2.postMessage(0); });
  }
  if (g.setImmediate) return new Promise((res) => g.setImmediate!(res));
  return new Promise((res) => setTimeout(res, 0));
}
