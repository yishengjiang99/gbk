// Downsampled note summary for landing-page piano-roll previews (server-built, small payload; never audio).
export interface PianoRollPreview { tracks: string[]; lo: number; hi: number; end: number; notes: [number, number, number, number][] }
type P = { tracks?: { id: string; color?: string; visible?: boolean }[]; notes?: { trackId: string; tick: number; duration: number; pitch: number }[] };
// The feed card's playing view is a 4 s window into the whole song, so the cap has to cover a typical
// song outright: at the old 240 cap a 1,991-note song showed ~9 of its ~77 notes per window.
export const PREVIEW_MAX_NOTES = 2048;
/** notes: [trackIndex, start 0..1000, length 0..1000, pitch].
 *  When over the cap, sample within each track separately: a proportional share of the cap, strided
 *  over that track's own timeline. A single global stride over tick-sorted notes aliases with
 *  simultaneous notes — when several tracks start a note on the same tick in a fixed order, the
 *  stride residue drifts slowly through the per-tick slots and whole pitch rows vanish from long
 *  sections (e.g. the drum rows were missing from the first 11 s of a 1,991-note song: 179 real
 *  notes, 0 drums in the preview). Per-track striding keeps every track present in every section. */
export function buildPreview(p: P, max = PREVIEW_MAX_NOTES): PianoRollPreview {
  const tracks = (p.tracks ?? []).slice(0, 64); const idx = new Map(tracks.map((t, i) => [t.id, i]));
  const all = (p.notes ?? []).filter((n) => idx.has(n.trackId)).sort((a, b) => a.tick - b.tick);
  let end = 1, lo = 127, hi = 0;
  for (const n of all) { end = Math.max(end, n.tick + n.duration); lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
  if (!all.length) { lo = 60; hi = 72; }
  let pick = all;
  if (all.length > max) {
    const byTrack = new Map<number, typeof all>();
    for (const n of all) { const k = idx.get(n.trackId)!; const g = byTrack.get(k); if (g) g.push(n); else byTrack.set(k, [n]); }
    pick = [];
    for (const notes of byTrack.values()) {
      const share = Math.max(1, Math.floor((notes.length / all.length) * max));
      pick.push(...(notes.length <= share ? notes : Array.from({ length: share }, (_, i) => notes[Math.floor((i * notes.length) / share)])));
    }
    if (pick.length > max) { // many tiny tracks each bumped to 1: pick is track-grouped here, so a stride over it thins each track proportionally
      const thinned = Array.from({ length: max }, (_, i) => pick[Math.floor((i * pick.length) / max)]);
      pick = thinned;
    }
    pick.sort((a, b) => a.tick - b.tick);
  }
  return { tracks: tracks.map((t) => (/^#[0-9a-fA-F]{3,8}$/.test(String(t.color)) ? String(t.color) : "#90a4ae")), lo, hi, end,
    notes: pick.map((n) => [idx.get(n.trackId)!, Math.round((n.tick / end) * 1000), Math.max(1, Math.round((n.duration / end) * 1000)), n.pitch]) };
}
