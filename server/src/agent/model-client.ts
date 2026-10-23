// OpenAI-compatible model client (Chat Completions with tools, tool_choice "auto", SSE streaming) plus an optional
// Responses API adapter. The runtime only sees ModelClient, so providers are swappable without touching the loop.
export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export interface ToolSchema { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface ModelRequest { model: string; messages: ChatMessage[]; tools: ToolSchema[]; maxTokens: number; signal: AbortSignal; onText?: (t: string) => void; parallelToolCalls?: boolean }
export interface ModelUsage { promptTokens: number; completionTokens: number }
export interface ModelResponse { content: string; toolCalls: ToolCall[]; finishReason: string; usage: ModelUsage | null }
export interface ModelClient { readonly name: string; complete(r: ModelRequest): Promise<ModelResponse> }

export class ProviderError extends Error {
  constructor(public code: "PROVIDER_RATE_LIMITED" | "PROVIDER_AUTH" | "PROVIDER_INCOMPATIBLE" | "PROVIDER_ERROR" | "PROVIDER_TIMEOUT" | "LLM_NOT_CONFIGURED" | "OPERATION_CANCELLED", message: string, public status = 0, public retryable = false) { super(message); }
}

/** Accumulates streamed tool-call fragments by index (and id). Nothing is parsed until the stream finished. */
export class ToolCallAssembler {
  private parts = new Map<number, { id: string; name: string; args: string }>();
  push(delta: { index?: number; id?: string; function?: { name?: string; arguments?: string } }) {
    let idx = typeof delta.index === "number" ? delta.index : -1;
    if (idx < 0) { // providers that omit index: match by id, else append to the last call
      const byId = delta.id ? [...this.parts.entries()].find(([, v]) => v.id === delta.id) : undefined;
      idx = byId ? byId[0] : delta.id || this.parts.size === 0 ? this.parts.size : this.parts.size - 1;
    }
    const cur = this.parts.get(idx) ?? { id: "", name: "", args: "" };
    if (delta.id) cur.id = delta.id;
    if (delta.function?.name) cur.name += delta.function.name;
    if (delta.function?.arguments) cur.args += delta.function.arguments;
    this.parts.set(idx, cur);
  }
  finish(): ToolCall[] {
    return [...this.parts.entries()].sort((a, b) => a[0] - b[0]).map(([i, p]) => ({ id: p.id || `call_idx_${i}`, type: "function" as const, function: { name: p.name, arguments: p.args || "{}" } }));
  }
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((res, rej) => { const t = setTimeout(res, ms); signal.addEventListener("abort", () => { clearTimeout(t); rej(new ProviderError("OPERATION_CANCELLED", "cancelled")); }, { once: true }); });

export interface HttpClientOptions { baseUrl: string; apiKey: string; timeoutMs: number; maxRetries: number; stream: boolean; fetchImpl?: typeof fetch; log?: (o: Record<string, unknown>) => void }

abstract class HttpModelClient implements ModelClient {
  abstract readonly name: string;
  constructor(protected o: HttpClientOptions) {}
  abstract complete(r: ModelRequest): Promise<ModelResponse>;
  /** POST with retry/backoff on 429/5xx/network errors (never after a stream has started). */
  protected async post(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    if (!this.o.baseUrl || !this.o.apiKey) throw new ProviderError("LLM_NOT_CONFIGURED", "LLM not configured: set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL on the server");
    const f = this.o.fetchImpl ?? fetch;
    let last: ProviderError | null = null;
    for (let attempt = 0; attempt <= this.o.maxRetries; attempt++) {
      if (signal.aborted) throw new ProviderError("OPERATION_CANCELLED", "cancelled");
      const ac = new AbortController(); const onAbort = () => ac.abort(); signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => ac.abort(), this.o.timeoutMs);
      try {
        const res = await f(`${this.o.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}` }, body: JSON.stringify(body), signal: ac.signal });
        if (res.ok) return res;
        const text = (await res.text().catch(() => "")).slice(0, 600);
        const msg = safeProviderMessage(text) || res.statusText;
        if (res.status === 401 || res.status === 403) throw new ProviderError("PROVIDER_AUTH", `provider rejected the credentials (${res.status})`, res.status);
        if (res.status === 400 || res.status === 404 || res.status === 422) {
          const incompatible = /tool|function|stream|parameter|unsupported|not support/i.test(msg);
          throw new ProviderError(incompatible ? "PROVIDER_INCOMPATIBLE" : "PROVIDER_ERROR", incompatible ? `provider/model is not compatible with GBK's tool calling: ${msg}` : `provider error ${res.status}: ${msg}`, res.status);
        }
        last = new ProviderError(res.status === 429 ? "PROVIDER_RATE_LIMITED" : "PROVIDER_ERROR", `provider ${res.status}: ${msg}`, res.status, true);
        const ra = Number(res.headers.get("retry-after"));
        this.o.log?.({ evt: "provider_retry", status: res.status, attempt });
        if (attempt < this.o.maxRetries) await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 20_000) : 500 * 2 ** attempt, signal);
      } catch (e) {
        if (e instanceof ProviderError && !e.retryable) throw e;
        if (signal.aborted) throw new ProviderError("OPERATION_CANCELLED", "cancelled");
        last = e instanceof ProviderError ? e : new ProviderError(ac.signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR", ac.signal.aborted ? "provider request timed out" : `provider unreachable: ${(e as Error).message}`, 0, true);
        if (attempt < this.o.maxRetries) await sleep(500 * 2 ** attempt, signal);
      } finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
    }
    throw last ?? new ProviderError("PROVIDER_ERROR", "provider failed");
  }
}

function safeProviderMessage(text: string): string {
  try { const j = JSON.parse(text); const m = j?.error?.message ?? j?.message ?? j?.error; return typeof m === "string" ? m.slice(0, 300) : ""; } catch { return text.replace(/\s+/g, " ").slice(0, 200); }
}

async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1); if (line.startsWith("data:")) yield line.slice(5).trim(); }
  }
  if (buf.startsWith("data:")) yield buf.slice(5).trim();
}

export class ChatCompletionsClient extends HttpModelClient {
  readonly name = "chat_completions";
  async complete(r: ModelRequest): Promise<ModelResponse> {
    const body: Record<string, unknown> = { model: r.model, messages: r.messages, max_tokens: r.maxTokens, ...(r.tools.length ? { tools: r.tools, tool_choice: "auto", ...(r.parallelToolCalls === false ? { parallel_tool_calls: false } : {}) } : {}) };
    if (!this.o.stream) {
      const res = await this.post("/chat/completions", body, r.signal);
      const j = await res.json() as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const ch = j.choices?.[0];
      if (!ch?.message) throw new ProviderError("PROVIDER_INCOMPATIBLE", "provider response has no choices[0].message");
      if (ch.message.content) r.onText?.(ch.message.content);
      return { content: ch.message.content ?? "", toolCalls: (ch.message.tool_calls ?? []).map((t, i) => ({ id: t.id || `call_idx_${i}`, type: "function", function: { name: t.function?.name ?? "", arguments: t.function?.arguments || "{}" } })), finishReason: ch.finish_reason ?? "stop", usage: j.usage ? { promptTokens: j.usage.prompt_tokens ?? 0, completionTokens: j.usage.completion_tokens ?? 0 } : null };
    }
    const res = await this.post("/chat/completions", { ...body, stream: true, stream_options: { include_usage: true } }, r.signal);
    if (!res.body) throw new ProviderError("PROVIDER_INCOMPATIBLE", "provider returned no stream body");
    const asm = new ToolCallAssembler(); let content = ""; let finish = ""; let usage: ModelUsage | null = null;
    for await (const data of sseLines(res.body)) {
      if (r.signal.aborted) throw new ProviderError("OPERATION_CANCELLED", "cancelled");
      if (!data || data === "[DONE]") continue;
      let j: { choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
      try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new ProviderError("PROVIDER_ERROR", `provider stream error: ${String(j.error.message ?? "").slice(0, 200)}`);
      if (j.usage) usage = { promptTokens: j.usage.prompt_tokens ?? 0, completionTokens: j.usage.completion_tokens ?? 0 };
      const ch = j.choices?.[0]; if (!ch) continue;
      if (ch.delta?.content) { content += ch.delta.content; r.onText?.(ch.delta.content); }
      for (const tc of ch.delta?.tool_calls ?? []) asm.push(tc);
      if (ch.finish_reason) finish = ch.finish_reason;
    }
    return { content, toolCalls: asm.finish(), finishReason: finish || "stop", usage };
  }
}

/** Optional Responses API adapter (non-streaming): maps chat messages <-> input items. */
export class ResponsesClient extends HttpModelClient {
  readonly name = "responses";
  async complete(r: ModelRequest): Promise<ModelResponse> {
    const input: unknown[] = [];
    let instructions = "";
    for (const m of r.messages) {
      if (m.role === "system") instructions += (instructions ? "\n\n" : "") + m.content;
      else if (m.role === "user") input.push({ role: "user", content: m.content });
      else if (m.role === "assistant") { if (m.content) input.push({ role: "assistant", content: m.content }); for (const t of m.tool_calls ?? []) input.push({ type: "function_call", call_id: t.id, name: t.function.name, arguments: t.function.arguments }); }
      else input.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content });
    }
    const res = await this.post("/responses", { model: r.model, instructions, input, max_output_tokens: r.maxTokens, tools: r.tools.map((t) => ({ type: "function", name: t.function.name, description: t.function.description, parameters: t.function.parameters })), tool_choice: "auto" }, r.signal);
    const j = await res.json() as { output?: { type: string; content?: { type: string; text?: string }[]; call_id?: string; name?: string; arguments?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    let content = ""; const toolCalls: ToolCall[] = [];
    for (const o of j.output ?? []) {
      if (o.type === "message") for (const c of o.content ?? []) if (c.text) content += c.text;
      if (o.type === "function_call") toolCalls.push({ id: o.call_id ?? `call_${toolCalls.length}`, type: "function", function: { name: o.name ?? "", arguments: o.arguments ?? "{}" } });
    }
    if (content) r.onText?.(content);
    return { content, toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", usage: j.usage ? { promptTokens: j.usage.input_tokens ?? 0, completionTokens: j.usage.output_tokens ?? 0 } : null };
  }
}

export function createModelClient(style: "chat_completions" | "responses", o: HttpClientOptions): ModelClient {
  return style === "responses" ? new ResponsesClient(o) : new ChatCompletionsClient(o);
}
