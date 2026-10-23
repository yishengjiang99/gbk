// Builds the Composer tool manifest from the canonical GBK registry (buildAllTools), filtered by the shared policy.
// Used by the browser (sent on connect) and by the server (its own vetted copy; it never trusts the client's).
import type { ToolDef } from "../webmcp/tools.ts";
import { policyFor, manifestHash } from "./tool-policy.ts";
import type { ManifestTool } from "./protocol.ts";

export function composerManifest(tools: ToolDef[]): { hash: string; tools: ManifestTool[] } {
  const list: ManifestTool[] = [];
  for (const t of tools) {
    const pol = policyFor(t.name);
    if (!pol) continue;
    list.push({ name: t.name, description: t.description, inputSchema: t.inputSchema, readOnly: t.readOnly, cls: pol.cls });
  }
  return { hash: manifestHash(list), tools: list };
}
