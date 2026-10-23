// Thin WebMCP adapter: registers gbk_* tools on document.modelContext (fallback navigator.modelContext).
// Registration is owned by a module-level singleton so React re-renders / HMR never double-register.
import type { WorkstationController } from "../workstation/controller.ts";
import { runTool, type ToolDef } from "./tools.ts";

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

export async function registerWebMcpTools(c: WorkstationController, tools: ToolDef[], mc: ModelContextLike | null = getModelContext()): Promise<Registration | null> {
  if (!mc) return null;
  unregisterWebMcpTools();
  const abort = new AbortController();
  current = { abort, tools: tools.map((t) => t.name) };
  for (const t of tools) {
    await mc.registerTool({
      name: t.name, description: t.description, inputSchema: t.inputSchema,
      annotations: { readOnlyHint: t.readOnly, untrustedContentHint: t.readOnly, consequentialHint: false },
      // Always read live controller state at call time (never captured React state).
      execute: async (input, client) => {
        const signal = client?.signal ?? new AbortController().signal;
        return JSON.stringify(await runTool(c, t, input, signal));
      },
    }, { signal: abort.signal });
  }
  c.setAgentToolsEnabled(true);
  const mine = current;
  return { tools: current.tools, unregister: () => { if (current === mine) { unregisterWebMcpTools(); c.setAgentToolsEnabled(false); } } };
}

export function unregisterWebMcpTools() {
  current?.abort.abort();
  current = null;
}

// Vite HMR: drop registrations owned by the old module instance.
const hot = (import.meta as { hot?: { dispose(cb: () => void): void } }).hot;
hot?.dispose(() => unregisterWebMcpTools());
