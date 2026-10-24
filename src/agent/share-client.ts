import { playerBridge } from "../workstation/player-bridge.ts";
// Browser client for shared songs. Uploading happens ONLY from an explicit Share click (that click is the consent).
import { apiBase } from "./bridge-client.ts";
import { workstation } from "../workstation/instance.ts";
import { artifactStore } from "../audio/artifact-store.ts";
import { sanitizeSharedProject } from "./share-schema.ts";
import type { Project } from "../workstation/model.ts";

export interface ShareInfo { slug: string; title: string; owner: string; createdAt: string; public: boolean; parent: { slug: string; title: string; owner: string } | null; hasMidi: boolean; hasWav: boolean; hasMp3?: boolean; wav: { durationSeconds?: number; bytes?: number } | null; forks: number; url?: string; mine?: boolean }
const csrf = () => document.cookie.split("; ").find((c) => c.startsWith("gbk_csrf="))?.slice(9) ?? "";
const H = (json = true): Record<string, string> => ({ ...(json ? { "content-type": "application/json" } : {}), "x-gbk-csrf": decodeURIComponent(csrf()) });
async function ok<T>(r: Response): Promise<T> { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.message ?? `HTTP ${r.status}`); return b as T; }

export async function listShares(offset = 0, limit = 12, mine = false): Promise<ShareInfo[]> {
  return (await ok<{ shares: ShareInfo[] }>(await fetch(`${apiBase()}/shares?limit=${limit}&offset=${offset}${mine ? "&mine=1" : ""}`, { credentials: "same-origin" }))).shares;
}
export type TopShare = ShareInfo & { preview: import("./piano-roll-preview.ts").PianoRollPreview };
export async function topShares(limit = 10): Promise<TopShare[]> {
  return (await ok<{ shares: TopShare[] }>(await fetch(`${apiBase()}/shares/top?limit=${limit}`, { credentials: "same-origin" }))).shares;
}
export async function getShare(slug: string): Promise<ShareInfo & { project: unknown }> {
  return ok(await fetch(`${apiBase()}/shares/${encodeURIComponent(slug)}`, { credentials: "same-origin" }));
}
export const mediaUrl = (slug: string, kind: "wav" | "midi" | "mp3") => `${apiBase()}/shares/${encodeURIComponent(slug)}/media/${kind}`;

/** Load a shared song as a NEW read-only local project (validated: shared data is untrusted). */
export async function openShared(slug: string, fork = false): Promise<ShareInfo> {
  playerBridge.holdStartupLoads = true; // in-app navigation to a share: an in-flight player startup load must not win
  const s = await getShare(slug);
  const p = sanitizeSharedProject(s.project);
  if (workstation.project.tracks.length || workstation.project.notes.length) await workstation.host.checkpoint?.(workstation.project); // never overwrite the user's current work
  workstation.loadShared({ ...p, name: s.title.slice(0, 120), meta: { ...(p.meta ?? {}), owner: "user", sharedFrom: { slug: s.slug, title: s.title, owner: s.owner, parentSlug: s.parent?.slug ?? null } } });
  if (fork) workstation.fork();
  return s;
}

/** Share the open project (+ its newest WAV / MIDI artifacts of the current revision, if any). */
export async function shareCurrent(title?: string): Promise<ShareInfo> {
  const p: Project = workstation.project;
  if (workstation.readOnlyReason) throw new Error("Fork this song before sharing it as your own");
  if (!p.tracks.length) throw new Error("nothing to share yet");
  const s = await ok<ShareInfo>(await fetch(`${apiBase()}/shares`, { method: "POST", credentials: "same-origin", headers: H(), body: JSON.stringify({ title: title ?? p.name, project: p, parentSlug: p.meta?.forkOf ?? null, public: true }) }));
  const arts = (await artifactStore().list().catch(() => [])).filter((a) => a.projectId === p.id);
  for (const kind of ["wav", "midi"] as const) {
    const a = arts.find((x) => x.kind === kind); if (!a) continue;
    const blob = await artifactStore().blob(a.id);
    const meta = kind === "wav" && a.wav ? { durationSeconds: a.wav.durationSeconds, sampleRate: a.wav.sampleRate, revision: a.revision, sha256: a.sha256, stale: a.revision !== p.revision } : undefined;
    await ok(await fetch(`${apiBase()}/shares/${s.slug}/media/${kind}`, { method: "PUT", credentials: "same-origin", headers: { ...H(false), "content-type": kind === "wav" ? "audio/wav" : "audio/midi", ...(meta ? { "x-gbk-wav-meta": JSON.stringify(meta) } : {}) }, body: blob }));
  }
  return getShare(s.slug);
}
export async function setSharePublic(slug: string, pub: boolean) { return ok(await fetch(`${apiBase()}/shares/${slug}`, { method: "PATCH", credentials: "same-origin", headers: H(), body: JSON.stringify({ public: pub }) })); }
export async function deleteShare(slug: string) { return ok(await fetch(`${apiBase()}/shares/${slug}`, { method: "DELETE", credentials: "same-origin", headers: H(false) })); }

// ---- My songs: private auto-save + publish ------------------------------------------------------------
export interface SavedSong extends ShareInfo { updatedAt?: string; projectId?: string | null; created?: boolean }
/** Save (upsert) the project as the caller's PRIVATE song. Never makes anything public. */
export async function autosaveProject(p: Project): Promise<SavedSong> {
  return ok(await fetch(`${apiBase()}/songs/autosave`, { method: "PUT", credentials: "same-origin", headers: H(), body: JSON.stringify({ project: p, parentSlug: p.meta?.forkOf ?? null, public: true }) }));
}
export async function uploadMedia(slug: string, kind: "wav" | "midi" | "mp3", blob: Blob, meta?: unknown) {
  return ok(await fetch(`${apiBase()}/shares/${slug}/media/${kind}`, { method: "PUT", credentials: "same-origin", headers: { ...H(false), "content-type": kind === "wav" ? "audio/wav" : kind === "mp3" ? "audio/mpeg" : "audio/midi", ...(meta ? { "x-gbk-wav-meta": JSON.stringify(meta) } : {}) }, body: blob }));
}
export async function suggestTitle(slug: string): Promise<{ title: string; source: string }> {
  return ok(await fetch(`${apiBase()}/songs/${slug}/suggest-title`, { method: "POST", credentials: "same-origin", headers: H(), body: "{}" }));
}
/** The user's explicit confirm in the Publish dialog: set the title and make the song public. */
export async function publishSong(slug: string, title: string): Promise<SavedSong> {
  return ok(await fetch(`${apiBase()}/shares/${slug}`, { method: "PATCH", credentials: "same-origin", headers: H(), body: JSON.stringify({ public: true, title }) }));
}

/** Open one of MY saved songs as an editable local project (same project id, so auto-save keeps updating that song). */
export async function openOwn(slug: string): Promise<ShareInfo> {
  playerBridge.holdStartupLoads = true;
  const s = await getShare(slug) as ShareInfo & { project: unknown; projectId?: string | null; mine?: boolean };
  if (!s.mine) return openShared(slug);
  const p = sanitizeSharedProject(s.project);
  if (workstation.project.tracks.length || workstation.project.notes.length) await workstation.host.checkpoint?.(workstation.project);
  const id = s.projectId || p.id;
  const { songAutosaver } = await import("./autosave.ts");
  songAutosaver.adopt(id, s, p.revision);
  workstation.load({ ...p, id, name: s.title.slice(0, 120) });
  return s;
}
