// Pure helpers for the chat-first phone studio (MobileStudio): version cards, plain-language steps and errors.
import { cloneProject, computeEndTick, type Project } from "../../workstation/model.ts";
import { tickToSec } from "../../workstation/timing.ts";

export interface SongVersion { n: number; runId: string; revision: number; snapshot: Project; at: number; label?: string }

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
  /** Pin the just-loaded remix fork as the "Original" version (#162 step 7): the A/B anchor the session
   * starts from - playable and restorable like any version, before any agent reply exists. Recorded once. */
  recordOriginal(project: Project, at = Date.now()): SongVersion | null {
    const xs = this.list(project.id);
    const existing = xs.find((v) => v.runId === "remix-original"); if (existing) return existing;
    if (!project.tracks.length) return null;
    const v: SongVersion = { n: xs.length + 1, runId: "remix-original", label: "Original", revision: project.revision, snapshot: cloneProject(project), at };
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

/** Composer textarea auto-grow cap: the input stretches with multi-line text (typed or prefilled)
 * up to this height, then scrolls internally. ~9 lines at phone sizes, ~45% of a short viewport. */
export const COMPOSER_MAX_HEIGHT_PX = 200;
/** Phone composer cap: about 6 lines (16px/1.35 text + 22px padding), never more than 40% of the viewport. */
export const phoneComposerMaxPx = (viewportH: number) => Math.round(Math.min(6 * 16 * 1.35 + 24, viewportH * 0.4));

/** Resize a composer textarea to fit its content: reset to auto, then pin to the content height
 * (capped). Driven from an effect on the text state so programmatic setText (draft prefill, the
 * remix landing) grows it too, not just keystrokes. Enter/send behaviour is untouched. */
export function autoGrowTextarea(el: { scrollHeight: number; style: { height: string; overflowY: string } } | null, maxPx = COMPOSER_MAX_HEIGHT_PX): void {
  if (!el) return;
  el.style.height = "auto";
  const h = el.scrollHeight;
  el.style.height = `${Math.min(h, maxPx)}px`;
  el.style.overflowY = h > maxPx ? "auto" : "hidden";
}

/** Short instrument chips for a song card: one per track, de-duplicated. */
export function trackChips(p: Project, max = 6): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const t of p.tracks) { const n = t.name.trim() || "Track"; if (!seen.has(n)) { seen.add(n); out.push(n); } }
  return out.length > max ? [...out.slice(0, max), `+${out.length - max}`] : out;
}

// ---- song card in chat ------------------------------------------------------------------------------------------
// When a composition/render finishes, the chat shows the song as a card (Play / Open editor / Publish) instead of
// assistant text with a raw artifact id. Off switch: STUDIO_SONG_CARD=0 on the server (sent in /api/session).

/** The parts of a chat item the card mapping reads (a ChatItem from useAgentSession fits). */
export interface SongCardItem { id: string; role: "user" | "assistant" | "error"; text: string; runId?: string; artifacts?: { artifactId: string; kind: "wav" | "midi" }[] }
export type SongCard = { kind: "version"; version: SongVersion } | { kind: "current" };

const ARTIFACT_ID = /\b(?:wav|midi|mid|art)_[a-z0-9]{6,}\b/gi;

/** Assistant text without raw artifact ids (and the byte/hash noise around them). Never returns an id. */
export function stripArtifactIds(text: string, ids: string[] = []): string {
  let t = text;
  // "Rendered WAV artifact **wav_…**": the whole phrase goes at the end of a sentence; mid-sentence it reads "the WAV".
  const idAlt = [...ids.filter(Boolean).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), ARTIFACT_ID.source.replace(/\\b/g, "")].join("|");
  const core = `(?:\\b(?:the|a|an)\\s+)?(?:\\b(?:WAV|MIDI)\\s+)?\\bartifacts?(?:\\s+id)?\\s*:?\\s*[*_\`]*(?:${idAlt})[*_\`]*`;
  t = t.replace(new RegExp(`(?:\\b(?:rendered|saved|created)\\s+)?${core}(?=\\s*(?:[.!?,;:()]|$))`, "gi"), "")
    .replace(new RegExp(core, "gi"), (_m, at: number, all: string) => (/(?:^|[.!?]\s*)$/.test(all.slice(0, at)) ? "The WAV" : "the WAV"));
  for (const id of ids) if (id) t = t.split(id).join("");
  t = t.replace(ARTIFACT_ID, "")
    .replace(/\bsha-?256\s*[:=]?\s*[0-9a-f]{6,}…?/gi, "")
    .replace(/\b\d[\d,]*\s*bytes\b/gi, "")
    .replace(/\*\*\s*\*\*|__\s*__|`\s*`/g, "")
    .replace(/\b(WAV|MIDI)\s+artifacts?(?:\s+id)?(?:\s*:)?/gi, "$1")
    .replace(/\bartifacts?\s+id(?:\s*:)?/gi, "")
    .replace(/\(\s*(?:[,;]\s*)+/g, "(").replace(/(?:\s*[,;])+\s*\)/g, ")").replace(/\(\s*\)/g, "")
    .replace(/([.!?])\s*\(\s*[\d.]+\s*s\s*\)\s*[.!]?/g, "$1")
    .replace(/[ \t]+([,.;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "").trim();
  return /^(?:(?:rendered|the|your)\s+)?(?:WAV|MIDI)[.!:]?$/i.test(t) ? "" : t;
}

/** Id of the newest assistant item that produced a render artifact: the only one that may show a "current" card. */
export function latestArtifactItemId(items: SongCardItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) { const m = items[i]; if (m.role === "assistant" && m.artifacts?.some((a) => a.kind === "wav" || a.kind === "midi")) return m.id; }
  return null;
}

/** Map one chat item (a finished tool result) to what the chat shows: the text line and, maybe, a song card.
 * - a run that made a version shows that version's card;
 * - otherwise the newest item with a render artifact shows the current song's card (when a song exists);
 * - disabled (STUDIO_SONG_CARD=0): the old behaviour, version cards only and the text untouched. */
export function songCardFor(m: SongCardItem, o: { version: SongVersion | null; hasSong: boolean; latestArtifactId: string | null; enabled: boolean }): { card: SongCard | null; text: string } {
  if (m.role !== "assistant") return { card: null, text: m.text };
  if (!o.enabled) return { card: o.version ? { kind: "version", version: o.version } : null, text: m.text };
  const card: SongCard | null = o.version ? { kind: "version", version: o.version } : o.hasSong && o.latestArtifactId === m.id ? { kind: "current" } : null;
  const text = stripArtifactIds(m.text, (m.artifacts ?? []).map((a) => a.artifactId));
  return { card, text: text || (card ? "Your song is ready." : "") };
}

/** Where a successful Publish lands: the For You feed with that song pinned first (one-shot, URL only). */
export const publishedFeedPath = (slug: string) => `feed?pin=${encodeURIComponent(slug)}`;
