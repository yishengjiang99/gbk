// Pure helpers for the chat-first phone studio (MobileStudio): version cards, plain-language steps and errors.
import { cloneProject, computeEndTick, type Project } from "../../workstation/model.ts";
import { tickToSec } from "../../workstation/timing.ts";

export interface SongVersion { n: number; runId: string; revision: number; snapshot: Project; at: number }

/** One list of versions per project: every composer reply that changed the song adds v1, v2, ... */
export class VersionLog {
  private byProject = new Map<string, SongVersion[]>();
  private subs = new Set<() => void>();
  list(projectId: string): SongVersion[] { return this.byProject.get(projectId) ?? []; }
  /** Record the song as it is after a reply. No-op (returns the existing one) when the song did not change. */
  record(runId: string, project: Project, at = Date.now()): SongVersion | null {
    const xs = this.list(project.id);
    const existing = xs.find((v) => v.runId === runId); if (existing) return existing;
    if (!project.tracks.length) return null;
    const last = xs[xs.length - 1];
    if (last && last.revision === project.revision) return null;
    const v: SongVersion = { n: xs.length + 1, runId, revision: project.revision, snapshot: cloneProject(project), at };
    this.byProject.set(project.id, [...xs, v]); for (const f of this.subs) f();
    return v;
  }
  forRun(projectId: string, runId: string | undefined) { return runId ? this.list(projectId).find((v) => v.runId === runId) ?? null : null; }
  subscribe(f: () => void) { this.subs.add(f); return () => { this.subs.delete(f); }; }
}
export const versionLog = new VersionLog();

export const fmtTime = (sec: number) => { const s = Math.max(0, Math.floor(sec)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
export const songSeconds = (p: Project) => tickToSec(p, Math.max(p.endTick, computeEndTick(p)));

/** Server/tool errors arrive as "CODE: detail". Users get one plain sentence, never codes or IDs. */
export function friendlyError(raw: string): string {
  const limit = /You've hit today's AI limit\.[^\n]*/.exec(raw)?.[0];
  if (limit) return limit; // server-written plain message (reset time + Pro pointer), shown verbatim
  const code = /^([A-Z][A-Z0-9_]{2,}):/.exec(raw.trim())?.[1] ?? "";
  if (/reloaded or closed, so the run stopped/.test(raw)) return "This page reloaded or closed, so the run stopped. Finished changes are saved; send your message again.";
  if (/BUDGET/.test(code)) return "You've hit today's AI limit. It resets at 5 PM PT.";
  if (/QUOTA|LIMIT/.test(code)) return "You've reached today's composing limit. Try again tomorrow.";
  if (/RATE_LIMIT/.test(code)) return "Lots of requests right now. Wait a moment and try again.";
  if (/CANCELLED/.test(code)) return "Stopped.";
  if (/DISCONNECT|TIMEOUT|UNREACHABLE|OFFLINE/.test(code) || /network|disconnect/i.test(raw)) return "Lost the connection to the composer. Check your internet and try again.";
  if (/READ_ONLY/.test(code)) return "This shared song is read-only. Make your own copy to change it.";
  if (/UNAUTHORI[ZS]ED|AUTH/.test(code)) return "Please sign in again to keep composing.";
  return "Something went wrong while composing. Please try again.";
}

/** A tool step in plain words ("Writing the notes"), never a tool name or internal detail. */
export function plainStep(task: string): string {
  const t = task.replace(/^gbk[_ ]/i, "").replace(/_/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "Working";
}

/** Short instrument chips for a song card: one per track, de-duplicated. */
export function trackChips(p: Project, max = 6): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const t of p.tracks) { const n = t.name.trim() || "Track"; if (!seen.has(n)) { seen.add(n); out.push(n); } }
  return out.length > max ? [...out.slice(0, max), `+${out.length - max}`] : out;
}
