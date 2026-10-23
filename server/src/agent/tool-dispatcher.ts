// Executes one model response's tool calls: validate -> RPC to the browser -> results with matching ids.
// Consecutive read-only calls run in parallel; mutations/renders run strictly in order (one mutation sequence).
import type { ToolCall } from "./model-client.ts";
import type { ToolCatalog } from "./tool-catalog.ts";
import type { ToolResultEnvelope } from "../bridge/protocol.ts";

export interface ToolExecutor { (call: { callId: string; tool: string; args: Record<string, unknown> }): Promise<ToolResultEnvelope> }
export interface DispatchOutcome { callId: string; tool: string; args: Record<string, unknown> | null; result: ToolResultEnvelope; rejectedBeforeExecution: boolean }

const errEnv = (code: string, message: string): ToolResultEnvelope => ({ ok: false, projectId: "", revision: -1, warnings: [], error: { code, message } });

export async function dispatchToolCalls(calls: ToolCall[], catalog: ToolCatalog, allowed: Set<string>, exec: ToolExecutor, signal: AbortSignal, hooks: { onStart?(o: { callId: string; tool: string }): void } = {}): Promise<DispatchOutcome[]> {
  const out: DispatchOutcome[] = new Array(calls.length);
  const seen = new Set<string>();
  const prepared = calls.map((c, i) => {
    const tool = c.function.name;
    if (seen.has(c.id)) return { i, c, err: errEnv("DUPLICATE_CALL_ID", "duplicate tool call id in one response") };
    seen.add(c.id);
    if (!allowed.has(tool)) return { i, c, err: errEnv("TOOL_NOT_ALLOWED", `${tool.slice(0, 80)} is not available (not in the vetted GBK tool list for this browser)`) };
    try { return { i, c, args: catalog.prepareArgs(tool, c.function.arguments) }; }
    catch (e) { return { i, c, err: errEnv((e as { code?: string }).code ?? "INVALID_ARGUMENT", (e as Error).message) }; }
  });
  const runOne = async (p: (typeof prepared)[number]) => {
    if ("err" in p && p.err) { out[p.i] = { callId: p.c.id, tool: p.c.function.name, args: null, result: p.err, rejectedBeforeExecution: true }; return; }
    if (signal.aborted) { out[p.i] = { callId: p.c.id, tool: p.c.function.name, args: p.args!, result: errEnv("OPERATION_CANCELLED", "run cancelled before this call"), rejectedBeforeExecution: true }; return; }
    hooks.onStart?.({ callId: p.c.id, tool: p.c.function.name });
    let result: ToolResultEnvelope;
    try { result = await exec({ callId: p.c.id, tool: p.c.function.name, args: p.args! }); }
    catch (e) { result = errEnv((e as { code?: string }).code ?? "INTERNAL_ERROR", (e as Error).message); }
    out[p.i] = { callId: p.c.id, tool: p.c.function.name, args: p.args!, result, rejectedBeforeExecution: false };
  };
  let batch: typeof prepared = [];
  const flush = async () => { if (batch.length) { await Promise.all(batch.map(runOne)); batch = []; } };
  for (const p of prepared) {
    const cls = "args" in p && p.args ? catalog.get(p.c.function.name)?.policy.cls : "read";
    if (cls === "read") batch.push(p);
    else { await flush(); await runOne(p); }
  }
  await flush();
  return out;
}
