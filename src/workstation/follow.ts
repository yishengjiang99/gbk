/**
 * Page-style playhead follow. Returns the new scrollTick, or null when the cursor is comfortably in view.
 * When the cursor passes `edge` of the visible width (or is left of it), the view jumps so the cursor sits at `lead`.
 */
export function followScroll(posTick: number, scrollTick: number, visibleTicks: number, edge = 0.85, lead = 0.1): number | null {
  if (!(visibleTicks > 0)) return null;
  if (posTick >= scrollTick && posTick <= scrollTick + visibleTicks * edge) return null;
  return Math.max(0, posTick - visibleTicks * lead);
}
