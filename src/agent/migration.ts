// User-controlled export / import of local projects + render artifacts. Browser storage is per origin, so moving
// from yishengjiang99.github.io/gbk/ to compose.grepawk.com needs this; nothing moves automatically.
import { midiFileStore } from "../midi-file-store.ts";
import { artifactStore } from "../audio/artifact-store.ts";
import { migrateProject } from "../workstation/persistence.ts";
import { base64 } from "../audio/artifact-store.ts";

export async function exportLocalData(includeAudio = true): Promise<Blob> {
  const projects = await midiFileStore.listProjects();
  const arts = await artifactStore().list().catch(() => []);
  const artifacts = [];
  for (const a of arts) {
    if (a.kind === "wav" && !includeAudio) continue;
    artifacts.push({ meta: a, base64: base64(new Uint8Array(await (await artifactStore().blob(a.id)).arrayBuffer())) });
  }
  return new Blob([JSON.stringify({ format: "gbk-local-export", version: 1, exportedAt: new Date().toISOString(), origin: location.origin, projects, artifacts })], { type: "application/json" });
}

export async function importLocalData(file: Blob): Promise<{ projects: number; artifacts: number; skipped: number }> {
  const j = JSON.parse(await file.text());
  if (j?.format !== "gbk-local-export") throw new Error("not a GBK export file");
  let projects = 0, artifacts = 0, skipped = 0;
  for (const r of Array.isArray(j.projects) ? j.projects : []) { const p = migrateProject(r?.project); if (!p) { skipped++; continue; } await midiFileStore.putProject({ id: p.id, schemaVersion: p.schemaVersion, savedAt: Number(r.savedAt) || Date.now(), project: p }); projects++; }
  for (const a of Array.isArray(j.artifacts) ? j.artifacts : []) {
    try { const bin = Uint8Array.from(atob(String(a.base64)), (ch) => ch.charCodeAt(0)); const m = a.meta;
      await artifactStore().save({ kind: m.kind === "midi" ? "midi" : "wav", filename: String(m.filename).slice(0, 120), mimeType: m.kind === "midi" ? "audio/midi" : "audio/wav", sha256: String(m.sha256), projectId: String(m.projectId), projectName: String(m.projectName).slice(0, 120), revision: Number(m.revision) || 0, ...(m.wav ? { wav: m.wav } : {}) }, new Blob([bin], { type: m.kind === "midi" ? "audio/midi" : "audio/wav" })); artifacts++; }
    catch { skipped++; }
  }
  return { projects, artifacts, skipped };
}
