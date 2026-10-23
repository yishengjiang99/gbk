// Visible-window queries over tick-sorted arrays: O(log n + k) per frame instead of O(song length).
export function lowerBound<T extends { tick: number }>(arr: readonly T[], tick: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].tick < tick) lo = m + 1; else hi = m; }
  return lo;
}

export interface NoteIndex<N extends { tick: number; duration: number }> { sorted: N[]; maxDuration: number }
export function buildNoteIndex<N extends { tick: number; duration: number }>(notes: readonly N[]): NoteIndex<N> {
  const sorted = [...notes].sort((a, b) => a.tick - b.tick);
  let maxDuration = 0; for (const n of sorted) if (n.duration > maxDuration) maxDuration = n.duration;
  return { sorted, maxDuration };
}
/** Notes intersecting [start, end]. Notes starting up to maxDuration before `start` are checked for overlap. */
export function visibleNotes<N extends { tick: number; duration: number }>(ix: NoteIndex<N>, start: number, end: number): N[] {
  const out: N[] = [];
  for (let i = lowerBound(ix.sorted, start - ix.maxDuration); i < ix.sorted.length; i++) {
    const n = ix.sorted[i]; if (n.tick > end) break;
    if (n.tick + n.duration >= start) out.push(n);
  }
  return out;
}
/** Points in [start, end] plus one neighbour on each side so curves stay continuous at the edges. */
export function visiblePoints<P extends { tick: number }>(sorted: readonly P[], start: number, end: number): P[] {
  const a = Math.max(0, lowerBound(sorted, start) - 1);
  const b = Math.min(sorted.length, lowerBound(sorted, end) + 1);
  return sorted.slice(a, b);
}
