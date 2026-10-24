// RenderService: durable render jobs executed by an isolated worker-thread pool running the canonical
// GBK offline renderer. No interactive browser, tab, audio device or user gesture is involved.
//
// Guarantees:
//  - The project snapshot is pinned at submit time (structuredClone) and the job records its revision.
//  - Artifact publication is atomic: every payload (WAV + MIDI) is built and validated first, files are
//    written, and only then are the artifact rows inserted in ONE store transaction and the job marked
//    completed — a failure anywhere publishes nothing, never a lone WAV for a failed job.
//  - On process start, jobs left "running" are failed explicitly by McpStore (WORKER_INTERRUPTED), and
//    jobs left "queued" are rehydrated from their stored revision snapshot + config and resumed (or
//    failed as JOB_ORPHANED when their composition/revision no longer exists) — never stuck forever.
//  - Terminal states are final: job completion/failure/cancellation transitions only from
//    queued/running (store.transitionJob), so a late worker exit, a racing "done" or a timeout can
//    never overwrite a cancelled or completed job.
//  - Per-job timeout terminates the worker (and respawns it); cancellation does the same.
//  - If worker threads cannot start at all, the service falls back to in-process rendering with the same
//    canonical code path and reports executor:"inprocess" honestly in job metadata.
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync, renameSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
import { RENDERER_VERSION } from "./service-meta.ts";

export interface RenderConfig {
  sampleRate: 44100 | 48000; channels: 1 | 2; format: "pcm16" | "float32";
  normalize: "loudness" | "peak" | "off"; targetLufs?: number; tailSeconds?: number; includeMidi: boolean;
}
export const DEFAULT_RENDER_CONFIG: RenderConfig = { sampleRate: 44100, channels: 2, format: "pcm16", normalize: "loudness", tailSeconds: 3, includeMidi: true };
const TERMINAL: readonly string[] = ["completed", "failed", "cancelled"];

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

  constructor(private cfg: Config, private store: McpStore, private log: (o: object) => void = () => {}, private rendersPerDay: (owner: string) => number = () => cfg.mcp.maxRendersPerDay) {}

  async start(): Promise<void> {
    try {
      this.sfPath = resolveSoundFontPath(this.cfg);
      const entry = workerEntry();
      for (let i = 0; i < this.cfg.mcp.renderConcurrency; i++) await this.spawn(entry);
      this.executor = "worker";
    } catch (e) {
      this.log({ evt: "mcp_render_worker_fallback", message: (e as Error).message });
      this.executor = "inprocess";
      try { this.sfPath = resolveSoundFontPath(this.cfg); } catch { /* renders will fail with the same error, surfaced per job */ }
    }
    this.rehydrate();
  }
  /**
   * Resume jobs that were queued when the process stopped. Everything a job needs is durable (the
   * composition's stored revision snapshot + the job's config), so a queued job simply re-enters the
   * in-memory queue. A job whose composition/revision has vanished fails explicitly as JOB_ORPHANED.
   */
  private rehydrate() {
    if (this.stopped) return;
    let resumed = 0;
    for (const job of this.store.listJobsByStatus("queued")) {
      const row = this.store.getComposition(job.composition_id, job.owner);
      const rev = row ? this.store.getRevision(job.composition_id, job.owner, job.revision) : null;
      if (!row || !rev) {
        this.finish(job.id, "failed", JSON.stringify({ code: "JOB_ORPHANED", message: "queued render's composition or revision no longer exists after a restart; submit a new render" }));
        continue;
      }
      const stored = JSON.parse(job.config_json) as RenderConfig & { executor?: string; rendererVersion?: string };
      const { executor: _e, rendererVersion: _r, ...config } = stored;
      this.queue.push({ jobId: job.id, owner: job.owner, row, snapshot: JSON.parse(rev.project_json) as Project, config: { ...DEFAULT_RENDER_CONFIG, ...(config as RenderConfig) } });
      resumed++;
    }
    if (resumed) this.log({ evt: "mcp_render_rehydrated", jobs: resumed });
    this.pump();
  }
  async stop(): Promise<void> {
    this.stopped = true;
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
      if (this.stopped) return;
      const i = this.pool.indexOf(slot); if (i >= 0) this.pool.splice(i, 1);
      if (slot.jobId) this.failJob(slot.jobId, "WORKER_UNAVAILABLE", `render worker exited (code ${code}) mid-job; no artifact was published — resubmit to retry`);
      void this.spawn().then(() => this.pump()).catch((e) => this.log({ evt: "mcp_render_respawn_failed", message: (e as Error).message }));
    });
  }

  // ---- public API ---------------------------------------------------------------------
  submit(owner: string, row: CompositionRow, snapshot: Project, config: RenderConfig): RenderJobRow {
    const limit = this.rendersPerDay(owner);
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
      if (this.executor === "inprocess") { const job = this.queue.shift()!; void this.runInProcess(job); continue; }
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
    // Lost a race with cancel/timeout? The bytes are discarded and nothing is published.
    const cur = this.store.getJobAny(job.jobId);
    if (!cur || TERMINAL.includes(cur.status)) return;
    // Re-verify what the worker claims before anything is published.
    const sha = createHash("sha256").update(wavBytes).digest("hex");
    if (sha !== meta.sha256) throw new McpError("RENDER_FAILED", "rendered WAV failed SHA-256 verification against the worker's report; artifact discarded");
    const info = parseWavHeader(wavBytes.subarray(0, Math.min(wavBytes.length, 4096)), wavBytes.length);
    if (meta.validated !== true) throw new McpError("RENDER_FAILED", "renderer did not validate the WAV; artifact discarded");
    // Build EVERY payload before publishing anything: if MIDI export fails, the job fails with
    // zero artifacts instead of leaving a registered WAV behind for a failed job.
    let midi: Uint8Array | null = null;
    if (job.config.includeMidi) {
      midi = serializeSmf(job.snapshot, { soundNrpn: true });
      if (!(midi.length > 14 && String.fromCharCode(...midi.subarray(0, 4)) === "MThd")) throw new McpError("RENDER_FAILED", "MIDI export failed validation (missing MThd header); no artifacts were published for this job");
    }
    const base = { job_id: job.jobId, composition_id: job.row.id, owner: job.owner, revision: job.row.revision };
    const provenance = { rendererVersion: RENDERER_VERSION, sourceRevision: job.row.revision, soundFont: meta.soundFont, renderMs: meta.renderMs, executor: this.executor };
    const title = job.row.title.replace(/[^\w\- .]/g, "_").slice(0, 60) || "gbk";
    const rows: Parameters<McpStore["addArtifacts"]>[0] = [
      { ...base, kind: "wav", filename: `${title}.wav`, mime_type: "audio/wav",
        size_bytes: wavBytes.length, sha256: sha, rel_path: `${job.jobId}.wav`,
        meta_json: JSON.stringify({ validated: true, sampleRate: info.sampleRate, channels: info.channels, format: info.format, durationSeconds: info.durationSeconds,
          frames: info.frames, peakDbFS: meta.peakDbFS, rmsDbFS: meta.rmsDbFS, clippedSamples: meta.clippedSamples, loudness: meta.loudness, instruments: meta.instruments, warnings: meta.warnings, noteCount: meta.noteCount, ...provenance }) },
    ];
    const payloads: { rel: string; bytes: Uint8Array }[] = [{ rel: `${job.jobId}.wav`, bytes: wavBytes }];
    if (midi) {
      const soundOverrides = job.snapshot.sound?.tracks && Object.keys(job.snapshot.sound.tracks).length
        ? "project has SoundFont voice overrides: additive ones export as SF2 NRPNs; absolute/key-ranged overrides and global effects are audible in the WAV only" : undefined;
      rows.push({ ...base, kind: "midi", filename: `${title}.mid`, mime_type: "audio/midi",
        size_bytes: midi.length, sha256: createHash("sha256").update(midi).digest("hex"), rel_path: `${job.jobId}.mid`,
        meta_json: JSON.stringify({ validated: true, format: "SMF type 1", preserves: ["tempo map", "meter map", "program changes", "CC events", "pitch bend", "section markers"], ...(soundOverrides ? { portabilityNote: soundOverrides } : {}), ...provenance }) });
      payloads.push({ rel: `${job.jobId}.mid`, bytes: midi });
    }
    // Publish: files first (via tmp + rename), then all rows in one transaction, then completion.
    // If the transaction fails, the just-written files are removed again — no orphaned artifacts.
    mkdirSync(this.store.artifactsDir, { recursive: true });
    const written: string[] = [];
    try {
      for (const p of payloads) {
        const tmp = join(this.store.artifactsDir, `${p.rel}.tmp`);
        writeFileSync(tmp, p.bytes); renameSync(tmp, join(this.store.artifactsDir, p.rel));
        written.push(p.rel);
      }
      this.store.addArtifacts(rows);
    } catch (e) {
      for (const rel of written) try { rmSync(join(this.store.artifactsDir, rel), { force: true }); } catch { /* best effort */ }
      throw e;
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
    // Terminal states are final — only the first transition out of queued/running counts, so a late
    // worker exit, a racing completion or a timeout can never overwrite a cancelled/completed job.
    const moved = this.store.transitionJob(jobId, ["queued", "running"], { status, error, finished_at: Date.now(), ...(progress !== undefined ? { progress } : {}) });
    if (!moved) return;
    const waiters = this.waiters.get(jobId);
    if (waiters) {
      this.waiters.delete(jobId);
      for (const w of waiters) { const row = this.store.getJob(jobId, w.owner); if (row) w.fn(row); }
    }
  }
  private clearTimer(jobId: string) { const t = this.timers.get(jobId); if (t) { clearTimeout(t); this.timers.delete(jobId); } this.cancels.delete(jobId); }
}
