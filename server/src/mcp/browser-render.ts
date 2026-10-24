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

  async start() { /* nothing to warm up: synthesis lives in the browser */ }
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
      artifacts: artifacts.map((a) => ({ artifactId: a.id, kind: a.kind, filename: a.filename, mimeType: a.mime_type, sizeBytes: a.size_bytes, sha256: a.sha256, meta: JSON.parse(a.meta_json) })),
    };
  }

  private completeJob(a: Active, meta: Record<string, unknown>) {
    const wavBytes = new Uint8Array(readFileSync(a.partPath));
    if (meta.byteLength !== undefined && meta.byteLength !== wavBytes.length) throw new McpError("RENDER_FAILED", `upload incomplete (${wavBytes.length} of ${meta.byteLength} bytes); artifact discarded`);
    const sha = createHash("sha256").update(wavBytes).digest("hex");
    if (sha !== meta.sha256) throw new McpError("RENDER_FAILED", "uploaded WAV failed SHA-256 verification against the Studio's report; artifact discarded");
    if (meta.validated !== true) throw new McpError("RENDER_FAILED", "the renderer did not validate the WAV; artifact discarded");
    const info = parseWavHeader(wavBytes.subarray(0, Math.min(wavBytes.length, 4096)), wavBytes.length);
    const dir = this.store.artifactsDir;
    const write = (rel: string, bytes: Uint8Array) => { const tmp = join(dir, `${rel}.tmp`); writeFileSync(tmp, bytes); renameSync(tmp, join(dir, rel)); };
    const base = { job_id: a.jobId, composition_id: a.row.id, owner: a.owner, revision: a.row.revision };
    const wavRel = `${a.jobId}.wav`; renameSync(a.partPath, join(dir, wavRel));
    const provenance = { rendererVersion: RENDERER_VERSION, sourceRevision: a.row.revision, soundFont: meta.soundFont, renderMs: meta.renderMs, executor: this.executor };
    const fname = a.row.title.replace(/[^\w\- .]/g, "_").slice(0, 60) || "gbk";
    this.store.addArtifact({ ...base, kind: "wav", filename: `${fname}.wav`, mime_type: "audio/wav", size_bytes: wavBytes.length, sha256: sha, rel_path: wavRel,
      meta_json: JSON.stringify({ validated: true, sampleRate: info.sampleRate, channels: info.channels, format: info.format, durationSeconds: info.durationSeconds,
        frames: info.frames, peakDbFS: meta.peakDbFS, rmsDbFS: meta.rmsDbFS, clippedSamples: meta.clippedSamples, loudness: meta.loudness, instruments: meta.instruments, warnings: meta.warnings, noteCount: meta.noteCount, ...provenance }) });
    if (a.config.includeMidi) {
      const midi = serializeSmf(a.snapshot, { soundNrpn: true });
      if (!(midi.length > 14 && String.fromCharCode(...midi.subarray(0, 4)) === "MThd")) throw new McpError("RENDER_FAILED", "MIDI export failed validation (missing MThd header)");
      const midiRel = `${a.jobId}.mid`; write(midiRel, midi);
      const soundOverrides = a.snapshot.sound?.tracks && Object.keys(a.snapshot.sound.tracks).length
        ? "project has SoundFont voice overrides: additive ones export as SF2 NRPNs; absolute/key-ranged overrides and global effects are audible in the WAV only" : undefined;
      this.store.addArtifact({ ...base, kind: "midi", filename: `${fname}.mid`, mime_type: "audio/midi", size_bytes: midi.length, sha256: createHash("sha256").update(midi).digest("hex"), rel_path: midiRel,
        meta_json: JSON.stringify({ validated: true, format: "SMF type 1", preserves: ["tempo map", "meter map", "program changes", "CC events", "pitch bend", "section markers"], ...(soundOverrides ? { portabilityNote: soundOverrides } : {}), ...provenance }) });
    }
    this.finish(a.jobId, "completed", null, 1);
    this.log({ evt: "mcp_render_completed", user: a.owner, jobId: a.jobId, compositionId: a.row.id, revision: a.row.revision, bytes: wavBytes.length, sha256: sha });
  }
  private failJob(jobId: string, code: string, message: string) {
    this.finish(jobId, "failed", JSON.stringify({ code, message }));
    this.log({ evt: "mcp_render_failed", jobId, code, message });
  }
  private finish(jobId: string, status: "completed" | "failed" | "cancelled", error: string | null, progress?: number) {
    const a = this.active.get(jobId);
    if (a) { clearTimeout(a.timer); this.active.delete(jobId); try { if (existsSync(a.partPath)) rmSync(a.partPath); } catch { /* gone */ } }
    this.store.patchJob(jobId, { status, error, finished_at: Date.now(), ...(progress !== undefined ? { progress } : {}) });
    const waiters = this.waiters.get(jobId);
    if (waiters) { this.waiters.delete(jobId); for (const w of waiters) { const row = this.store.getJob(jobId, w.owner); if (row) w.fn(row); } }
  }
}
