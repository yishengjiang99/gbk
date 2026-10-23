// Render jobs: immutable project snapshot -> renderProjectOffline -> optional artifact save. Jobs run one at a
// time (FIFO) in the current page; status lives in memory only (not durable across reloads; artifacts are).
import type { Project } from "../workstation/model.ts";
import { renderProjectOffline, type OfflineRenderOptions, type RenderResult, type RenderStage } from "./offline-renderer.ts";
import { artifactStore, type ArtifactMeta, type ArtifactStore } from "./artifact-store.ts";
import { RenderError, asRenderError } from "./render-error.ts";
import type { LoadedSoundFont } from "./soundfont-loader.ts";

export type JobStatus = "queued" | "loading" | "rendering" | "encoding" | "validating" | "saving" | "completed" | "failed" | "cancelled";
export interface RenderJob {
  id: string; projectId: string; projectName: string; revision: number; status: JobStatus; progress: number; createdAt: number; finishedAt?: number;
  options: OfflineRenderOptions; saveArtifact: boolean; artifactId?: string; error?: { code: string; message: string };
  result?: Omit<RenderResult, "blob" | "bytes" | "stats"> & { stats: Omit<RenderResult["stats"], "windowRmsDbFS"> };
}

export function safeFilename(name: string, ext: string) { return `${(name || "gbk").replace(/[^\w\- .]/g, "_").replace(/\s+/g, "-").slice(0, 80) || "gbk"}.${ext}`; }

export class RenderJobManager {
  private jobs = new Map<string, RenderJob>();
  private aborts = new Map<string, AbortController>();
  private done = new Map<string, Promise<RenderJob>>();
  private results = new Map<string, RenderResult>();
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(j: RenderJob) => void>();
  private seq = 0;
  constructor(private store: () => ArtifactStore = artifactStore, private deps: { soundFont?: LoadedSoundFont } = {}) {}
  subscribe(f: (j: RenderJob) => void) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }
  private patch(id: string, p: Partial<RenderJob>) { const j = { ...this.jobs.get(id)!, ...p }; this.jobs.set(id, j); for (const f of this.listeners) f(j); return j; }
  get(id: string): RenderJob { const j = this.jobs.get(id); if (!j) throw new RenderError("INVALID_ARGUMENT", `unknown render job ${id}`); return j; }
  list(): RenderJob[] { return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt); }
  /** In-memory result (bytes) of a completed job in this page; null after reload or eviction. */
  result(id: string) { return this.results.get(id) ?? null; }
  wait(id: string) { this.get(id); return this.done.get(id)!; }
  cancel(id: string) { const j = this.get(id); if (["completed", "failed", "cancelled"].includes(j.status)) return false; this.aborts.get(id)?.abort(); if (j.status === "queued") this.patch(id, { status: "cancelled", finishedAt: Date.now() }); return true; }

  /** Snapshot the project NOW (later edits never affect this render) and queue it. */
  submit(project: Project, options: OfflineRenderOptions, opts: { saveArtifact?: boolean; signal?: AbortSignal; keepResult?: boolean } = {}): RenderJob {
    const snap = structuredClone(project);
    const id = `job_${Date.now().toString(36)}_${++this.seq}`;
    const job: RenderJob = { id, projectId: snap.id, projectName: snap.name, revision: snap.revision, status: "queued", progress: 0, createdAt: Date.now(), options, saveArtifact: opts.saveArtifact ?? true };
    this.jobs.set(id, job); for (const f of this.listeners) f(job);
    const ac = new AbortController(); this.aborts.set(id, ac);
    opts.signal?.addEventListener("abort", () => ac.abort(), { once: true });
    const run = async (): Promise<RenderJob> => {
      if (ac.signal.aborted) return this.patch(id, { status: "cancelled", finishedAt: Date.now() });
      try {
        const stageMap: Record<RenderStage, JobStatus> = { loading: "loading", resolving: "loading", rendering: "rendering", encoding: "encoding", validating: "validating" };
        const weight: Record<RenderStage, [number, number]> = { loading: [0, 0.1], resolving: [0.1, 0.12], rendering: [0.12, 0.9], encoding: [0.9, 0.93], validating: [0.93, 0.97] };
        let last = 0;
        const r = await renderProjectOffline(snap, options, ac.signal, (x, st) => {
          const [a, b] = weight[st]; const pr = a + (b - a) * x;
          if (pr - last > 0.005 || stageMap[st] !== this.jobs.get(id)!.status) { last = pr; this.patch(id, { status: stageMap[st], progress: +pr.toFixed(3) }); }
        }, this.deps);
        const { blob: _b, bytes: _y, stats, ...meta } = r; const { windowRmsDbFS: _w, ...lean } = stats;
        let artifactId: string | undefined;
        if (job.saveArtifact) {
          this.patch(id, { status: "saving", progress: 0.97 });
          const a: ArtifactMeta = await this.store().save({ kind: "wav", filename: safeFilename(snap.name, "wav"), mimeType: "audio/wav", sha256: r.sha256, projectId: snap.id, projectName: snap.name, revision: snap.revision, jobId: id,
            wav: { durationSeconds: r.durationSeconds, sampleRate: r.sampleRate, channels: r.channels, format: r.format, frames: r.framesRendered, peakDbFS: r.peakDbFS, rmsDbFS: r.rmsDbFS, clippedSamples: r.clippedSamples, validated: true, loudness: r.loudness } }, r.blob);
          artifactId = a.id;
        }
        if (opts.keepResult !== false) { this.results.set(id, r); for (const k of [...this.results.keys()].slice(0, -2)) this.results.delete(k); } // keep the last 2 in memory
        return this.patch(id, { status: "completed", progress: 1, finishedAt: Date.now(), artifactId, result: { ...meta, stats: lean } });
      } catch (e) {
        const err = asRenderError(e);
        return this.patch(id, { status: err.code === "OPERATION_CANCELLED" ? "cancelled" : "failed", finishedAt: Date.now(), error: { code: err.code, message: err.message } });
      } finally { this.aborts.delete(id); }
    };
    const p = this.chain.then(run, run); this.chain = p.catch(() => undefined);
    this.done.set(id, p);
    return job;
  }
}

const g = globalThis as { __gbkRenderJobs?: RenderJobManager };
export function renderJobs(): RenderJobManager { return g.__gbkRenderJobs ??= new RenderJobManager(); }
