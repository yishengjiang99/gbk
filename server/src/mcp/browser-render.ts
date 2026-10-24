// RenderService: MCP render jobs executed in the user's connected GBK Studio tab, never on the server.
//
// The server holds durable job state and the pinned snapshot; synthesis happens in the browser with the same
// canonical offline renderer the Studio uses. Flow:
//   submit -> no connected, ready Studio tab for this account?  -> { studioRequired, studioUrl } (no job created)
//          -> job row (executor "browser") + bridge tool_call `gbk_mcp_render_job` { jobId, token, snapshotUrl, uploadUrl, options }
//   tab    -> GET snapshotUrl, renders offline, PUTs the WAV in chunks to uploadUrl (capability token), replies with metadata
//   server -> verifies SHA-256 + WAV header + `validated`, writes artifacts (WAV + server-serialized SMF), completes the job.
// A tab that disconnects, times out or reports an error fails the job explicitly; no partial artifact is ever published.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, writeFileSync, renameSync, mkdirSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.ts";
import type { Project } from "../../../src/workstation/model.ts";
import { serializeSmf } from "../../../src/workstation/smf.ts";
import { parseWavHeader } from "../../../src/audio/audio-validation.ts";
import { McpStore, type RenderJobRow, type CompositionRow } from "./store.ts";
import { McpError } from "./errors.ts";
import { RENDERER_VERSION } from "./service-meta.ts";
import { signArtifactUrl } from "./urls.ts";

export interface RenderConfig {
  sampleRate: 44100 | 48000; channels: 1 | 2; format: "pcm16" | "float32";
  normalize: "loudness" | "peak" | "off"; targetLufs?: number; tailSeconds?: number; includeMidi: boolean;
}
export const DEFAULT_RENDER_CONFIG: RenderConfig = { sampleRate: 44100, channels: 2, format: "pcm16", normalize: "loudness", tailSeconds: 3, includeMidi: true };
export const BROWSER_RENDER_TOOL = "gbk_mcp_render_job";
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** The bundled SoundFont (read server-side only for preset/instrument metadata, never for synthesis). */
export function resolveSoundFontPath(cfg: Config): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [cfg.mcp.soundFontPath, join(process.cwd(), "dist", "static", "GeneralUser-GS.sf2"), join(process.cwd(), "public", "static", "GeneralUser-GS.sf2"),
    join(here, "..", "..", "..", "dist", "static", "GeneralUser-GS.sf2"), join(here, "..", "..", "..", "public", "static", "GeneralUser-GS.sf2")].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new McpError("NOT_FOUND", `bundled SoundFont not found; set GBK_SOUNDFONT_PATH (tried: ${candidates.join(", ")})`);
}

/** A built in-chat player asset (scripts/build-widget.mjs -> server/dist/widget/), next to the bundle or in the checkout. */
export function resolveWidgetAsset(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "widget", file), join(process.cwd(), "server", "dist", "widget", file), join(here, "..", "..", "dist", "widget", file)];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new McpError("NOT_FOUND", `widget asset ${file} not built (run node scripts/build-widget.mjs)`);
}

/** What the render service needs from the browser bridge: the account's live Studio tab, if any. */
export interface StudioLink {
  ready: boolean;
  callTool(runId: string, callId: string, tool: string, args: Record<string, unknown>, opts: { expectProjectId: string | null; consent: { newProject: boolean }; timeoutMs: number }): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
}
export type StudioLookup = (user: string) => StudioLink | null;

interface Active { jobId: string; owner: string; row: CompositionRow; snapshot: Project; config: RenderConfig; tokenHash: Buffer; partPath: string; received: number; timer?: NodeJS.Timeout }
type Waiter = (job: RenderJobRow) => void;
const hash = (t: string) => createHash("sha256").update(t).digest();

export class RenderService {
  readonly executor = "browser";
  private active = new Map<string, Active>();
  private waiters = new Map<string, Set<{ owner: string; fn: Waiter }>>();
  constructor(private cfg: Config, private store: McpStore, private studio: StudioLookup, private log: (o: object) => void = () => {},
    private rendersPerDay: (owner: string) => number = () => cfg.mcp.maxRendersPerDay) {}

  /** Jobs still queued from before a restart lost their Studio-tab handoff: fail them explicitly (never stuck). */
  async start() {
    for (const j of this.store.listJobsByStatus("queued")) this.failJob(j.id, "JOB_INTERRUPTED", "the server restarted before this render reached a Studio tab; submit the render again");
  }
  async stop() { for (const a of [...this.active.values()]) this.failJob(a.jobId, "SERVER_STOPPING", "server restarted mid-render; submit the render again"); }

  studioUrl(compositionId?: string) { void compositionId; return `${this.cfg.publicOrigin}/studio`; }

  /** Start a render in the user's Studio tab, or report that a tab must be opened first. */
  submit(owner: string, row: CompositionRow, snapshot: Project, config: RenderConfig): { job: RenderJobRow } | { studioRequired: true; studioUrl: string } {
    const limit = this.rendersPerDay(owner);
    if (this.store.countJobsSince(owner, 86_400_000) >= limit) throw new McpError("QUOTA_EXCEEDED", `daily render limit reached (${limit})`);
    const link = this.studio(owner);
    if (!link || !link.ready) return { studioRequired: true, studioUrl: this.studioUrl(row.id) };
    const job = this.store.createJob({ compositionId: row.id, owner, revision: row.revision, config: { ...config, executor: this.executor, rendererVersion: RENDERER_VERSION } });
    const token = randomBytes(24).toString("base64url");
    mkdirSync(this.store.artifactsDir, { recursive: true });
    const a: Active = { jobId: job.id, owner, row, snapshot: structuredClone(snapshot), config, tokenHash: hash(token), partPath: join(this.store.artifactsDir, `${job.id}.wav.part`), received: 0 };
    writeFileSync(a.partPath, new Uint8Array(0));
    this.active.set(job.id, a);
    this.store.patchJob(job.id, { status: "running", progress: 0 });
    a.timer = setTimeout(() => this.failJob(job.id, "RENDER_TIMEOUT", `the Studio tab did not finish within ${this.cfg.mcp.renderTimeoutMs} ms; no artifact was published`), this.cfg.mcp.renderTimeoutMs);
    a.timer.unref?.();
    const base = `${this.cfg.publicOrigin}/api/mcp/render-jobs/${job.id}`;
    const options = { sampleRate: config.sampleRate, channels: config.channels, format: config.format, normalize: config.normalize, targetLufs: config.targetLufs, tailSeconds: config.tailSeconds ?? 3, maxSeconds: this.cfg.mcp.maxRenderSeconds };
    link.callTool(`mcp_${job.id}`, `call_${randomBytes(6).toString("hex")}`, BROWSER_RENDER_TOOL,
      { jobId: job.id, token, snapshotUrl: `${base}/snapshot`, uploadUrl: `${base}/wav`, chunkBytes: UPLOAD_CHUNK_BYTES, options },
      { expectProjectId: null, consent: { newProject: false }, timeoutMs: this.cfg.mcp.renderTimeoutMs })
      .then((r) => {
        if (!this.active.has(job.id)) return; // cancelled / timed out meanwhile
        if (!r.ok) return this.failJob(job.id, r.error?.code ?? "RENDER_FAILED", r.error?.message ?? "the Studio tab reported a render failure");
        try { this.completeJob(a, (r.data ?? {}) as Record<string, unknown>); } catch (e) { this.failJob(job.id, (e as McpError).code ?? "RENDER_FAILED", (e as Error).message); }
      })
      .catch((e: { code?: string; message?: string }) => { if (this.active.has(job.id)) this.failJob(job.id, e.code ?? "BROWSER_DISCONNECTED", `the Studio tab went away mid-render (${e.message ?? "disconnected"}); open the Studio and render again`); });
    this.log({ evt: "mcp_render_dispatched", user: owner, jobId: job.id, compositionId: row.id, revision: row.revision });
    return { job: this.store.getJob(job.id, owner)! };
  }

  /**
   * Guest (account-free) render request. There is no account to route a Studio tab to, and the server never
   * synthesizes, so this records a job, publishes the server-serialized MIDI (validated SMF; no audio), and
   * leaves audio to the browser: the in-chat player or a Studio tab opened from the private read-only link.
   */
  midiOnlyJob(owner: string, row: CompositionRow, snapshot: Project, config: RenderConfig, midi: Uint8Array, perDay: number): RenderJobRow {
    if (this.store.countJobsSince(owner, 86_400_000) >= perDay) throw new McpError("QUOTA_EXCEEDED", `daily render request limit for this project reached (${perDay})`);
    const job = this.store.createJob({ compositionId: row.id, owner, revision: row.revision, config: { ...config, includeMidi: true, executor: "browser-handoff", rendererVersion: RENDERER_VERSION } });
    mkdirSync(this.store.artifactsDir, { recursive: true });
    const rel = `${job.id}.mid`, tmp = join(this.store.artifactsDir, `${rel}.tmp`);
    writeFileSync(tmp, midi); renameSync(tmp, join(this.store.artifactsDir, rel));
    const fname = row.title.replace(/[^\w\- .]/g, "_").slice(0, 60) || "gbk";
    try {
      this.store.addArtifacts([{ job_id: job.id, composition_id: row.id, owner, revision: row.revision, kind: "midi", filename: `${fname}.mid`, mime_type: "audio/midi",
        size_bytes: midi.length, sha256: createHash("sha256").update(midi).digest("hex"), rel_path: rel,
        meta_json: JSON.stringify({ validated: true, format: "SMF type 1", preserves: ["tempo map", "meter map", "program changes", "CC events", "pitch bend", "section markers"], rendererVersion: RENDERER_VERSION, sourceRevision: row.revision, audio: "browser-only" }) }]);
    } catch (e) { try { rmSync(join(this.store.artifactsDir, rel)); } catch { /* gone */ } this.failJob(job.id, "RENDER_FAILED", (e as Error).message); throw e; }
    this.finish(job.id, "completed", null, 1);
    this.log({ evt: "mcp_guest_midi_export", jobId: job.id, compositionId: row.id, revision: row.revision, bytes: midi.length });
    void snapshot;
    return this.store.getJob(job.id, owner)!;
  }

  /**
   * Start a render that the ChatGPT in-chat player (MCP Apps widget, ui.ts) performs in the user's browser - no Studio
   * tab or sign-in needed there. Same job row, capability token, snapshot/upload endpoints and validation as the Studio
   * path; the widget reports completion with finishWidget(). The server still never synthesizes audio.
   */
  submitWidget(owner: string, row: CompositionRow, snapshot: Project, config: RenderConfig, perDay?: number) {
    const limit = perDay ?? this.rendersPerDay(owner);
    if (this.store.countJobsSince(owner, 86_400_000) >= limit) throw new McpError("QUOTA_EXCEEDED", `daily render limit reached (${limit})`);
    const job = this.store.createJob({ compositionId: row.id, owner, revision: row.revision, config: { ...config, executor: "widget", rendererVersion: RENDERER_VERSION } });
    const token = randomBytes(24).toString("base64url");
    mkdirSync(this.store.artifactsDir, { recursive: true });
    const a: Active = { jobId: job.id, owner, row, snapshot: structuredClone(snapshot), config, tokenHash: hash(token), partPath: join(this.store.artifactsDir, `${job.id}.wav.part`), received: 0 };
    writeFileSync(a.partPath, new Uint8Array(0));
    this.active.set(job.id, a);
    this.store.patchJob(job.id, { status: "running", progress: 0 });
    a.timer = setTimeout(() => this.failJob(job.id, "RENDER_TIMEOUT", `the in-chat player did not finish within ${this.cfg.mcp.renderTimeoutMs} ms; no artifact was published`), this.cfg.mcp.renderTimeoutMs);
    a.timer.unref?.();
    const base = `${this.cfg.publicOrigin}/api/mcp/render-jobs/${job.id}`;
    const options = { sampleRate: config.sampleRate, channels: config.channels, format: config.format, normalize: config.normalize, targetLufs: config.targetLufs, tailSeconds: config.tailSeconds ?? 3, maxSeconds: this.cfg.mcp.maxRenderSeconds };
    this.log({ evt: "mcp_widget_render_started", user: owner, jobId: job.id, compositionId: row.id, revision: row.revision });
    return { job: this.store.getJob(job.id, owner)!, token, snapshotUrl: `${base}/snapshot`, uploadUrl: `${base}/wav`, chunkBytes: UPLOAD_CHUNK_BYTES, options };
  }

  /** The in-chat player's report for a widget job: verify + publish the uploaded WAV (and server-side MIDI), or fail it. */
  finishWidget(owner: string, jobId: string, token: string, result: { ok: true; meta: Record<string, unknown> } | { ok: false; code: string; message: string }): RenderJobRow {
    const a = this.auth(jobId, token);
    if (a.owner !== owner) throw new McpError("NOT_FOUND", "no such active render job");
    if (!result.ok) { this.failJob(jobId, result.code === "OPERATION_CANCELLED" ? "OPERATION_CANCELLED" : (result.code || "RENDER_FAILED"), result.message.slice(0, 500)); return this.status(owner, jobId); }
    try { this.completeJob(a, result.meta); } catch (e) { this.failJob(jobId, (e as McpError).code ?? "RENDER_FAILED", (e as Error).message); }
    return this.status(owner, jobId);
  }

  // ---- endpoints the Studio tab calls (capability token = proof it was handed this job) ----
  private auth(jobId: string, token: unknown): Active {
    const a = this.active.get(jobId);
    const got = typeof token === "string" ? hash(token) : Buffer.alloc(32);
    if (!a || !timingSafeEqual(got, a.tokenHash)) throw new McpError("NOT_FOUND", "no such active render job");
    return a;
  }
  snapshotFor(jobId: string, token: unknown) { const a = this.auth(jobId, token); return { jobId, revision: a.row.revision, project: a.snapshot }; }
  acceptChunk(jobId: string, token: unknown, offset: number, bytes: Uint8Array) {
    const a = this.auth(jobId, token);
    if (offset !== a.received) throw new McpError("INVALID_ARGUMENT", `expected offset ${a.received}`);
    const max = this.cfg.mcp.maxRenderSeconds * 48000 * 2 * 4 + 4096;
    if (a.received + bytes.length > max) throw new McpError("QUOTA_EXCEEDED", "upload exceeds the maximum render size");
    appendFileSync(a.partPath, bytes); a.received += bytes.length;
    this.store.patchJob(jobId, { progress: 0.5 });
    return { received: a.received };
  }

  status(owner: string, jobId: string): RenderJobRow {
    const j = this.store.getJob(jobId, owner);
    if (!j) throw new McpError("NOT_FOUND", "no such render job for this account");
    return j;
  }
  cancel(owner: string, jobId: string): RenderJobRow {
    const j = this.status(owner, jobId);
    if (["completed", "failed", "cancelled"].includes(j.status)) return j;
    this.finish(jobId, "cancelled", null);
    return this.status(owner, jobId);
  }
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
      artifacts: artifacts.map((a) => { const s = signArtifactUrl(this.cfg, a.id); return { artifactId: a.id, kind: a.kind, filename: a.filename, mimeType: a.mime_type, sizeBytes: a.size_bytes, sha256: a.sha256, downloadUrl: s.url, downloadUrlExpiresAt: s.expiresAt, meta: JSON.parse(a.meta_json) }; }),
    };
  }

  private completeJob(a: Active, meta: Record<string, unknown>) {
    if (this.store.getJobAny(a.jobId)?.status !== "running") return; // already terminal (cancelled / timed out)
    const wavBytes = new Uint8Array(readFileSync(a.partPath));
    if (meta.byteLength !== undefined && meta.byteLength !== wavBytes.length) throw new McpError("RENDER_FAILED", `upload incomplete (${wavBytes.length} of ${meta.byteLength} bytes); artifact discarded`);
    const sha = createHash("sha256").update(wavBytes).digest("hex");
    if (sha !== meta.sha256) throw new McpError("RENDER_FAILED", "uploaded WAV failed SHA-256 verification against the Studio's report; artifact discarded");
    if (meta.validated !== true) throw new McpError("RENDER_FAILED", "the renderer did not validate the WAV; artifact discarded");
    const info = parseWavHeader(wavBytes.subarray(0, Math.min(wavBytes.length, 4096)), wavBytes.length);
    const dir = this.store.artifactsDir;
    const write = (rel: string, bytes: Uint8Array) => { const tmp = join(dir, `${rel}.tmp`); writeFileSync(tmp, bytes); renameSync(tmp, join(dir, rel)); };
    const base = { job_id: a.jobId, composition_id: a.row.id, owner: a.owner, revision: a.row.revision };
    const wavRel = `${a.jobId}.wav`;
    const executor = (JSON.parse(this.store.getJobAny(a.jobId)?.config_json ?? "{}") as { executor?: string }).executor ?? this.executor;
    const provenance = { rendererVersion: RENDERER_VERSION, sourceRevision: a.row.revision, soundFont: meta.soundFont, renderMs: meta.renderMs, executor };
    const fname = a.row.title.replace(/[^\w\- .]/g, "_").slice(0, 60) || "gbk";
    const rows: Parameters<McpStore["addArtifacts"]>[0] = [{ ...base, kind: "wav", filename: `${fname}.wav`, mime_type: "audio/wav", size_bytes: wavBytes.length, sha256: sha, rel_path: wavRel,
      meta_json: JSON.stringify({ validated: true, sampleRate: info.sampleRate, channels: info.channels, format: info.format, durationSeconds: info.durationSeconds,
        frames: info.frames, peakDbFS: meta.peakDbFS, rmsDbFS: meta.rmsDbFS, clippedSamples: meta.clippedSamples, loudness: meta.loudness, instruments: meta.instruments, warnings: meta.warnings, noteCount: meta.noteCount, ...provenance }) }];
    // Build + validate every payload before writing anything; rows land in one transaction after the files.
    let midi: Uint8Array | null = null;
    if (a.config.includeMidi) {
      midi = serializeSmf(a.snapshot, { soundNrpn: true });
      if (!(midi.length > 14 && String.fromCharCode(...midi.subarray(0, 4)) === "MThd")) throw new McpError("RENDER_FAILED", "MIDI export failed validation (missing MThd header)");
      const soundOverrides = a.snapshot.sound?.tracks && Object.keys(a.snapshot.sound.tracks).length
        ? "project has SoundFont voice overrides: additive ones export as SF2 NRPNs; absolute/key-ranged overrides and global effects are audible in the WAV only" : undefined;
      rows.push({ ...base, kind: "midi", filename: `${fname}.mid`, mime_type: "audio/midi", size_bytes: midi.length, sha256: createHash("sha256").update(midi).digest("hex"), rel_path: `${a.jobId}.mid`,
        meta_json: JSON.stringify({ validated: true, format: "SMF type 1", preserves: ["tempo map", "meter map", "program changes", "CC events", "pitch bend", "section markers"], ...(soundOverrides ? { portabilityNote: soundOverrides } : {}), ...provenance }) });
    }
    renameSync(a.partPath, join(dir, wavRel));
    if (midi) write(`${a.jobId}.mid`, midi);
    try { this.store.addArtifacts(rows); }
    catch (e) { for (const r of rows) { try { rmSync(join(dir, r.rel_path)); } catch { /* gone */ } } throw e; }
    this.finish(a.jobId, "completed", null, 1);
    this.log({ evt: "mcp_render_completed", user: a.owner, jobId: a.jobId, compositionId: a.row.id, revision: a.row.revision, bytes: wavBytes.length, sha256: sha, executor });
  }
  private failJob(jobId: string, code: string, message: string) {
    this.finish(jobId, "failed", JSON.stringify({ code, message }));
    this.log({ evt: "mcp_render_failed", jobId, code, message });
  }
  private finish(jobId: string, status: "completed" | "failed" | "cancelled", error: string | null, progress?: number) {
    const a = this.active.get(jobId);
    if (a) { clearTimeout(a.timer); this.active.delete(jobId); try { if (existsSync(a.partPath)) rmSync(a.partPath); } catch { /* gone */ } }
    // Terminal states are final: a late tab reply, timeout or cancel never overwrites one.
    if (!this.store.transitionJob(jobId, ["queued", "running"], { status, error, finished_at: Date.now(), ...(progress !== undefined ? { progress } : {}) })) return;
    const waiters = this.waiters.get(jobId);
    if (waiters) { this.waiters.delete(jobId); for (const w of waiters) { const row = this.store.getJob(jobId, w.owner); if (row) w.fn(row); } }
  }
}
