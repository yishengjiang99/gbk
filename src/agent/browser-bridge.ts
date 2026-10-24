// Browser-resident tool executor for the server-hosted Composer agent. Executes ONE gbk_* tool per server request
// through the canonical registry (buildAllTools) + runTool() validation, i.e. the same handlers as WebMCP and
// window.gbkTools. No eval, no string injection, no Playwright/CDP: typed module imports only.
import type { WorkstationController } from "../workstation/controller.ts";
import { buildAllTools } from "../webmcp/registry.ts";
import { runTool, type ToolDef } from "../webmcp/tools.ts";
import { policyFor } from "./tool-policy.ts";
import { composerManifest } from "./tool-manifest.ts";
import { MAX_FRAME_BYTES, type ServerMessage, type ToolResultEnvelope } from "./protocol.ts";
import { renderProjectOffline, type OfflineRenderOptions } from "../audio/offline-renderer.ts";
import type { Project } from "../workstation/model.ts";
import { reportError } from "../telemetry/error-reporter.ts";
import { renderJobs } from "../audio/render-job.ts";

/** Server-issued render of a stored MCP composition (ChatGPT / Codex / plugin). Not an agent tool: the LLM never sees it. */
export const MCP_RENDER_TOOL = "gbk_mcp_render_job";
export interface McpRenderDeps {
  /** HTTP to this page's origin (tests inject a base URL); defaults to fetch. */
  http?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Pre-loaded SoundFont (tests); the Studio loads GeneralUser GS itself. */
  soundFont?: Parameters<typeof renderProjectOffline>[4] extends infer D ? D extends { soundFont?: infer S } ? S : never : never;
}

type ToolCall = Extract<ServerMessage, { type: "tool_call" }>;

export class BrowserToolBridge {
  readonly tools: Map<string, ToolDef>;
  readonly manifest: ReturnType<typeof composerManifest>;
  private mutationChain: Promise<unknown> = Promise.resolve();
  private inflight = new Map<string, AbortController>();
  private seen = new Map<string, Promise<ToolResultEnvelope>>(); // duplicate tool_call -> same result, never re-executed
  /** Project the current conversation is bound to; results from another project are never applied. */
  boundProjectId: string | null = null;

  constructor(private c: WorkstationController, tools: ToolDef[] = buildAllTools(c), private renderDeps: McpRenderDeps = {}) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.manifest = composerManifest(tools);
  }

  private fail(code: string, message: string): ToolResultEnvelope {
    return { ok: false, projectId: this.c.project.id, revision: this.c.project.revision, warnings: [], error: { code, message } };
  }

  /** Execute a server tool_call. Returns the envelope to send back (never throws). */
  execute(msg: ToolCall, sessionId: string, onProgress?: (p: number, d?: string) => void): Promise<ToolResultEnvelope> {
    const key = `${msg.runId}:${msg.callId}`;
    const dup = this.seen.get(key);
    if (dup) return dup;
    const p = this.run(msg, sessionId, onProgress);
    this.seen.set(key, p);
    if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value as string);
    return p;
  }

  private async run(msg: ToolCall, sessionId: string, onProgress?: (p: number, d?: string) => void): Promise<ToolResultEnvelope> {
    if (msg.sessionId !== sessionId) return this.fail("SESSION_MISMATCH", "tool call for another session");
    if (msg.tool === MCP_RENDER_TOOL) return this.mcpRender(msg);
    const pol = policyFor(msg.tool); const tool = this.tools.get(msg.tool);
    if (!pol || !tool) return this.fail("TOOL_NOT_ALLOWED", `${msg.tool} is not available to the Composer agent`);
    if (pol.createsProject && !msg.consent?.newProject) return this.fail("CONSENT_REQUIRED", "creating a project needs a user prompt in this conversation");
    const args = { ...(msg.arguments ?? {}), ...(pol.force ?? {}) };
    const exec = async (): Promise<ToolResultEnvelope> => {
      if (msg.expectProjectId && this.c.project.id !== msg.expectProjectId && !pol.createsProject)
        return this.fail("PROJECT_CHANGED", `the open project changed (expected ${msg.expectProjectId}, now ${this.c.project.id}); re-read the project before editing`);
      const ac = new AbortController(); this.inflight.set(msg.callId, ac);
      // Finish (with a clear error) a few seconds BEFORE the server gives up on this call, so the agent sees why.
      const deadline = Math.max(1000, (msg.deadlineMs || 120_000) - (pol.cls === "render" ? 5000 : 0));
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ac.abort(); }, deadline);
      let stopProg: (() => void) | undefined;
      if (pol.cls === "render" && onProgress) {
        // Real progress of the in-page OfflineAudioContext render job, plus a heartbeat while nothing changes.
        let last = "rendering";
        const unsub = renderJobs().subscribe((j) => { last = `${j.status} ${Math.round(j.progress * 100)}%`; onProgress(j.progress, last); });
        const iv = setInterval(() => onProgress(-1, last), 5000); stopProg = () => { clearInterval(iv); unsub(); };
      }
      try {
        const r = await runTool(this.c, tool, args, ac.signal);
        if (!r.ok && timedOut) return { ...this.fail(pol.cls === "render" ? "RENDER_TIMEOUT" : "TOOL_TIMEOUT", `${msg.tool} did not finish within ${Math.round(deadline / 1000)} s in the browser and was cancelled${pol.cls === "render" ? " (the render runs in this tab's OfflineAudioContext; try a shorter range or mono)" : ""}`), revision: r.revision };
        if (r.ok && pol.createsProject) this.boundProjectId = r.projectId;
        const { content: _drop, ...env } = r; // binary content never leaves the page through the Composer bridge
        const text = JSON.stringify(env);
        if (text.length > MAX_FRAME_BYTES - 4096) return { ...this.fail("RESULT_TOO_LARGE", `result is ${text.length} bytes; use pagination (offset/limit) or a narrower range`), revision: r.revision };
        return env;
      } finally { clearTimeout(timer); stopProg?.(); this.inflight.delete(msg.callId); }
    };
    if (pol.cls === "read") return exec();
    // one mutation sequence per page/project: serialize all mutations
    const next = this.mutationChain.then(exec, exec);
    this.mutationChain = next.catch(() => undefined);
    return next;
  }

  /** Render a server-pinned composition snapshot in this tab and upload the WAV. Never touches the open project. */
  private async mcpRender(msg: ToolCall): Promise<ToolResultEnvelope> {
    const a = (msg.arguments ?? {}) as { jobId?: string; token?: string; snapshotUrl?: string; uploadUrl?: string; chunkBytes?: number; options?: OfflineRenderOptions };
    const http = this.renderDeps.http ?? ((u: string, i?: RequestInit) => fetch(u, { credentials: "same-origin", ...i }));
    const sameOrigin = (u?: string) => { try { return typeof location === "undefined" || new URL(u!, location.href).origin === location.origin; } catch { return false; } };
    if (!a.jobId || !a.token || !a.snapshotUrl || !a.uploadUrl || !a.options || !sameOrigin(a.snapshotUrl) || !sameOrigin(a.uploadUrl)) return this.fail("INVALID_ARGUMENT", "malformed render job");
    const ac = new AbortController(); this.inflight.set(msg.callId, ac);
    const timer = setTimeout(() => ac.abort(), Math.max(1000, msg.deadlineMs || 300_000));
    const hdr = { "x-gbk-render-token": a.token };
    try {
      const snap = await http(a.snapshotUrl, { headers: hdr, signal: ac.signal });
      if (!snap.ok) return this.fail("NOT_FOUND", `render snapshot unavailable (HTTP ${snap.status})`);
      const { project } = (await snap.json()) as { project: Project };
      const r = await renderProjectOffline(project, a.options, ac.signal, undefined, this.renderDeps.soundFont ? { soundFont: this.renderDeps.soundFont } : {});
      const step = Math.max(64 * 1024, Math.min(a.chunkBytes ?? 8 << 20, 8 << 20));
      for (let off = 0; off < r.bytes.length; off += step) {
        const part = r.bytes.subarray(off, Math.min(off + step, r.bytes.length));
        const up = await http(`${a.uploadUrl}?offset=${off}`, { method: "PUT", headers: { ...hdr, "content-type": "application/octet-stream" }, body: part as BodyInit, signal: ac.signal });
        if (!up.ok) return this.fail("RENDER_FAILED", `upload failed at byte ${off} (HTTP ${up.status})`);
      }
      const meta = { sha256: r.sha256, durationSeconds: r.durationSeconds, musicSeconds: r.musicSeconds, tailSeconds: r.tailSeconds, sampleRate: r.sampleRate, channels: r.channels, format: r.format,
        framesRendered: r.framesRendered, byteLength: r.byteLength, peakDbFS: r.peakDbFS, rmsDbFS: r.rmsDbFS, clippedSamples: r.clippedSamples, gain: r.gain, validated: r.validated,
        loudness: r.loudness, instruments: r.instruments, warnings: r.warnings, soundFont: r.soundFont, noteCount: r.noteCount, renderMs: r.renderMs };
      return { ok: true, projectId: this.c.project.id, revision: this.c.project.revision, data: meta, warnings: [] };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (!ac.signal.aborted) reportError(e, { where: "mcp-render", code: err.code ?? "RENDER_FAILED" });
      return this.fail(ac.signal.aborted ? "RENDER_TIMEOUT" : (err.code ?? "RENDER_FAILED"), err.message ?? String(e));
    } finally { clearTimeout(timer); this.inflight.delete(msg.callId); }
  }

  cancel(callId?: string) {
    if (callId) { this.inflight.get(callId)?.abort(); return; }
    for (const a of this.inflight.values()) a.abort();
  }
}
