// RenderService: durable render jobs executed by an isolated worker-thread pool running the canonical
// GBK offline renderer. No interactive browser, tab, audio device or user gesture is involved.
//
// Guarantees:
//  - The project snapshot is pinned at submit time (structuredClone) and the job records its revision.
//  - Artifacts are written to disk first, validated by the renderer itself (header/duration/silence/
//    clipping/non-finite + SHA-256), the SHA-256 is re-checked on receipt, and only then are artifact rows
//    inserted and the job marked completed — a killed worker can never publish a partial artifact.
//  - On process start, jobs left "running" are failed explicitly by McpStore (WORKER_INTERRUPTED).
//  - Per-job timeout terminates the worker (and respawns it); cancellation does the same.
//  - If worker threads cannot start at all, the service falls back to in-process rendering with the same
//    canonical code path and reports executor:"inprocess" honestly in job metadata.
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync, renameSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.ts";
import type { Project } from "../../../src/workstation/model.ts";
import { serializeSmf } from "../../../src/workstation/smf.ts";
import { parseWavHeader } from "../../../src/audio/audio-validation.ts";
import { parseSoundFont } from "../../../src/audio/soundfont-loader.ts";
import { renderProjectOffline, type OfflineRenderOptions } from "../../../src/audio/offline-renderer.ts";
import { McpStore, type RenderJobRow, type CompositionRow } from "./store.ts";
import { McpError } from "./errors.ts";
import { isGuest } from "./guest.ts";
import { tickToSec } from "../../../src/workstation/timing.ts";
import { RENDERER_VERSION } from "./service-meta.ts";

export interface RenderConfig {
  sampleRate: 44100 | 48000; channels: 1 | 2; format: "pcm16" | "float32";
  normalize: "loudness" | "peak" | "off"; targetLufs?: number; tailSeconds?: number; includeMidi: boolean;
}
export const DEFAULT_RENDER_CONFIG: RenderConfig = { sampleRate: 44100, channels: 2, format: "pcm16", normalize: "loudness", tailSeconds: 3, includeMidi: true };

export function resolveSoundFontPath(cfg: Config): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    cfg.mcp.soundFontPath,
    join(process.cwd(), "dist", "static", "GeneralUser-GS.sf2"),
    join(process.cwd(), "public", "static", "GeneralUser-GS.sf2"),
    join(here, "..", "..", "..", "dist", "static", "GeneralUser-GS.sf2"),
    join(here, "..", "..", "..", "public", "static", "GeneralUser-GS.sf2"),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new McpError("WORKER_UNAVAILABLE", `bundled SoundFont not found; set GBK_SOUNDFONT_PATH (tried: ${candidates.join(", ")})`);
}

function workerEntry(): { url: URL; execArgv?: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const mjs = join(here, "render-worker.mjs");
  if (existsSync(mjs)) return { url: new URL(`file://${mjs}`) };
  const ts = join(here, "render-worker.ts");
  if (existsSync(ts)) return { url: new URL(`file://${ts}`), execArgv: ["--disable-warning=ExperimentalWarning", "--import", "tsx/esm"] };
  throw new McpError("WORKER_UNAVAILABLE", "render worker entry not found (render-worker.mjs / .ts)");
}

interface Pending { jobId: string; owner: string; row: CompositionRow; snapshot: Project; config: RenderConfig }
interface Slot { w: Worker; busy: boolean; jobId?: string; ready: boolean; __pending?: Pending }
type Waiter = (job: RenderJobRow) => void;
interface WorkerMsg { type: string; jobId?: string; progress?: number; meta?: Record<string, unknown>; bytes?: ArrayBuffer; code?: string; message?: string }

export class RenderService {
  private pool: Slot[] = [];
  private queue: Pending[] = [];
  private timers = new Map<string, NodeJS.Timeout>();
  private cancels = new Map<string, () => void>();
  private waiters = new Map<string, Set<{ owner: string; fn: Waiter }>>();
  executor: "worker" | "inprocess" = "worker";
  private sfPath = "";
  private stopped = false;
  private fallingBack = false;
  private inProcessActive = 0;
  private retentionTimer?: NodeJS.Timeout;

  constructor(private cfg: Config, private store: McpStore, private log: (o: object) => void = () => {}, private rendersPerDay: (owner: string) => number = () => cfg.mcp.maxRendersPerDay) {}

  async start(): Promise<void> {
    const prune = () => { try { this.store.pruneArtifacts(this.cfg.mcp.artifactRetentionDays); } catch (e) { this.log({ evt: "mcp_artifact_cleanup_failed", message: (e as Error).message }); } };
    prune(); this.retentionTimer = setInterval(prune, 60_000); this.retentionTimer.unref();
    try {
      this.sfPath = resolveSoundFontPath(this.cfg);
      const entry = workerEntry();
      for (let i = 0; i < this.cfg.mcp.renderConcurrency; i++) await this.spawn(entry);
      this.executor = "worker";
    } catch (e) {
      this.log({ evt: "mcp_render_worker_fallback", message: (e as Error).message });
      this.fallingBack = true;
      await Promise.all(this.pool.map((slot) => slot.w.terminate().catch(() => undefined)));
      this.pool = [];
      this.executor = "inprocess";
      try { this.sfPath = resolveSoundFontPath(this.cfg); } catch { /* renders will fail with the same error, surfaced per job */ }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.retentionTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    await Promise.all(this.pool.map((p) => p.w.terminate().catch(() => undefined)));
    this.pool = [];
  }
  private async spawn(entry = workerEntry()): Promise<void> {
    const w = new Worker(entry.url, entry.execArgv ? { execArgv: entry.execArgv } : {});
    const slot: Slot = { w, busy: false, ready: false };
    this.pool.push(slot);
    await new Promise<void>((resolve, reject) => {
      const onMsg = (m: { type: string; message?: string }) => {
        if (m.type === "ready") { slot.ready = true; w.off("message", onMsg); resolve(); }
        if (m.type === "init-error") { w.off("message", onMsg); reject(new Error(m.message)); }
      };
      w.on("message", onMsg);
      w.once("error", (e) => reject(e));
      w.postMessage({ type: "init", soundFontPath: this.sfPath });
    });
    w.on("message", (m: WorkerMsg) => this.onWorkerMessage(slot, m));
    w.on("exit", (code) => {
      if (this.stopped || this.fallingBack) return;
      const i = this.pool.indexOf(slot); if (i >= 0) this.pool.splice(i, 1);
      if (slot.jobId) this.failJob(slot.jobId, "WORKER_UNAVAILABLE", `render worker exited (code ${code}) mid-job; no artifact was published — resubmit to retry`);
      void this.spawn().then(() => this.pump()).catch((e) => this.log({ evt: "mcp_render_respawn_failed", message: (e as Error).message }));
    });
  }

  // ---- public API ---------------------------------------------------------------------
  submit(owner: string, row: CompositionRow, snapshot: Project, config: RenderConfig): RenderJobRow {
    const limit = isGuest(owner) ? this.cfg.mcp.guestRendersPerDay : this.rendersPerDay(owner);
    const seconds = tickToSec(snapshot, snapshot.endTick) + (config.tailSeconds ?? 3);
    const maxSeconds = isGuest(owner) ? Math.min(this.cfg.mcp.guestMaxSeconds, this.cfg.mcp.maxRenderSeconds) : this.cfg.mcp.maxRenderSeconds;
    if (!Number.isFinite(seconds) || seconds > maxSeconds) throw new McpError("QUOTA_EXCEEDED", `render duration exceeds ${maxSeconds} seconds (including tail)`);
    if (this.store.queueDepth() >= this.cfg.mcp.maxQueueDepth) throw new McpError("QUOTA_EXCEEDED", "global render queue is full; retry later");
    this.store.pruneArtifacts(this.cfg.mcp.artifactRetentionDays);
    // Reserve worst-case WAV + MIDI bytes for ALL admitted jobs, even across different guests.
    const reserve = this.cfg.mcp.maxRenderSeconds * 48000 * 2 * 4 + 8 * 1024 ** 2;
    if (this.store.metrics().artifactBytes + (this.store.queueDepth() + 1) * reserve > this.cfg.mcp.maxArtifactBytes)
      throw new McpError("QUOTA_EXCEEDED", "artifact storage capacity reached; retry after older artifacts expire");
    if (this.store.countJobsSince(owner, 86_400_000) >= limit) throw new McpError("QUOTA_EXCEEDED", `daily render limit reached (${limit})`);
    const job = this.store.createJob({ compositionId: row.id, owner, revision: row.revision, config: { ...config, executor: this.executor, rendererVersion: RENDERER_VERSION } });
    this.queue.push({ jobId: job.id, owner, row, snapshot: structuredClone(snapshot), config });
    this.pump();
    return job;
  }
  status(owner: string, jobId: string): RenderJobRow {
    const j = this.store.getJob(jobId, owner);
    if (!j) throw new McpError("NOT_FOUND", "no such render job for this account");
    return j;
  }
  cancel(owner: string, jobId: string): RenderJobRow {
    const j = this.status(owner, jobId);
    if (["completed", "failed", "cancelled"].includes(j.status)) return j;
    const qi = this.queue.findIndex((q) => q.jobId === jobId);
    if (qi >= 0) { this.queue.splice(qi, 1); this.finish(jobId, "cancelled", null); return this.status(owner, jobId); }
    this.cancels.get(jobId)?.();
    this.finish(jobId, "cancelled", null);
    return this.status(owner, jobId);
  }
  /** Resolve when the job reaches a terminal state or the timeout elapses (returns current state either way). */
  waitFor(owner: string, jobId: string, timeoutMs: number): Promise<RenderJobRow> {
    const j = this.status(owner, jobId);
    if (["completed", "failed", "cancelled"].includes(j.status) || timeoutMs <= 0) return Promise.resolve(j);
    return new Promise((resolve) => {
      const entry = { owner, fn: (job: RenderJobRow) => { clearTimeout(t); resolve(job); } };
      const t = setTimeout(() => { this.waiters.get(jobId)?.delete(entry); resolve(this.status(owner, jobId)); }, timeoutMs);
      if (!this.waiters.has(jobId)) this.waiters.set(jobId, new Set());
      this.waiters.get(jobId)!.add(entry);
    });
  }
  jobView(owner: string, job: RenderJobRow) {
    const artifacts = job.status === "completed" ? this.store.listArtifacts(job.composition_id, owner).filter((a) => a.job_id === job.id) : [];
    return {
      jobId: job.id, compositionId: job.composition_id, revision: job.revision, status: job.status,
      progress: job.progress, config: JSON.parse(job.config_json) as RenderConfig & { executor: string; rendererVersion: string },
      error: job.error ? JSON.parse(job.error) as { code: string; message: string } : null,
      createdAt: new Date(job.created_at).toISOString(), finishedAt: job.finished_at ? new Date(job.finished_at).toISOString() : null,
      artifacts: artifacts.map((a) => ({ artifactId: a.id, kind: a.kind, filename: a.filename, mimeType: a.mime_type, sizeBytes: a.size_bytes, sha256: a.sha256, meta: JSON.parse(a.meta_json) })),
    };
  }

  // ---- execution -----------------------------------------------------------------------
  private pump() {
    if (this.stopped) return;
    while (this.queue.length) {
      if (this.executor === "inprocess") {
        if (this.inProcessActive >= this.cfg.mcp.renderConcurrency) return;
        const job = this.queue.shift()!; this.inProcessActive++;
        void this.runInProcess(job).finally(() => { this.inProcessActive--; this.pump(); }); continue;
      }
      const slot = this.pool.find((p) => p.ready && !p.busy);
      if (!slot) return;
      const job = this.queue.shift()!;
      this.runOnWorker(slot, job);
    }
  }
  private options(config: RenderConfig): OfflineRenderOptions {
    return { sampleRate: config.sampleRate, channels: config.channels, format: config.format, normalize: config.normalize,
      targetLufs: config.targetLufs, tailSeconds: config.tailSeconds ?? 3, maxSeconds: this.cfg.mcp.maxRenderSeconds };
  }
  private armTimeout(jobId: string, kill: () => void) {
    const t = setTimeout(() => { kill(); this.failJob(jobId, "RENDER_TIMEOUT", `render exceeded ${this.cfg.mcp.renderTimeoutMs} ms and was terminated; no artifact was published`); }, this.cfg.mcp.renderTimeoutMs);
    t.unref?.(); this.timers.set(jobId, t);
    this.cancels.set(jobId, kill);
  }
  private runOnWorker(slot: Slot, job: Pending) {
    slot.busy = true; slot.jobId = job.jobId;
    this.store.patchJob(job.jobId, { status: "running", progress: 0 });
    this.armTimeout(job.jobId, () => { void slot.w.terminate(); });
    slot.__pending = job;
    slot.w.postMessage({ type: "render", jobId: job.jobId, project: job.snapshot, options: this.options(job.config) });
  }
  private onWorkerMessage(slot: Slot, m: WorkerMsg) {
    const job = slot.__pending; if (!job || m.jobId !== job.jobId) return;
    if (m.type === "progress") { this.store.patchJob(job.jobId, { progress: Math.max(0, Math.min(1, m.progress ?? 0)) }); return; }
    if (m.type === "done") {
      slot.busy = false; slot.jobId = undefined; slot.__pending = undefined;
      this.clearTimer(job.jobId);
      try { this.completeJob(job, new Uint8Array(m.bytes!), m.meta!); }
      catch (e) { this.failJob(job.jobId, "RENDER_FAILED", (e as Error).message); }
      this.pump(); return;
    }
    if (m.type === "error") {
      slot.busy = false; slot.jobId = undefined; slot.__pending = undefined;
      this.clearTimer(job.jobId);
      this.failJob(job.jobId, m.code ?? "RENDER_FAILED", m.message ?? "render failed");
      this.pump();
    }
  }
  private async runInProcess(job: Pending) {
    this.store.patchJob(job.jobId, { status: "running", progress: 0 });
    const ac = new AbortController();
    this.armTimeout(job.jobId, () => ac.abort());
    try {
      const sf = parseSoundFont(new Uint8Array(readFileSync(this.sfPath)), "server-soundfont", "GeneralUser-GS.sf2");
      const r = await renderProjectOffline(job.snapshot, this.options(job.config), ac.signal, (x) => this.store.patchJob(job.jobId, { progress: x }), { soundFont: sf });
      this.clearTimer(job.jobId);
      const { blob: _b, bytes: _y, stats: _s, wav: _w, ...meta } = r;
      this.completeJob(job, r.bytes, meta as unknown as Record<string, unknown>);
    } catch (e) {
      this.clearTimer(job.jobId);
      const err = e as { code?: string; message?: string };
      if (this.store.getJob(job.jobId, job.owner)?.status === "running") this.failJob(job.jobId, err.code ?? "RENDER_FAILED", err.message ?? String(e));
    }
  }
  private completeJob(job: Pending, wavBytes: Uint8Array, meta: Record<string, unknown>) {
    if (this.store.getJob(job.jobId, job.owner)?.status !== "running") return;
    // Re-verify what the worker claims before anything is published.
    const sha = createHash("sha256").update(wavBytes).digest("hex");
    if (sha !== meta.sha256) throw new McpError("RENDER_FAILED", "rendered WAV failed SHA-256 verification against the worker's report; artifact discarded");
    const info = parseWavHeader(wavBytes.subarray(0, Math.min(wavBytes.length, 4096)), wavBytes.length);
    if (meta.validated !== true) throw new McpError("RENDER_FAILED", "renderer did not validate the WAV; artifact discarded");
    mkdirSync(this.store.artifactsDir, { recursive: true });
    const write = (rel: string, bytes: Uint8Array) => { const tmp = join(this.store.artifactsDir, `${rel}.tmp`); writeFileSync(tmp, bytes); renameSync(tmp, join(this.store.artifactsDir, rel)); };
    const base = { job_id: job.jobId, composition_id: job.row.id, owner: job.owner, revision: job.row.revision };
    const wavRel = `${job.jobId}.wav`; write(wavRel, wavBytes);
    const provenance = { rendererVersion: RENDERER_VERSION, sourceRevision: job.row.revision, soundFont: meta.soundFont, renderMs: meta.renderMs, executor: this.executor };
    this.store.addArtifact({ ...base, kind: "wav", filename: `${job.row.title.replace(/[^\w\- .]/g, "_").slice(0, 60) || "gbk"}.wav`, mime_type: "audio/wav",
      size_bytes: wavBytes.length, sha256: sha, rel_path: wavRel,
      meta_json: JSON.stringify({ validated: true, sampleRate: info.sampleRate, channels: info.channels, format: info.format, durationSeconds: info.durationSeconds,
        frames: info.frames, peakDbFS: meta.peakDbFS, rmsDbFS: meta.rmsDbFS, clippedSamples: meta.clippedSamples, loudness: meta.loudness, instruments: meta.instruments, warnings: meta.warnings, noteCount: meta.noteCount, ...provenance }) });
    if (job.config.includeMidi) {
      const midi = serializeSmf(job.snapshot, { soundNrpn: true });
      if (!(midi.length > 14 && String.fromCharCode(...midi.subarray(0, 4)) === "MThd")) throw new McpError("RENDER_FAILED", "MIDI export failed validation (missing MThd header); WAV kept, MIDI discarded");
      const midiRel = `${job.jobId}.mid`; write(midiRel, midi);
      const soundOverrides = job.snapshot.sound?.tracks && Object.keys(job.snapshot.sound.tracks).length
        ? "project has SoundFont voice overrides: additive ones export as SF2 NRPNs; absolute/key-ranged overrides and global effects are audible in the WAV only" : undefined;
      this.store.addArtifact({ ...base, kind: "midi", filename: `${job.row.title.replace(/[^\w\- .]/g, "_").slice(0, 60) || "gbk"}.mid`, mime_type: "audio/midi",
        size_bytes: midi.length, sha256: createHash("sha256").update(midi).digest("hex"), rel_path: midiRel,
        meta_json: JSON.stringify({ validated: true, format: "SMF type 1", preserves: ["tempo map", "meter map", "program changes", "CC events", "pitch bend", "section markers"], ...(soundOverrides ? { portabilityNote: soundOverrides } : {}), ...provenance }) });
    }
    this.finish(job.jobId, "completed", null, 1);
    this.log({ evt: "mcp_render_completed", user: job.owner, jobId: job.jobId, compositionId: job.row.id, revision: job.row.revision, bytes: wavBytes.length, sha256: sha });
  }
  private failJob(jobId: string, code: string, message: string) {
    this.finish(jobId, "failed", JSON.stringify({ code, message }));
    this.log({ evt: "mcp_render_failed", jobId, code, message });
  }
  private finish(jobId: string, status: "completed" | "failed" | "cancelled", error: string | null, progress?: number) {
    this.clearTimer(jobId);
    this.store.patchJob(jobId, { status, error, finished_at: Date.now(), ...(progress !== undefined ? { progress } : {}) });
    const waiters = this.waiters.get(jobId);
    if (waiters) {
      this.waiters.delete(jobId);
      for (const w of waiters) { const row = this.store.getJob(jobId, w.owner); if (row) w.fn(row); }
    }
  }
  private clearTimer(jobId: string) { const t = this.timers.get(jobId); if (t) { clearTimeout(t); this.timers.delete(jobId); } this.cancels.delete(jobId); }
}
