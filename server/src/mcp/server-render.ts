// Headless server-side rendering: a small pool of worker threads (render-worker.ts) running the app's own SF2
// offline renderer, so the event loop never blocks. Used when an MCP client has no connected Studio tab (Codex,
// guests, any browserless client) or asks for headless. Off switch: SERVER_RENDER=0.
// Limits: bounded queue, fixed concurrency, one queued/running server render per owner, hard per-job timeout
// (the worker is terminated and replaced), worker heap cap.
import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.ts";
import type { Project } from "../../../src/workstation/model.ts";
import type { OfflineRenderOptions } from "../../../src/audio/offline-renderer.ts";
import { McpError } from "./errors.ts";

/** Job failure with a stable code (renderer codes such as RENDER_TOO_LARGE pass through). */
export type RenderFailure = Error & { code: string };
const fail = (code: string, message: string): RenderFailure => Object.assign(new Error(message), { code });

export interface ServerRenderResult { bytes: Uint8Array; meta: Record<string, unknown> }
interface Task { jobId: string; owner: string; project: Project; options: OfflineRenderOptions; resolve: (r: ServerRenderResult) => void; reject: (e: RenderFailure) => void; onProgress: (x: number) => void }
interface Slot { w: Worker; task?: Task; timer?: NodeJS.Timeout }

function workerEntry(): { url: URL | string; eval?: boolean } {
  const here = dirname(fileURLToPath(import.meta.url));
  const mjs = join(here, "render-worker.mjs"); // production bundle (server/dist)
  if (existsSync(mjs)) return { url: new URL(`file://${mjs}`) };
  const ts = join(here, "render-worker.ts"); // dev/tests: run the TypeScript source through tsx
  if (existsSync(ts)) return { eval: true, url: `import("tsx/esm/api").then((m) => { m.register(); return import(${JSON.stringify(`file://${ts}`)}); });` };
  throw new McpError("RENDER_FAILED", "render worker entry not found (render-worker.mjs / .ts)");
}

export class ServerRenderPool {
  private slots: Slot[] = [];
  private queue: Task[] = [];
  private stopped = false;
  soundFont: Record<string, unknown> | null = null;
  constructor(private cfg: Config, private soundFontPath: () => string, private log: (o: object) => void = () => {}) {}

  get enabled() { return this.cfg.serverRender.enabled; }
  /** Queued + running tasks for this owner (limit: one at a time per user / guest project). */
  inFlight(owner: string) { return this.queue.filter((t) => t.owner === owner).length + this.slots.filter((s) => s.task?.owner === owner).length; }
  depth() { return this.queue.length + this.slots.filter((s) => s.task).length; }

  /** Spawn the workers and load the SoundFont in each (fails loudly in the log, renders then fail per job). */
  private starting: Promise<void> | null = null;
  start(): Promise<void> {
    if (!this.enabled || this.stopped) return Promise.resolve();
    return this.starting ??= (async () => {
      for (let i = this.slots.length; i < this.cfg.serverRender.concurrency; i++) {
        try { await this.spawn(); } catch (e) { this.log({ evt: "server_render_worker_failed", message: (e as Error).message }); }
      }
      this.starting = null;
      if (!this.slots.length) for (const t of this.queue.splice(0)) t.reject(fail("WORKER_UNAVAILABLE", "the server renderer could not start (SoundFont or worker failed to load); try again later"));
    })();
  }
  async stop() {
    this.stopped = true;
    for (const t of this.queue.splice(0)) t.reject(fail("SERVER_STOPPING", "server restarted before this render ran; submit the render again"));
    await Promise.all(this.slots.map(async (s) => { clearTimeout(s.timer); s.task?.reject(fail("SERVER_STOPPING", "server restarted mid-render; submit the render again")); await s.w.terminate().catch(() => 0); }));
    this.slots = [];
  }

  private spawn(): Promise<void> {
    const entry = workerEntry();
    const w = new Worker(entry.url, { ...(entry.eval ? { eval: true } : {}), resourceLimits: { maxOldGenerationSizeMb: this.cfg.serverRender.workerHeapMb } });
    const slot: Slot = { w };
    return new Promise<void>((resolve, reject) => {
      const onInit = (m: { type: string; message?: string; soundFont?: Record<string, unknown> }) => {
        if (m.type === "ready") { w.off("message", onInit); this.soundFont = m.soundFont ?? null; this.slots.push(slot); this.log({ evt: "server_render_worker_ready", soundFont: m.soundFont }); this.pump(); resolve(); }
        if (m.type === "init-error") { w.off("message", onInit); void w.terminate(); reject(new Error(m.message)); }
      };
      w.on("message", onInit);
      w.once("error", (e) => reject(e));
      w.on("message", (m: { type: string; jobId?: string; progress?: number; meta?: Record<string, unknown>; bytes?: ArrayBuffer; code?: string; message?: string }) => {
        const t = slot.task; if (!t || m.jobId !== t.jobId) return;
        if (m.type === "progress") { t.onProgress(m.progress ?? 0); return; }
        if (m.type === "done" || m.type === "error") {
          clearTimeout(slot.timer); slot.task = undefined;
          if (m.type === "done") t.resolve({ bytes: new Uint8Array(m.bytes!), meta: m.meta! });
          else t.reject(fail(m.code ?? "RENDER_FAILED", m.message ?? "render failed"));
          this.pump();
        }
      });
      w.on("exit", (code) => {
        const i = this.slots.indexOf(slot); if (i >= 0) this.slots.splice(i, 1);
        if (slot.task) { clearTimeout(slot.timer); slot.task.reject(fail("RENDER_FAILED", `render worker exited (code ${code}) mid-job; no artifact was published`)); slot.task = undefined; }
        if (!this.stopped) void this.spawn().then(() => this.pump()).catch((e) => this.log({ evt: "server_render_respawn_failed", message: (e as Error).message }));
      });
      w.postMessage({ type: "init", soundFontPath: this.soundFontPath() });
    });
  }

  /** Admission checks happen in the caller (RenderService); this enforces the queue bound and runs the job. */
  run(jobId: string, owner: string, project: Project, options: OfflineRenderOptions, onProgress: (x: number) => void): Promise<ServerRenderResult> {
    if (!this.enabled) return Promise.reject(fail("WORKER_UNAVAILABLE", "server rendering is turned off (SERVER_RENDER=0)"));
    if (this.depth() >= this.cfg.serverRender.concurrency + this.cfg.serverRender.maxQueue) return Promise.reject(fail("QUOTA_EXCEEDED", "the server render queue is full; retry in a minute"));
    return new Promise((resolve, reject) => {
      this.queue.push({ jobId, owner, project, options, resolve, reject, onProgress });
      if (this.slots.length < this.cfg.serverRender.concurrency) void this.start(); // lazy: workers spawn on first use
      this.pump();
    });
  }
  cancel(jobId: string) {
    const qi = this.queue.findIndex((t) => t.jobId === jobId);
    if (qi >= 0) { this.queue.splice(qi, 1)[0].reject(fail("OPERATION_CANCELLED", "cancelled")); return; }
    const s = this.slots.find((x) => x.task?.jobId === jobId);
    if (s) void s.w.terminate(); // exit handler rejects + respawns
  }
  private pump() {
    if (this.stopped) return;
    for (const slot of this.slots) {
      if (slot.task || !this.queue.length) continue;
      const t = this.queue.shift()!; slot.task = t;
      slot.timer = setTimeout(() => {
        if (slot.task !== t) return;
        slot.task = undefined;
        t.reject(fail("RENDER_TIMEOUT", `server render exceeded ${this.cfg.serverRender.timeoutMs} ms and was stopped; no artifact was published`));
        void slot.w.terminate();
      }, this.cfg.serverRender.timeoutMs);
      slot.timer.unref?.();
      slot.w.postMessage({ type: "render", jobId: t.jobId, project: t.project, options: t.options });
    }
  }
}
