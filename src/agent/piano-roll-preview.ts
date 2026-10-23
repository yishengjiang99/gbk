// Downsampled note summary for landing-page piano-roll previews (server-built, small payload; never audio).
export interface PianoRollPreview { tracks: string[]; lo: number; hi: number; end: number; notes: [number, number, number, number][] }
type P = { tracks?: { id: string; color?: string; visible?: boolean }[]; notes?: { trackId: string; tick: number; duration: number; pitch: number }[] };
export const PREVIEW_MAX_NOTES = 240;
/** notes: [trackIndex, start 0..1000, length 0..1000, pitch]. Evenly samples across time when over the cap. */
export function buildPreview(p: P, max = PREVIEW_MAX_NOTES): PianoRollPreview {
  const tracks = (p.tracks ?? []).slice(0, 64); const idx = new Map(tracks.map((t, i) => [t.id, i]));
  const all = (p.notes ?? []).filter((n) => idx.has(n.trackId)).sort((a, b) => a.tick - b.tick);
  let end = 1, lo = 127, hi = 0;
  for (const n of all) { end = Math.max(end, n.tick + n.duration); lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
  if (!all.length) { lo = 60; hi = 72; }
  const pick = all.length <= max ? all : Array.from({ length: max }, (_, i) => all[Math.floor((i * all.length) / max)]);
  return { tracks: tracks.map((t) => (/^#[0-9a-fA-F]{3,8}$/.test(String(t.color)) ? String(t.color) : "#90a4ae")), lo, hi, end,
    notes: pick.map((n) => [idx.get(n.trackId)!, Math.round((n.tick / end) * 1000), Math.max(1, Math.round((n.duration / end) * 1000)), n.pitch]) };
}
