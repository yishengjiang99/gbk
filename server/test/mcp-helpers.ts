// Minimal MCP Streamable-HTTP client for tests: real HTTP, real SDK transport, SSE-aware response parsing.
export interface McpResponse { status: number; headers: Headers; rpc?: { result?: unknown; error?: { code: number; message: string } }; sessionId?: string }

export class McpClient {
  sessionId: string | null = null;
  private seq = 0;
  constructor(private base: string, private headers: Record<string, string> = {}) {}
  setHeaders(h: Record<string, string>) { this.headers = h; }

  async send(method: string, params: unknown = {}, opts: { notify?: boolean; headers?: Record<string, string> } = {}): Promise<McpResponse> {
    const id = opts.notify ? undefined : ++this.seq;
    const res = await fetch(`${this.base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}), ...this.headers, ...(opts.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, params }),
    });
    const sid = res.headers.get("mcp-session-id"); if (sid) this.sessionId = sid;
    const text = await res.text();
    let rpc: McpResponse["rpc"];
    if (text) {
      // Streamable HTTP replies are JSON or an SSE stream of JSON-RPC messages; take the one with our id.
      const msgs = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5)) as { id?: number; result?: unknown; error?: { code: number; message: string } }; } catch { return null; } }).filter((m) => m !== null);
      if (msgs.length) rpc = msgs.find((m) => m.id === id) ?? msgs[msgs.length - 1];
      else { try { rpc = JSON.parse(text) as never; } catch { rpc = undefined; } }
    }
    return { status: res.status, headers: res.headers, rpc, sessionId: this.sessionId ?? undefined };
  }
  async initialize() {
    const r = await this.send("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gbk-test", version: "0" } });
    if (r.status === 200 && this.sessionId) await this.send("notifications/initialized", {}, { notify: true });
    return r;
  }
  /** Call a tool and return its structuredContent; throws with the tool error payload when isError. */
  async call<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.send("tools/call", { name, arguments: args });
    if (r.rpc?.error) throw new Error(`JSON-RPC error: ${JSON.stringify(r.rpc.error)}`);
    const result = r.rpc?.result as { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] } | undefined;
    if (!result) throw new Error(`no result (HTTP ${r.status})`);
    if (result.isError) { const err = new Error(result.content?.[0]?.text ?? "tool error"); (err as { payload?: unknown }).payload = JSON.parse(result.content?.[0]?.text ?? "{}"); throw err; }
    return result.structuredContent as T;
  }
  async callRaw(name: string, args: Record<string, unknown> = {}) { return this.send("tools/call", { name, arguments: args }); }
}
