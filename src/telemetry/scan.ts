// Scan-pipeline telemetry for the sheet-music scanner (sheet-cam + the
// omr-homr-web worker). Events ride the existing client-error reporter
// pathway (reportError, kind "report", POST /api/client-errors) — the same
// channel every other subsystem uses for structured debug context — because
// the funnel beacon only accepts aggregate event names and /api/events is
// the feed-impression contract; neither can carry per-stage payloads.
//
// Metadata and timings ONLY: no image data, no file names, no user content.
// The context record is scrubbed and size-capped by the reporter.
import { reportError } from "./error-reporter.ts";

/** Mirror of omr-homr-web's ScanDiagnostics (worker protocol, additive). */
export interface ScanDiagnostics {
  totalMs: number;
  preprocessMs: number;
  segnetMs: number;
  detectMs: number;
  encodeMs: number;
  decodeMs: number;
  staffCount: number;
  systemCount: number;
  voiceCount: number;
  notes: number;
  perStaffTokens: number[];
  perStaffMs: number[];
  backends: { segnet: string | null; encoder: string | null; decoder: string | null };
  layoutSource: string;
  warningCount: number;
}

export type ScanSource = "camera" | "file";

const ms = (n: number): number => Math.round(n);

export function scanStarted(source: ScanSource, width: number, height: number): void {
  reportError(new Error("scan_started"), { where: "scan", event: "scan_started", source, width, height });
}

export function scanCompleted(source: ScanSource, d: ScanDiagnostics): void {
  reportError(new Error("scan_completed"), {
    where: "scan",
    event: "scan_completed",
    source,
    totalMs: ms(d.totalMs),
    preprocessMs: ms(d.preprocessMs),
    segnetMs: ms(d.segnetMs),
    detectMs: ms(d.detectMs),
    encodeMs: ms(d.encodeMs),
    decodeMs: ms(d.decodeMs),
    staffCount: d.staffCount,
    systemCount: d.systemCount,
    voiceCount: d.voiceCount,
    notes: d.notes,
    // Compact joins keep the context under the reporter's JSON cap even for
    // many-staff pages.
    perStaffTokens: d.perStaffTokens.join(","),
    perStaffMs: d.perStaffMs.map(ms).join(","),
    backendSegnet: d.backends.segnet ?? "unknown",
    backendEncoder: d.backends.encoder ?? "unknown",
    backendDecoder: d.backends.decoder ?? "unknown",
    layoutSource: d.layoutSource,
    warningCount: d.warningCount,
  });
}

/**
 * The scan silently degraded to the built-in OCR reader. `reason` is the
 * reason code: "models_unavailable" (probe failed) or "omr_error" (the
 * worker failed mid-scan; detail carries the error message).
 */
export function scanFallback(source: ScanSource, reason: "models_unavailable" | "omr_error", detail?: string): void {
  reportError(new Error("scan_fallback"), {
    where: "scan",
    event: "scan_fallback",
    source,
    reason,
    ...(detail ? { detail: detail.slice(0, 300) } : {}),
  });
}

export function scanFailed(source: ScanSource, stage: string, message: string): void {
  reportError(new Error("scan_failed"), {
    where: "scan",
    event: "scan_failed",
    source,
    reason: stage,
    detail: message.slice(0, 300),
  });
}
