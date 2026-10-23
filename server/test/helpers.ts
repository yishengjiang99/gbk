import { loadConfig, type Config } from "../src/config.ts";
import type { ModelClient, ModelRequest, ModelResponse, ToolCall } from "../src/agent/model-client.ts";
import type { BrowserLink } from "../src/agent/runtime.ts";
import type { ServerMessage, ToolResultEnvelope } from "../src/bridge/protocol.ts";

export function testConfig(over: Record<string, string> = {}): Config {
  return loadConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test", LLM_BASE_URL: "http://fake/v1", LLM_API_KEY: "fake-key", LLM_MODEL: "fake-model", LLM_MODELS: "fake-model,fake-2", SESSION_SECRET: "x".repeat(40), COMPOSER_ACCESS_CODES: "alice:code-a,bob:code-b", AGENT_TOOL_TIMEOUT_MS: "2000", AGENT_RECONNECT_GRACE_MS: "300", ...over } as NodeJS.ProcessEnv);
}
export const tc = (id: string, name: string, args: unknown = {}): ToolCall => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
export class ScriptModel implements ModelClient {
  readonly name = "script"; requests: ModelRequest[] = [];
  constructor(private script: ((r: ModelRequest, i: number) => ModelResponse | Promise<ModelResponse>)[]) {}
  async complete(r: ModelRequest) { this.requests.push(structuredClone({ ...r, signal: undefined, onText: undefined }) as never); const f = this.script[Math.min(this.requests.length - 1, this.script.length - 1)]; const out = await f(r, this.requests.length - 1); if (out.content) r.onText?.(out.content); return out; }
}
export const reply = (content: string): ModelResponse => ({ content, toolCalls: [], finishReason: "stop", usage: { promptTokens: 100, completionTokens: 10 } });
export const calls = (...t: ToolCall[]): ModelResponse => ({ content: "", toolCalls: t, finishReason: "tool_calls", usage: { promptTokens: 100, completionTokens: 10 } });

export class FakeLink implements BrowserLink {
  sessionId = "bs_test"; projectId = "prj_1"; revision = 0; events: ServerMessage[] = []; executed: { tool: string; args: Record<string, unknown>; callId: string; expect: string | null }[] = [];
  allowedTools: Set<string>;
  reconnectTo: BrowserLink | null = null;
  constructor(tools: string[], public handler: (tool: string, args: Record<string, unknown>) => Promise<ToolResultEnvelope> | ToolResultEnvelope = (t) => ({ ok: true, projectId: this.projectId, revision: this.revision, data: { tool: t }, warnings: [] })) { this.allowedTools = new Set(tools); }
  emit(m: ServerMessage) { this.events.push(m); }
  async callTool(_run: string, callId: string, tool: string, args: Record<string, unknown>, o: { expectProjectId: string | null }) { this.executed.push({ tool, args, callId, expect: o.expectProjectId }); return this.handler(tool, args); }
  async awaitReconnect() { return this.reconnectTo; }
}
