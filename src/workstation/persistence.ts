// Versioned project persistence (IndexedDB "projects" store) with migrations + autosave.
import { PROJECT_SCHEMA_VERSION, type Project } from "./model.ts";
import type { WorkstationController } from "./controller.ts";
import { midiFileStore } from "../midi-file-store.ts";

/** Migrate a stored project to the current schema; returns null if unusable. */
export function migrateProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== "object") return null;
  const p = { ...(raw as Record<string, unknown>) } as Record<string, unknown>;
  const v = typeof p.schemaVersion === "number" ? p.schemaVersion : 0;
  if (v > PROJECT_SCHEMA_VERSION) return null; // from a newer build: don't guess
  if (v < 1) {
    // v0 (pre-release shape): missing pressure/raw/loop arrays.
    p.channelPressure ??= []; p.polyPressure ??= []; p.raw ??= []; p.pitchBends ??= [];
    p.loop ??= { enabled: false, startTick: 0, endTick: 0 };
    p.selection ??= { trackIds: [], startTick: 0, endTick: 0, noteIds: [] };
    p.schemaVersion = 1;
  }
  for (const k of ["tracks", "notes", "ccs", "programs", "tempos", "timeSigs"]) if (!Array.isArray(p[k])) return null;
  // Optional sound layer (GBK sound design): drop it if malformed rather than rejecting the project.
  if (p.sound !== undefined) {
    const snd = p.sound as { tracks?: unknown; effects?: unknown } | null;
    if (!snd || typeof snd !== "object" || typeof snd.tracks !== "object" || snd.tracks === null) delete p.sound;
  }
  if (typeof p.id !== "string" || typeof p.ppq !== "number" || p.ppq <= 0) return null;
  return p as unknown as Project;
}

export function enableAutosave(c: WorkstationController, delayMs = 800) {
  let timer: ReturnType<typeof setTimeout> | null = null; let lastKey = "";
  return c.subscribe((s) => {
    const key = `${s.project.id}:${s.project.revision}`;
    if (key === lastKey || s.project.tracks.length === 0) return;
    lastKey = key;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void midiFileStore.putProject({ id: s.project.id, schemaVersion: PROJECT_SCHEMA_VERSION, savedAt: Date.now(), project: s.project }); }, delayMs);
  });
}

export async function restoreLatest(c: WorkstationController): Promise<boolean> {
  const rec = await midiFileStore.getLatestProject();
  const p = rec ? migrateProject(rec.project) : null;
  if (!p) return false;
  const cur = c.project;
  // Only replace an empty or untouched (revision 0) import of the same song; never clobber edits made this session.
  if (cur.tracks.length === 0 || (cur.revision === 0 && cur.name === p.name)) { c.load(p); return true; }
  return false;
}
