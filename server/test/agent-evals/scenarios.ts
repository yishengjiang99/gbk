// #163 #10: behavioural eval scenarios for the Composer agent.
//
// These run the REAL runtime against a scripted "model policy" - a deterministic stand-in that reacts
// to the run context exactly the way a well-behaved model should (reads the mode from the context line,
// follows the playbook for the scenario). The assertions are trace assertions: which tools were offered,
// which were called, which were forbidden, consent/revision plumbing, step counts, and the final state
// of the working memory. They catch regressions where a prompt/runtime change breaks the CONTRACT the
// model relies on (e.g. a follow-up run offering gbk_create_project again, or a key change regenerating
// instead of transforming).
//
// Musical quality is NOT asserted - that stays a manual listening pass. Real-model runs use the same
// scenario shapes behind AGENT_EVAL_REAL=1 (see README.md) and are for nightly/manual runs, not PR CI.
import type { ModelRequest, ModelResponse, ToolCall } from "../../src/agent/model-client.ts";
import { tc } from "../helpers.ts";

export interface Scenario {
  name: string;
  /** Turns of user text, run in order against one conversation. */
  turns: string[];
  remix?: boolean;
  /** Start with the conversation already bound to the open project (a follow-up-only scenario). */
  prebound?: boolean;
  /** Tools that must never reach the browser across all turns. */
  forbiddenExecuted: string[];
  /** Tools that must have been executed at least once across all turns. */
  requiredExecuted: string[];
  maxStepsPerTurn: number;
  /** Final working-memory key (when the scenario changes key). */
  expectKey?: string;
}

export const SCENARIOS: Scenario[] = [
  { name: "new piece: create then arrange", turns: ["compose a short baroque fugue"], forbiddenExecuted: [], requiredExecuted: ["gbk_create_project"], maxStepsPerTurn: 4 },
  { name: "follow-up key change uses one remap, never create/generate", turns: ["compose a piece in C minor", "rewrite this in A major"], forbiddenExecuted: [], requiredExecuted: ["gbk_transform_notes"], maxStepsPerTurn: 4, expectKey: "A major" },
  { name: "follow-up 'brighter' reads analysis before notes", turns: ["make it brighter"], prebound: true, forbiddenExecuted: ["gbk_create_project", "gbk_generate_arrangement"], requiredExecuted: ["gbk_analyze_passage"], maxStepsPerTurn: 5 },
  { name: "remix: every ask is an edit of the fork", turns: ["make it more dramatic"], remix: true, forbiddenExecuted: ["gbk_create_project", "gbk_generate_arrangement"], requiredExecuted: ["gbk_get_project_summary"], maxStepsPerTurn: 4 },
];

/** A deterministic model policy: one behaviour per scenario turn, driven by the context line's mode. */
export function policyFor(scenario: Scenario): (r: ModelRequest, i: number) => ModelResponse {
  let step = 0;
  const reply = (content: string): ModelResponse => ({ content, toolCalls: [], finishReason: "stop", usage: { promptTokens: 50, completionTokens: 5 } });
  const calls = (...t: ToolCall[]): ModelResponse => ({ content: "", toolCalls: t, finishReason: "tool_calls", usage: { promptTokens: 50, completionTokens: 5 } });
  return (r) => {
    const users = r.messages.filter((m) => m.role === "user");
    const lastUser = String(users.at(-1)?.content ?? "");
    const mode = /mode=(new|edit|remix)/.exec(lastUser)?.[1] ?? "new";
    // Tool results in THIS turn only (messages after the last real user message; server notes excluded).
    const lastUserIdx = r.messages.map((m, i) => (m.role === "user" && !String(m.content).startsWith("[server note]") && !String(m.content).startsWith("[Conversation summary") ? i : -1)).filter((i) => i >= 0).at(-1) ?? 0;
    const toolResults = r.messages.slice(lastUserIdx).filter((m) => m.role === "tool").length;
    step++;
    if (scenario.name.startsWith("new piece")) {
      if (toolResults === 0) return calls(tc("e1", "gbk_create_project", { name: "Eval Fugue" }));
      return reply("Composed.");
    }
    if (scenario.name.includes("key change")) {
      if (mode === "new" && toolResults === 0) return calls(tc("e1", "gbk_create_project", { name: "Eval Piece", key: "C minor" }));
      if (mode === "edit" && toolResults === 0) return calls(tc("e2", "gbk_transform_notes", { trackId: "*", range: { unit: "bars", start: 1, end: 32 }, transform: "remap", targetKey: "A major" }));
      return reply("Done.");
    }
    if (scenario.name.includes("brighter")) {
      if (mode === "edit" && toolResults === 0) return calls(tc("e2", "gbk_analyze_passage", { range: { unit: "bars", start: 1, end: 8 } }));
      if (mode === "edit" && toolResults === 1) return calls(tc("e3", "gbk_get_notes", { range: { unit: "bars", start: 1, end: 2 }, limit: 50 }));
      return reply("Brightened.");
    }
    // remix
    if (toolResults === 0) return calls(tc("e1", "gbk_get_project_summary"));
    return reply("Edited the fork.");
  };
}
