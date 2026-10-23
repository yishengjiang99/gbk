// In-page WebMCP fallback. Chrome only exposes document.modelContext with --enable-features=WebMCPTesting (or a valid
// WebMCP origin-trial token). In a normal browser the shim below keeps the same registry so an agent driving the page
// (e.g. Playwright/CDP page.evaluate, a desktop agent's Chrome) can call the gbk_* tools via window.gbkTools.
// The shim is page-local: nothing is exposed cross-origin, over the network, or to other tabs.

export interface ShimTool {
  name: string; description: string; inputSchema: object; annotations?: object;
  execute: (input: unknown, client?: { signal?: AbortSignal }) => Promise<unknown>;
}

/** Minimal ModelContext-compatible registry (registerTool with abort-signal unregistration, getTools, executeTool). */
export class ShimModelContext {
  readonly isGbkShim = true;
  private tools = new Map<string, ShimTool>();
  registerTool(tool: ShimTool, opts?: { signal?: AbortSignal }): void {
    if (opts?.signal?.aborted) return;
    this.tools.set(tool.name, tool);
    opts?.signal?.addEventListener("abort", () => { if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name); }, { once: true });
  }
  unregisterTool(name: string) { this.tools.delete(name); }
  async getTools() { return [...this.tools.values()].map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })); }
  async executeTool(tool: string | { name: string }, input: unknown = {}, client?: { signal?: AbortSignal }): Promise<unknown> {
    const name = typeof tool === "string" ? tool : tool?.name;
    const t = this.tools.get(name);
    if (!t) throw new Error(`gbk tool "${name}" is not registered (is "Enable Agent Tools" on?)`);
    return t.execute(input ?? {}, { signal: client?.signal ?? new AbortController().signal });
  }
}

export interface GbkTools {
  /** "webmcp" when the browser's real document/navigator.modelContext is used, "shim" otherwise. */
  readonly mode: "webmcp" | "shim";
  list(): Promise<Array<{ name: string; description: string; inputSchema: object; annotations?: object }>>;
  /** Same result the real WebMCP execute() returns (a JSON string envelope by default). */
  call(name: string, args?: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>;
}

let shim: ShimModelContext | null = null;
export function getShimModelContext(): ShimModelContext { return (shim ??= new ShimModelContext()); }

/** window.gbkTools: always backed by the adapter's own registry so it behaves the same in both modes. */
export function installGbkTools(mode: "webmcp" | "shim", registry: ShimModelContext, scope: Record<string, unknown> = globalThis as never): GbkTools {
  const api: GbkTools = {
    mode,
    list: () => registry.getTools(),
    call: (name, args = {}, opts) => registry.executeTool(name, args, opts),
  };
  try { Object.defineProperty(scope, "gbkTools", { value: Object.freeze(api), configurable: true, writable: false }); } catch { /* frozen scope */ }
  return api;
}
