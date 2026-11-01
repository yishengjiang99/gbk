// Plain-language connection label from recent numbers. Missing numbers stay "unknown".
export type Quality = "unknown" | "good" | "ok" | "degraded" | "offline";
export function connectionLabel(q: Quality, relay: boolean | null): string {
  const base = { unknown: "Measuring…", good: "Tight", ok: "Playable", degraded: "Laggy", offline: "Not connected" }[q];
  return relay ? `${base} (relayed)` : base;
}
export const fmtMs = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "unknown" : `${Math.round(v * 10) / 10} ms`);
