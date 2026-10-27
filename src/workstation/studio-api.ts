// window.gbkStudio: the current project's draft state, shared by the web Create entry and the iOS app.
// Rule (web + iOS): Create resumes the current project only when hasContent && (!published || dirtySincePublish);
// otherwise it opens /studio?new=<ts> (a fresh project; the old one stays in IndexedDB / Recent).
import { workstation } from "./instance.ts";
import { emptyProject, PROJECT_SCHEMA_VERSION } from "./model.ts";
import { isOwnProject } from "./persistence.ts";
import { midiFileStore, type StoredProjectRecord } from "../midi-file-store.ts";

export interface CurrentProject { id: string; title: string; published: boolean; dirtySincePublish: boolean; hasContent: boolean; updatedAt: number | null }

const KEY = "gbk.publishedRevs.v1"; // { [projectId]: revision at publish }
const marks = (): Record<string, number> => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } };
/** Remember that this project's revision is what is public now. */
export function markPublished(projectId: string, revision: number) {
  try { const m = marks(); m[projectId] = revision; const ids = Object.keys(m); for (const k of ids.slice(0, Math.max(0, ids.length - 200))) delete m[k]; localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* storage full/blocked */ }
}
/** Server view of my public songs (by local project id and by title), so projects published elsewhere count too. */
let remote: { byId: Map<string, number>; byTitle: Map<string, number> } | null = null;
let remoteP: Promise<void> | null = null;
export function refreshPublished(): Promise<void> {
  return remoteP ??= (async () => {
    try {
      const { listShares } = await import("../agent/share-client.ts");
      const list = await listShares(0, 100, true) as { public: boolean; projectId?: string | null; title: string; updatedAt?: string }[];
      const byId = new Map<string, number>(); const byTitle = new Map<string, number>();
      for (const s of list) if (s.public) { const t = Date.parse(s.updatedAt ?? "") || 0; if (s.projectId) byId.set(s.projectId, t); if (s.title && s.title !== "Untitled") byTitle.set(s.title, t); }
      remote = { byId, byTitle };
    } catch { /* signed out / offline: local marks only */ } finally { remoteP = null; }
  })();
}

let updatedAt: number | null = null; let seen = "";
workstation.subscribe((s) => {
  const p = s.project; const k = `${p.id}:${p.revision}`; if (k === seen) return;
  const sameId = seen.startsWith(`${p.id}:`); seen = k;
  if (sameId) updatedAt = Date.now();
  else { updatedAt = null; void midiFileStore.listProjects().then((all) => { const r = all.find((x) => x.id === p.id); if (r && workstation.project.id === p.id && updatedAt == null) updatedAt = r.savedAt; }).catch(() => undefined); }
});

export function currentProject(): CurrentProject {
  const p = workstation.project; const hasContent = p.notes.length > 0 && !workstation.readOnlyReason && isOwnProject(p);
  const rev = marks()[p.id];
  let published = rev !== undefined; let dirty = published && p.revision > rev;
  if (!published && remote) {
    const t = remote.byId.get(p.id) ?? remote.byTitle.get(p.name);
    if (t !== undefined) { published = true; dirty = updatedAt != null && updatedAt > t + 2000; }
  }
  return { id: p.id, title: p.name, published, dirtySincePublish: dirty, hasContent, updatedAt };
}
export const shouldResume = (c = currentProject()) => c.hasContent && (!c.published || c.dirtySincePublish);

/** Path for the Create entry: the in-progress draft, or a fresh project. Waits briefly for the server's publish state. */
export async function createPath(): Promise<string> {
  await Promise.race([refreshPublished(), new Promise((r) => setTimeout(r, 1200))]);
  return shouldResume() ? "studio" : `studio?new=${Date.now()}`;
}

/** Persist the current project now (IndexedDB, plus the signed-in server autosave when eligible). */
export async function flushSave(): Promise<void> {
  const p = workstation.project;
  if (p.tracks.length && isOwnProject(p) && !workstation.readOnlyReason) await midiFileStore.putProject({ id: p.id, schemaVersion: PROJECT_SCHEMA_VERSION, savedAt: Date.now(), project: p });
  try { const { songAutosaver } = await import("../agent/autosave.ts"); await songAutosaver.flush(); } catch { /* offline / signed out */ }
}

/** Start a blank project now. The current one is saved to IndexedDB first (Recent keeps it reachable). */
export async function startNew(): Promise<void> {
  await flushSave();
  workstation.stop();
  workstation.load(emptyProject());
}

/** Saved local projects, newest first (for the Recent list). */
export async function recentProjects(limit = 8): Promise<{ id: string; title: string; savedAt: number }[]> {
  const all = await midiFileStore.listProjects();
  return all.filter((r) => typeof r.savedAt === "number" && (r.project as { notes?: unknown[] })?.notes?.length).sort((a, b) => b.savedAt - a.savedAt).slice(0, limit)
    .map((r) => ({ id: r.id, title: String((r.project as { name?: string }).name ?? "Untitled"), savedAt: r.savedAt }));
}
export async function openRecent(id: string): Promise<boolean> {
  const { migrateProject } = await import("./persistence.ts");
  const rec: StoredProjectRecord | undefined = (await midiFileStore.listProjects()).find((r) => r.id === id);
  const q = rec ? migrateProject(rec.project) : null; if (!q) return false;
  const cur = workstation.project; if (cur.id === q.id) return true;
  if (cur.tracks.length && isOwnProject(cur) && !workstation.readOnlyReason) await midiFileStore.putProject({ id: cur.id, schemaVersion: PROJECT_SCHEMA_VERSION, savedAt: Date.now(), project: cur });
  workstation.load(q); return true;
}

// In-app navigation to /studio?new=… after the page booted (instance.ts only reads ?new at load).
if (typeof window !== "undefined") {
  const onNav = () => {
    const q = new URLSearchParams(location.search); const n = q.get("new");
    if (!/\/studio\/?$/.test(location.pathname) || !n || n === "0") return;
    q.delete("new"); history.replaceState(history.state, "", `${location.pathname}${q.toString() ? `?${q}` : ""}${location.hash}`);
    void startNew();
  };
  window.addEventListener("popstate", onNav);
  (window as unknown as { gbkStudio: object }).gbkStudio = { currentProject, shouldResume, createPath, flushSave, startNew, recentProjects, openRecent, refreshPublished };
  void refreshPublished();
}
