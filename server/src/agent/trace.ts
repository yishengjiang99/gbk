// #163 #11: persisted per-run traces. One JSONL file per day under <dataDir>/traces (daily rotation by
// filename). A trace records the run's shape - mode, model, tool calls with an args DIGEST (keys + a
// short hash, never values), errors, steps, tokens, cost, outcome, and whether the user accepted a
// proposal - so prompt/model changes can be evaluated against production behaviour (#10 evals feed on
// this). Free text (user messages, model replies, project names) is never written.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentMode } from "./conversation.ts";

export interface TraceCall { tool: string; ok: boolean; code?: string; argsDigest: string }
export interface RunTrace {
  runId: string; user: string; at: number; mode: AgentMode; model: string;
  status: "completed" | "failed" | "cancelled"; code?: string;
  steps: number; calls: TraceCall[];
  promptTokens: number; completionTokens: number; cachedPromptTokens: number; costUsd: number;
  toolSchemaTokens: number; durationMs: number;
  /** Proposal outcomes observed during the run: created / committed / approval-waiting. */
  proposals: { created: string[]; committed: string[]; approvalRequired: number };
}

export const argsDigest = (args: Record<string, unknown>): string => {
  const keys = Object.keys(args).sort().join(",");
  return `${keys}|${createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 12)}`;
};

export class RunTraceStore {
  constructor(private dir: string | null) { if (dir) mkdirSync(join(dir, "traces"), { recursive: true }); }
  write(t: RunTrace): void {
    if (!this.dir) return;
    try {
      const day = new Date(t.at).toISOString().slice(0, 10);
      appendFileSync(join(this.dir, "traces", `runs-${day}.jsonl`), `${JSON.stringify(t)}\n`);
    } catch { /* traces are diagnostics; never fail a run over them */ }
  }
}
