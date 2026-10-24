// Auto-save of agent-created (and forked) songs to the server as PRIVATE "My songs" entries.
// Debounced per committed revision; after a render the newest WAV artifact of the project is attached as the preview.
import { workstation } from "../workstation/instance.ts";
import { artifactStore } from "../audio/artifact-store.ts";
import { autosaveProject, uploadMedia, type SavedSong } from "./share-client.ts";
import type { Project } from "../workstation/model.ts";
import { reportError } from "../telemetry/error-reporter.ts";

const MAX_WAV = 40 * 1024 * 1024;
type Listener = (s: { projectId: string; song: SavedSong | null; saving: boolean; error?: string }) => void;

export const eligibleByMeta = (p: Project) => !!p.tracks.length && (p.meta?.owner === "agent" || !!p.meta?.forkOf) && !p.meta?.sharedFrom;

export class SongAutosaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saved = new Map<string, { rev: number; song: SavedSong; wavId?: string }>();
  private listeners = new Set<Listener>();
  private unsub: (() => void) | null = null;
  private inflight: Promise<void> | null = null;
  constructor(private delayMs = 2500) {}
  start() {
    if (this.unsub) return;
    this.unsub = workstation.subscribe(() => this.schedule());
    this.schedule();
  }
  stop() { this.unsub?.(); this.unsub = null; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  on(fn: Listener) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private eligible(p: Project) { return eligibleByMeta(p) || (this.saved.has(p.id) && !p.meta?.sharedFrom); }
  /** Remember that a local project is backed by one of the user's saved songs (opened from My songs, or saved by an explicit Share). */
  adopt(projectId: string, song: SavedSong, rev: number) { this.saved.set(projectId, { rev, song }); }
  forget(slug: string) { for (const [k, v] of this.saved) if (v.song.slug === slug) this.saved.delete(k); }
  songFor(projectId: string) { return this.saved.get(projectId)?.song ?? null; }
  private emit(e: Parameters<Listener>[0]) { for (const l of this.listeners) l(e); }
  schedule() {
    const p = workstation.project;
    if (!this.eligible(p) || workstation.readOnlyReason) return;
    const prev = this.saved.get(p.id);
    if (prev && prev.rev === p.revision) { void this.attachWav(p); return; }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.delayMs);
  }
  /** Save now (used by Publish so the latest revision is what gets published). */
  async flush(force = false): Promise<SavedSong | null> {
    if (this.inflight) await this.inflight;
    const p = workstation.project;
    if (!this.eligible(p) && !force) return null;
    const prev = this.saved.get(p.id);
    if (prev && prev.rev === p.revision) { await this.attachWav(p); return prev.song; }
    let out: SavedSong | null = null;
    this.inflight = (async () => {
      this.emit({ projectId: p.id, song: prev?.song ?? null, saving: true });
      try {
        const song = await autosaveProject(p);
        this.saved.set(p.id, { rev: p.revision, song, wavId: prev?.wavId }); out = song;
        this.emit({ projectId: p.id, song, saving: false });
        await this.attachWav(p);
      } catch (e) { reportError(e, { where: "autosave" }); this.emit({ projectId: p.id, song: prev?.song ?? null, saving: false, error: (e as Error).message }); }
    })();
    await this.inflight; this.inflight = null;
    return out;
  }
  private async attachWav(p: Project) {
    const rec = this.saved.get(p.id); if (!rec) return;
    const arts = (await artifactStore().list().catch(() => [])).filter((a) => a.projectId === p.id && a.kind === "wav");
    const a = arts[0]; if (!a || a.id === rec.wavId || (a.bytes ?? 0) > MAX_WAV) return;
    rec.wavId = a.id;
    try {
      const blob = await artifactStore().blob(a.id);
      if (blob.size > MAX_WAV) return;
      await uploadMedia(rec.song.slug, "wav", blob, a.wav ? { durationSeconds: a.wav.durationSeconds, sampleRate: a.wav.sampleRate, revision: a.revision, sha256: a.sha256 } : undefined);
      rec.song = { ...rec.song, hasWav: true };
      this.emit({ projectId: p.id, song: rec.song, saving: false });
    } catch (e) { reportError(e, { where: "autosave.attachWav" }); rec.wavId = undefined; }
  }
}
export const songAutosaver = new SongAutosaver();
