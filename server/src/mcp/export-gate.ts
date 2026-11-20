// ChatGPT / MCP export gate: MIDI, WAV and video downloads are Pro. Playing and listening stay free.
// Tool results for a free user carry the same 402 body (no signed download URL) so the model can point
// at pricing_url instead of handing over a file link. Inline artifact fetches (no ?download=1) stay open
// for the in-chat player; GET ?download=1 already answers this 402 in routes.ts.
import type { Config } from "../config.ts";
import { paywallBody, type PaywallBody } from "../routes/paywall.ts";
import type { ArtifactRow } from "./store.ts";
import { signArtifactUrl } from "./urls.ts";

export type ExportPaywall = PaywallBody;

export function ownerSignedIn(owner: string): boolean {
  return !owner.startsWith("guest:");
}

export function exportPaywall(origin: string, signedIn: boolean): ExportPaywall {
  return paywallBody(origin, "export", signedIn);
}

/** Short model-facing line: the 402 message plus the pricing URL, used when a tool would have returned a download link. */
export function exportUpgradeMessage(origin: string, signedIn: boolean): string {
  const p = exportPaywall(origin, signedIn);
  return `${p.message} ${p.paywall.pricing_url}`;
}

export type PresentedArtifact = { artifactId: string; kind: ArtifactRow["kind"]; filename: string; mimeType: string; sizeBytes: number; sha256: string; revision: number; meta: Record<string, unknown>; downloadUrl?: string; downloadUrlExpiresAt?: string | number; playUrl?: string };

/** Artifact metadata shown to plugin callers: only the file facts a caller needs (validation state,
 *  format, audio basics, and where the render ran). The stored meta_json also carries renderer
 *  internals (renderer version, render timings, loudness measurements, warnings) — debug data that
 *  stays on the server (OpenAI review, 2026-11-19). */
const PRESENTED_META_KEYS = ["validated", "format", "sampleRate", "channels", "durationSeconds", "preserves", "executor", "soundFont"] as const;
function presentedMeta(a: ArtifactRow): Record<string, unknown> {
  const meta = JSON.parse(a.meta_json) as Record<string, unknown>;
  return Object.fromEntries(PRESENTED_META_KEYS.filter((k) => meta[k] !== undefined).map((k) => [k, meta[k]]));
}

export function presentArtifact(cfg: Config, a: ArtifactRow, opts: { pro: boolean; play?: boolean }): PresentedArtifact {
  const meta = presentedMeta(a);
  const base = { artifactId: a.id, kind: a.kind, filename: a.filename, mimeType: a.mime_type, sizeBytes: a.size_bytes, sha256: a.sha256,
    revision: a.revision, meta };
  if (opts.pro) {
    const signed = signArtifactUrl(cfg, a.id);
    return { ...base, downloadUrl: signed.url, downloadUrlExpiresAt: signed.expiresAt };
  }
  if (opts.play && a.kind === "wav") {
    const signed = signArtifactUrl(cfg, a.id);
    return { ...base, playUrl: signed.url };
  }
  return base;
}

/** Attach the 402-shaped `export` object (and canExport) so MCP tool results don't leak a download link to free users. */
export function withExportGate<T extends Record<string, unknown>>(origin: string, owner: string, pro: boolean, data: T): T & { canExport: boolean; export?: ExportPaywall } {
  if (pro) return { ...data, canExport: true };
  return { ...data, canExport: false, export: exportPaywall(origin, ownerSignedIn(owner)) };
}
