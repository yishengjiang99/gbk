// Desktop piano roll: wheel zoom anchored at the cursor + edge-hover auto-pan (pure view math, unit-tested).
export interface RollView { scrollTick: number; pxPerTick: number; lowPitch: number; highPitch: number }
export const MIN_PPT = 0.005, MAX_PPT = 2, MIN_ROWS = 8, MAX_ROWS = 128;
export const EDGE_PX = 40;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Scale factor for a wheel delta (pinch deltas are small, so they scale continuously). */
export const wheelFactor = (deltaY: number, deltaMode = 0) => Math.exp(-clamp(deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1), -300, 300) * 0.0025);

/** Time zoom by `f`, keeping the tick under `ax` (px from the grid's left edge) fixed. */
export function zoomTimeAt(v: RollView, f: number, ax: number, maxScroll = Infinity): RollView {
  const at = v.scrollTick + ax / v.pxPerTick; const ppt = clamp(v.pxPerTick * f, MIN_PPT, MAX_PPT);
  return { ...v, pxPerTick: ppt, scrollTick: clamp(at - ax / ppt, 0, Math.max(0, maxScroll)) };
}
/** Pitch zoom by `f` (>1 = zoom in, fewer rows), keeping the pitch at `frac` (0 top .. 1 bottom) fixed. */
export function zoomPitchAt(v: RollView, f: number, frac: number): RollView {
  const span = v.highPitch - v.lowPitch + 1; const next = clamp(Math.round(span / f), MIN_ROWS, MAX_ROWS);
  if (next === span) return v;
  const at = v.highPitch + 1 - frac * span; let hi = Math.round(at + frac * next) - 1; hi = clamp(hi, next - 1, 127);
  return { ...v, highPitch: hi, lowPitch: hi - next + 1 };
}
/** Edge-pan direction/speed (-1..1 per axis) for a pointer at (px,py) inside a w×h grid. */
export function edgeVector(px: number, py: number, w: number, h: number, edge = EDGE_PX): { dx: number; dy: number } {
  const s = (d: number) => (d < edge ? (edge - Math.max(0, d)) / edge : 0);
  if (px < 0 || py < 0 || px > w || py > h) return { dx: 0, dy: 0 };
  return { dx: s(w - px) - s(px), dy: s(h - py) - s(py) };
}
/** One pan step: dx>0 = later in time, dy>0 = lower pitches. `rowsPerSec`/`pxPerSec` at full speed. */
export function panStep(v: RollView, dx: number, dy: number, dtMs: number, maxScroll: number, acc: { rows: number }, pxPerSec = 900, rowsPerSec = 24): RollView {
  let out = v;
  if (dx) out = { ...out, scrollTick: clamp(out.scrollTick + (dx * pxPerSec * dtMs) / 1000 / out.pxPerTick, 0, Math.max(0, maxScroll)) };
  if (dy) {
    acc.rows += (dy * rowsPerSec * dtMs) / 1000; const n = Math.trunc(acc.rows);
    if (n) { acc.rows -= n; const span = out.highPitch - out.lowPitch; const lo = clamp(out.lowPitch - n, 0, 127 - span); out = { ...out, lowPitch: lo, highPitch: lo + span }; }
  }
  return out;
}
