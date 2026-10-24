// Outstanding browser tool calls keyed by callId: one resolver each, deadline-bounded, rejected on disconnect/cancel.
import type { ToolResultEnvelope } from "./protocol.ts";

export class BridgeCallError extends Error { constructor(public code: "TOOL_TIMEOUT" | "BROWSER_DISCONNECTED" | "OPERATION_CANCELLED", message: string) { super(message); } }

interface Pending { runId: string; tool: string; resolve(r: ToolResultEnvelope): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }

export class PendingCalls {
  private calls = new Map<string, Pending>();
  add(callId: string, runId: string, tool: string, timeoutMs: number): Promise<ToolResultEnvelope> {
    if (this.calls.has(callId)) throw new Error(`duplicate callId ${callId}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(callId); reject(new BridgeCallError("TOOL_TIMEOUT", `${tool} did not finish within ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
      this.calls.set(callId, { runId, tool, resolve, reject, timer });
    });
  }
  /** Returns false for unknown / already-settled / wrong-run results (duplicates and strays are ignored). */
  settle(callId: string, runId: string, r: ToolResultEnvelope): boolean {
    const p = this.calls.get(callId);
    if (!p || p.runId !== runId) return false;
    clearTimeout(p.timer); this.calls.delete(callId); p.resolve(r); return true;
  }
  rejectAll(code: BridgeCallError["code"], message: string, runId?: string) {
    for (const [id, p] of this.calls) if (!runId || p.runId === runId) { clearTimeout(p.timer); this.calls.delete(id); p.reject(new BridgeCallError(code, message)); }
  }
  /** Outstanding call ids of one run (to tell the browser to stop them). */
  idsFor(runId: string): string[] { return [...this.calls].filter(([, p]) => p.runId === runId).map(([id]) => id); }
  has(callId: string) { return this.calls.has(callId); }
  get size() { return this.calls.size; }
}
