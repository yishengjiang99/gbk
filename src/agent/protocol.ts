// Typed WebSocket protocol between the browser tool executor and the Composer agent server (shared by both).
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 512 * 1024; // bounded message size in both directions

export interface ManifestTool { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean; cls: "read" | "mutate" | "render" }
/** #163 #3: run intent. The UI sets it when the entry point knows (remix handoff -> "remix"); when it is
 * absent the server derives it from the conversation binding. "new" is the only mode with project consent. */
export type AgentMode = "new" | "edit" | "remix";
export interface ToolResultEnvelope { ok: boolean; projectId: string; revision: number; data?: unknown; warnings: string[]; error?: { code: string; message: string; details?: unknown } }
export interface UsageInfo { promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number; dayTokens: number; dayCostUsd: number }
export interface ArtifactRef { artifactId: string; kind: "wav" | "midi"; filename?: string; bytes?: number; durationSeconds?: number; sha256?: string; mimeType?: string }

// browser -> server
export type ClientMessage =
  | { type: "hello"; protocol: number; tabId: string; manifest: { hash: string; tools: ManifestTool[] }; projectId: string; revision: number; resumeRunId?: string }
  | { type: "user_message"; clientMessageId: string; text: string; model?: string; mode?: AgentMode; remixOf?: { slug: string; title: string; summary?: Record<string, unknown> } }
  | { type: "tool_result"; sessionId: string; runId: string; callId: string; result: ToolResultEnvelope }
  | { type: "tool_progress"; sessionId: string; runId: string; callId: string; progress: number; detail?: string }
  | { type: "project_state"; projectId: string; revision: number }
  | { type: "cancel_run"; runId: string }
  | { type: "reset_conversation" }
  | { type: "ping"; t: number }
  | { type: "pong"; t: number };

// server -> browser
export type ServerMessage =
  | { type: "session_ready"; sessionId: string; user: string; model: string; models: string[]; provider: string; llmConfigured: boolean; manifestHash: string; acceptedTools: string[]; rejectedTools: string[]; history: HistoryItem[]; limits: Record<string, number> }
  | { type: "session_reconnected"; sessionId: string; runId: string | null; resumed: boolean; reason?: string }
  | { type: "run_started"; runId: string; clientMessageId: string; text: string }
  | { type: "assistant_delta"; runId: string; text: string }
  | { type: "assistant_message"; runId: string; text: string }
  | { type: "tool_intent"; runId: string; callId: string; tool: string; arguments: unknown; task: string }
  | { type: "tool_call"; sessionId: string; runId: string; callId: string; tool: string; arguments: Record<string, unknown>; expectProjectId: string | null; consent: { newProject: boolean }; deadlineMs: number }
  | { type: "tool_started"; runId: string; callId: string; tool: string }
  | { type: "tool_progress"; runId: string; callId: string; progress: number; detail?: string }
  | { type: "tool_completed"; runId: string; callId: string; tool: string; ok: boolean; summary: string; error?: { code: string; message: string }; artifact?: ArtifactRef; projectId?: string; revision?: number }
  | { type: "approval_required"; runId: string; callId: string; proposalId?: string; summary: string }
  | { type: "progress"; runId: string; step: number; maxSteps: number; task: string }
  | { type: "usage"; runId: string; usage: UsageInfo }
  | { type: "run_completed"; runId: string; text: string; artifacts: ArtifactRef[]; steps: number }
  | { type: "run_failed"; runId: string; code: string; message: string; retryable: boolean }
  | { type: "cancel_call"; runId: string; callId: string }
  | { type: "error"; code: string; message: string }
  | { type: "ping"; t: number }
  | { type: "pong"; t: number };

export interface HistoryItem { role: "user" | "assistant"; text: string; at: number; artifacts?: ArtifactRef[] }

export function parseJsonFrame(raw: string): unknown {
  if (raw.length > MAX_FRAME_BYTES) throw new Error("frame too large");
  return JSON.parse(raw);
}
