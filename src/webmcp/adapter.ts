// Thin WebMCP adapter: registers gbk_* tools on document.modelContext (fallback navigator.modelContext).
// Registration is owned by a module-level singleton so React re-renders / HMR never double-register.
import type { WorkstationController } from "../workstation/controller.ts";
import { runTool, type ToolDef, type ToolResult } from "./tools.ts";
import { getShimModelContext, installGbkTools, ShimModelContext } from "./shim.ts";

/**
 * Content types the WebMCP host returns natively. Chrome's current WebMCP (WebMCPTesting) serializes every tool
 * result to text, so the default is text-only. A host that returns MCP content natively can advertise it with
 * `modelContext.supportedContentTypes` (e.g. ["text", "audio"]) or the page can set `globalThis.gbkWebMcpContentTypes`.
 */
export function hostContentTypes(mc: unknown): string[] {
  const adv = (mc as { supportedContentTypes?: unknown } | null)?.supportedContentTypes ?? (globalThis as { gbkWebMcpContentTypes?: unknown }).gbkWebMcpContentTypes;
  return Array.isArray(adv) ? adv.filter((x): x is string => typeof x === "string") : ["text"];
}

/** Envelope -> what execute() returns. Non-text content is never JSON-stringified into text. */
export function toHostResult(r: ToolResult, contentTypes: string[]): unknown {
  const { content, ...env } = r;
  if (!content?.length) return JSON.stringify(env);
  const supported = content.filter((x) => contentTypes.includes(x.type));
  const dropped = content.filter((x) => !contentTypes.includes(x.type));
  const data = env.data && typeof env.data === "object" ? { ...(env.data as Record<string, unknown>) } : {};
  if (dropped.length) {
    Object.assign(data, { output: "artifact", audioInline: false, reason: `this WebMCP host returns text only; ${dropped.map((x) => x.type).join(", ")} content was not sent (no silent truncation). Read the artifact with gbk_read_wav_bytes.` });
  }
  const text = JSON.stringify({ ...env, data });
  if (!supported.length) return text;
  return { content: [{ type: "text", text }, ...supported.map((x) => ({ type: x.type, mimeType: x.mimeType, data: x.data }))] };
}

interface ModelContextLike {
  registerTool(tool: { name: string; description: string; inputSchema: object; annotations?: object; execute: (input: unknown, client?: { signal?: AbortSignal }) => Promise<unknown> }, opts?: { signal?: AbortSignal }): Promise<void> | void;
}

export function getModelContext(scope: { document?: unknown; navigator?: unknown } = globalThis as never): ModelContextLike | null {
  const d = (scope.document as { modelContext?: ModelContextLike } | undefined)?.modelContext;
  if (d && typeof d.registerTool === "function") return d;
  const n = (scope.navigator as { modelContext?: ModelContextLike } | undefined)?.modelContext;
  if (n && typeof n.registerTool === "function") return n;
  return null;
}

export interface Registration { tools: string[]; unregister(): void }
let current: { abort: AbortController; tools: string[] } | null = null;

/** "webmcp" when the browser exposes the real API, otherwise "shim" (in-page fallback, window.gbkTools). */
export function agentToolsMode(scope?: { document?: unknown; navigator?: unknown }): "webmcp" | "shim" {
  return getModelContext(scope) ? "webmcp" : "shim";
}

/**
 * Registers every tool on the real ModelContext when present, and always on a page-local registry that backs
 * window.gbkTools = { list(), call(name, args) }. Without the real API (normal Chrome, no flags / origin trial) the
 * page-local registry is the only one: shim mode.
 */
export async function registerWebMcpTools(c: WorkstationController, tools: ToolDef[], mc: ModelContextLike | null = getModelContext()): Promise<Registration | null> {
  unregisterWebMcpTools();
  const local: ShimModelContext = getShimModelContext();
  installGbkTools(mc ? "webmcp" : "shim", local);
  const targets: Array<ModelContextLike | ShimModelContext> = mc ? [mc, local] : [local];
  const abort = new AbortController();
  const mine = { abort, tools: tools.map((t) => t.name) };
  current = mine; // capture now: a later registration (StrictMode/HMR) may replace `current` while we await
  for (const t of tools) for (const target of targets) {
    await target.registerTool({
      name: t.name, description: t.description, inputSchema: t.inputSchema,
      annotations: { readOnlyHint: t.readOnly, untrustedContentHint: t.readOnly, consequentialHint: false },
      // Always read live controller state at call time (never captured React state).
      execute: async (input, client) => {
        const signal = client?.signal ?? new AbortController().signal;
        return toHostResult(await runTool(c, t, input, signal), hostContentTypes(mc ?? target));
      },
    }, { signal: abort.signal });
  }
  if (current !== mine) return { tools: mine.tools, unregister: () => {} }; // superseded mid-registration
  c.setAgentToolsEnabled(true);
  return { tools: mine.tools, unregister: () => { if (current === mine) { unregisterWebMcpTools(); c.setAgentToolsEnabled(false); } } };
}

export function unregisterWebMcpTools() {
  current?.abort.abort();
  current = null;
}

// Vite HMR: drop registrations owned by the old module instance.
const hot = (import.meta as { hot?: { dispose(cb: () => void): void } }).hot;
hot?.dispose(() => unregisterWebMcpTools());
