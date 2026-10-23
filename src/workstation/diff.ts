import type { CCEvent, Note, Project } from "./model.ts";

export interface NoteDiff { added: Note[]; removed: Note[]; moved: { before: Note; after: Note }[] }
/** Diff notes between original and candidate (by stable id). Pure; memoize by proposal id. */
export function diffNotes(a: Project, b: Project): NoteDiff {
  const am = new Map(a.notes.map((n) => [n.id, n])), bm = new Map(b.notes.map((n) => [n.id, n]));
  const added: Note[] = [], removed: Note[] = [], moved: { before: Note; after: Note }[] = [];
  for (const n of b.notes) { const o = am.get(n.id); if (!o) added.push(n); else if (o.tick !== n.tick || o.pitch !== n.pitch || o.duration !== n.duration || o.velocity !== n.velocity) moved.push({ before: o, after: n }); }
  for (const n of a.notes) if (!bm.has(n.id)) removed.push(n);
  return { added, removed, moved };
}
export function ccLane(p: Project, trackId: string, controller: number): CCEvent[] {
  return p.ccs.filter((c) => c.trackId === trackId && c.controller === controller);
}
export function diffSummary(d: NoteDiff, ccChanged: number) {
  return `+${d.added.length} notes, −${d.removed.length}, ~${d.moved.length} changed${ccChanged ? `, ${ccChanged} CC points` : ""}`;
}
