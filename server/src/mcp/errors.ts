// Typed domain errors for the remote MCP surface. Codes are stable and machine-readable; MCP tool results
// carry { code, message } and HTTP routes reuse the same codes.
export type McpErrorCode =
  | "UNAUTHENTICATED" | "FORBIDDEN" | "INSUFFICIENT_SCOPE" | "NOT_FOUND" | "INVALID_ARGUMENT"
  | "STALE_REVISION" | "PROJECT_CHANGED" | "IDEMPOTENCY_CONFLICT" | "RATE_LIMITED" | "QUOTA_EXCEEDED"
  | "RENDER_FAILED" | "RENDER_TIMEOUT" | "WORKER_UNAVAILABLE" | "ARTIFACT_EXPIRED" | "USER_APPROVAL_REQUIRED"
  | "UNSUPPORTED" | "INTERNAL_ERROR";

export class McpError extends Error {
  constructor(public code: McpErrorCode, message: string, public details?: unknown) {
    super(message); this.name = "McpError";
  }
}

export const isMcpError = (e: unknown): e is McpError => e instanceof McpError;

/** Map canonical workstation/render errors onto MCP codes without leaking internals. */
export function toMcpError(e: unknown): McpError {
  if (e instanceof McpError) return e;
  const code = (e as { code?: unknown })?.code;
  const message = e instanceof Error ? e.message : String(e);
  if (typeof code === "string") {
    if (code === "STALE_REVISION") return new McpError("STALE_REVISION", message, (e as { details?: unknown }).details);
    if (code === "USER_APPROVAL_REQUIRED") return new McpError("USER_APPROVAL_REQUIRED", message);
    if (code === "INVALID_ARGUMENT" || code === "INVALID_RANGE" || code === "UNSUPPORTED_CC") return new McpError("INVALID_ARGUMENT", message);
    if (code === "UNSUPPORTED") return new McpError("UNSUPPORTED", message);
    if (code === "QUOTA_EXCEEDED") return new McpError("QUOTA_EXCEEDED", message);
    if (code === "ARTIFACT_NOT_FOUND") return new McpError("NOT_FOUND", message);
    // Render pipeline codes (SOUNDFONT_*, EMPTY_PROJECT, RENDER_TOO_LARGE, WAV_INVALID, ...) stay visible:
    // they are actionable for the calling model and contain no secrets.
    return new McpError("RENDER_FAILED", `${code}: ${message}`);
  }
  return new McpError("INTERNAL_ERROR", message);
}
