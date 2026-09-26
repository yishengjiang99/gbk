/**
 * Resolve the real visible viewport height in CSS px.
 *
 * iOS Safari's `100dvh` can get stuck at the value captured while the
 * toolbar was in a different state (e.g. expanded during page load), which
 * leaves a dead gap below the footer even though the toolbar is now
 * collapsed. `window.visualViewport.height` tracks the actually visible
 * area, so prefer it and fall back to `window.innerHeight`.
 *
 * Returns null when no usable measurement exists (the caller keeps the CSS
 * `100dvh` fallback).
 */
export function resolveViewportHeightPx(
  visualViewportHeight: number | null | undefined,
  innerHeight: number | null | undefined
): number | null {
  const vv = typeof visualViewportHeight === "number" ? Math.round(visualViewportHeight) : 0;
  if (vv > 0) return vv;
  const ih = typeof innerHeight === "number" ? Math.round(innerHeight) : 0;
  return ih > 0 ? ih : null;
}
