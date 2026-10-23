// Browser-resident tool executor for the server-hosted Composer agent. Executes ONE gbk_* tool per server request
// through the canonical registry (buildAllTools) + runTool() validation, i.e. the same handlers as WebMCP and
// window.gbkTools. No eval, no string injection, no Playwright/CDP: typed module imports only.
import type { WorkstationController } from "../workstation/controller.ts";
import { buildAllTools } from "../webmcp/registry.ts";
import { runTool, type ToolDef } from "../webmcp/tools.ts";
import { policyFor } from "./tool-policy.ts";
import { composerManifest } from "./tool-manifest.ts";
import { MAX_FRAME_BYTES, type ServerMessage, type ToolResultEnvelope } from "./protocol.ts";

type ToolCall = Extract<ServerMessage, { type: "tool_call" }>;

export class BrowserToolBridge {
  readonly tools: Map<string, ToolDef>;
  readonly manifest: ReturnType<typeof composerManifest>;
  private mutationChain: Promise<unknown> = Promise.resolve();
  private inflight = new Map<string, AbortController>();
  private seen = new Map<string, Promise<ToolResultEnvelope>>(); // duplicate tool_call -> same result, never re-executed
  /** Project the current conversation is bound to; results from another project are never applied. */
  boundProjectId: string | null = null;

  constructor(private c: WorkstationController, tools: ToolDef[] = buildAllTools(c)) {
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
    const pol = policyFor(msg.tool); const tool = this.tools.get(msg.tool);
    if (!pol || !tool) return this.fail("TOOL_NOT_ALLOWED", `${msg.tool} is not available to the Composer agent`);
    if (pol.createsProject && !msg.consent?.newProject) return this.fail("CONSENT_REQUIRED", "creating a project needs a user prompt in this conversation");
    const args = { ...(msg.arguments ?? {}), ...(pol.force ?? {}) };
    const exec = async (): Promise<ToolResultEnvelope> => {
      if (msg.expectProjectId && this.c.project.id !== msg.expectProjectId && !pol.createsProject)
        return this.fail("PROJECT_CHANGED", `the open project changed (expected ${msg.expectProjectId}, now ${this.c.project.id}); re-read the project before editing`);
      const ac = new AbortController(); this.inflight.set(msg.callId, ac);
      const timer = setTimeout(() => ac.abort(), Math.max(1000, msg.deadlineMs || 120_000));
      let stopProg: (() => void) | undefined;
      if (pol.cls === "render" && onProgress) {
        const iv = setInterval(() => onProgress(-1, "rendering"), 2000); stopProg = () => clearInterval(iv);
      }
      try {
        const r = await runTool(this.c, tool, args, ac.signal);
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

  cancel(callId?: string) {
    if (callId) { this.inflight.get(callId)?.abort(); return; }
    for (const a of this.inflight.values()) a.abort();
  }
}
