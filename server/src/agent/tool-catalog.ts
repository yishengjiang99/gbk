// The server's own vetted tool catalog, built from the canonical GBK registry (same ToolDef schemas + validate()
// the browser and WebMCP use). Browser manifests are compared against it but never grant anything.
import { WorkstationController } from "../../../src/workstation/controller.ts";
import { buildAllTools } from "../../../src/webmcp/registry.ts";
import { validate } from "../../../src/webmcp/tools.ts";
import { composerManifest } from "../../../src/agent/tool-manifest.ts";
import { policyFor, type ToolPolicy } from "../../../src/agent/tool-policy.ts";
import type { ManifestTool } from "../bridge/protocol.ts";
import type { ToolSchema } from "./model-client.ts";

export interface CatalogTool extends ManifestTool { policy: ToolPolicy }
export class ToolCatalog {
  readonly tools = new Map<string, CatalogTool>();
  readonly hash: string;
  constructor() {
    const m = composerManifest(buildAllTools(new WorkstationController()));
    for (const t of m.tools) this.tools.set(t.name, { ...t, policy: policyFor(t.name)! });
    this.hash = m.hash;
  }
  get(name: string) { return this.tools.get(name) ?? null; }
  /** Tools offered to the model: the vetted catalog intersected with what this browser actually registered. */
  schemasFor(names: Set<string>): ToolSchema[] {
    return [...this.tools.values()].filter((t) => names.has(t.name)).map((t) => ({ type: "function", function: { name: t.name, description: t.description.slice(0, 1024), parameters: t.inputSchema } }));
  }
  /** Compare a client manifest with the vetted catalog: only identical, known tools are accepted. */
  reconcile(client: ManifestTool[] | undefined): { accepted: string[]; rejected: string[] } {
    const accepted: string[] = []; const rejected: string[] = [];
    for (const t of (client ?? []).slice(0, 200)) {
      const mine = typeof t?.name === "string" ? this.tools.get(t.name) : undefined;
      if (mine && JSON.stringify(mine.inputSchema) === JSON.stringify(t.inputSchema)) accepted.push(mine.name); else rejected.push(String(t?.name ?? "?").slice(0, 80));
    }
    return { accepted, rejected };
  }
  /** Policy-forced args + canonical validation. Throws {code,message}. */
  prepareArgs(name: string, raw: string): Record<string, unknown> {
    const t = this.tools.get(name);
    if (!t) throw Object.assign(new Error(`unknown or disallowed tool ${name.slice(0, 80)}`), { code: "TOOL_NOT_ALLOWED" });
    let args: unknown;
    try { args = raw.trim() ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error("tool arguments are not valid JSON"), { code: "INVALID_ARGUMENT" }); }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw Object.assign(new Error("tool arguments must be a JSON object"), { code: "INVALID_ARGUMENT" });
    const merged = { ...(args as Record<string, unknown>), ...(t.policy.force ?? {}) };
    try { validate(t.inputSchema, merged); } catch (e) { throw Object.assign(new Error((e as Error).message), { code: "INVALID_ARGUMENT" }); }
    return merged;
  }
}
