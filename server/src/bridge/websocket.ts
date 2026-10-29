// WebSocket endpoint /api/agent/ws: origin + session-cookie auth on upgrade, manifest reconciliation, typed
// messages, tool RPC with pending-call tracking, run lifecycle (one run per user by default), cancel, heartbeat.
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "../config.ts";
import { llmConfigured } from "../config.ts";
import { COOKIE, parseCookies, type SessionStore } from "../security/authentication.ts";
import { originAllowed } from "../security/authorization.ts";
import type { RateLimiter } from "../security/rate-limit.ts";
import { PendingCalls, BridgeCallError } from "./pending-calls.ts";
import { SessionRegistry } from "./session-registry.ts";
import { RunLink } from "./run-link.ts";
import { MAX_FRAME_BYTES, PROTOCOL_VERSION, type ClientMessage, type ServerMessage, type ToolResultEnvelope } from "./protocol.ts";
import type { AgentRuntime, BrowserLink } from "../agent/runtime.ts";
import type { ToolCatalog } from "../agent/tool-catalog.ts";
import type { ConversationStore } from "../persistence/conversations.ts";
import { RunSlots } from "../agent/limits.ts";

type Log = (o: Record<string, unknown>) => void;
const rid = (p: string) => `${p}_${randomBytes(8).toString("hex")}`;

export class BrowserConnection implements BrowserLink {
  readonly sessionId: string;
  allowedTools = new Set<string>();
  projectId = ""; revision = 0; ready = false; alive = true;
  readonly pending = new PendingCalls();
  constructor(public user: string, public authSessionId: string, private ws: WebSocket, private hub: AgentHub) { this.sessionId = rid("bs"); }
  emit(m: ServerMessage) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  close(code: number, reason: string) { try { this.ws.close(code, reason); } catch { /* closed */ } }
  callTool(runId: string, callId: string, tool: string, args: Record<string, unknown>, opts: { expectProjectId: string | null; consent: { newProject: boolean }; timeoutMs: number }): Promise<ToolResultEnvelope> {
    if (!this.alive || this.ws.readyState !== 1) return Promise.reject(new BridgeCallError("BROWSER_DISCONNECTED", "browser not connected"));
    const p = this.pending.add(callId, runId, tool, opts.timeoutMs);
    this.emit({ type: "tool_call", sessionId: this.sessionId, runId, callId, tool, arguments: args, expectProjectId: opts.expectProjectId, consent: opts.consent, deadlineMs: opts.timeoutMs });
    return p.then((r) => { this.projectId = r.projectId || this.projectId; if (typeof r.revision === "number" && r.revision >= 0) this.revision = r.revision; return r; });
  }
  awaitReconnect(ms: number, signal: AbortSignal) { return this.hub.registry.waitFor(this.user, ms, signal).then((l) => (l && l.ready ? l : l ? waitReady(l, 5000) : null)); }
}
const waitReady = async (l: BrowserConnection, ms: number) => { const t0 = Date.now(); while (!l.ready && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return l.ready ? l : null; };

export class AgentHub {
  readonly registry = new SessionRegistry<BrowserConnection>();
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  private runs = new Map<string, { user: string; abort: AbortController; link: RunLink; origin: BrowserConnection; done?: Promise<void> }>();
  private slots: RunSlots;
  constructor(private cfg: Config, private sessions: SessionStore, private runtime: AgentRuntime, private catalog: ToolCatalog, private convs: ConversationStore, private msgLimiter: RateLimiter, private ipLimiter: RateLimiter, private log: Log) {
    this.slots = new RunSlots(cfg.agent.maxConcurrentRunsPerUser);
    const hb = setInterval(() => { for (const c of this.wss.clients) { const s = c as WebSocket & { _alive?: boolean }; if (s._alive === false) { c.terminate(); continue; } s._alive = false; c.ping(); } }, 30_000);
    hb.unref?.();
  }
  get activeRuns() { return this.runs.size; }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const reject = (code: number, msg: string) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); };
    const ip = clientIp(req);
    if (!this.ipLimiter.take(`ws:${ip}`)) return reject(429, "Too Many Requests");
    if (!originAllowed(this.cfg, req.headers.origin)) { this.log({ evt: "ws_reject", reason: "origin", ip }); return reject(403, "Forbidden"); }
    const s = this.sessions.fromCookie(parseCookies(req.headers.cookie)[COOKIE]);
    if (!s) { this.log({ evt: "ws_reject", reason: "auth", ip }); return reject(401, "Unauthorized"); }
    if (!this.cfg.enabled) return reject(503, "Service Unavailable");
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, s.user, s.id));
  }

  private onConnection(ws: WebSocket, user: string, authSessionId: string) {
    const conn = new BrowserConnection(user, authSessionId, ws, this);
    (ws as WebSocket & { _alive?: boolean })._alive = true;
    ws.on("pong", () => { (ws as WebSocket & { _alive?: boolean })._alive = true; });
    this.log({ evt: "ws_open", user, session: conn.sessionId });
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return conn.emit({ type: "error", code: "BAD_FRAME", message: "binary frames are not accepted" });
      if (!this.sessions.isLive(authSessionId)) { conn.close(4401, "session expired"); return; }
      let m: ClientMessage;
      try { m = JSON.parse(String(raw)); } catch { return conn.emit({ type: "error", code: "BAD_FRAME", message: "invalid JSON" }); }
      if (!m || typeof m !== "object" || typeof (m as { type?: unknown }).type !== "string") return conn.emit({ type: "error", code: "BAD_FRAME", message: "missing type" });
      this.onMessage(conn, m);
    });
    ws.on("close", () => {
      conn.alive = false; this.registry.detach(conn);
      conn.pending.rejectAll("BROWSER_DISCONNECTED", "browser tab disconnected");
      // A run outlives its socket (iOS pauses/drops it on tab switch): hold its calls for the grace window.
      for (const r of this.runs.values()) r.link.detach(conn);
      this.log({ evt: "ws_close", user, session: conn.sessionId });
    });
  }

  private onMessage(conn: BrowserConnection, m: ClientMessage) {
    switch (m.type) {
      case "hello": {
        if (m.protocol !== PROTOCOL_VERSION) { conn.emit({ type: "error", code: "PROTOCOL_MISMATCH", message: `server speaks protocol ${PROTOCOL_VERSION}; reload the page` }); conn.close(4400, "protocol"); return; }
        const { accepted, rejected } = this.catalog.reconcile(m.manifest?.tools);
        conn.allowedTools = new Set(accepted); conn.projectId = String(m.projectId ?? "").slice(0, 100); conn.revision = Number(m.revision) || 0; conn.ready = true;
        this.registry.attach(conn);
        const conv = this.convs.get(conn.user);
        conn.emit({ type: "session_ready", sessionId: conn.sessionId, user: conn.user, model: this.cfg.llm.model, models: this.cfg.llm.models, provider: this.cfg.llm.provider, llmConfigured: llmConfigured(this.cfg), manifestHash: this.catalog.hash, acceptedTools: accepted, rejectedTools: rejected, history: conv.history.slice(-40), limits: { maxToolSteps: this.cfg.agent.maxToolSteps, maxInputChars: this.cfg.agent.maxInputChars } });
        // The same tab reconnecting re-attaches to its in-flight run (outstanding tool calls are replayed). A fresh page
        // (reload, iOS /studio?new=...) has no resumeRunId: the tab that ran this user's detached runs is gone, end them.
        const resume = m.resumeRunId ? this.runs.get(String(m.resumeRunId)) : undefined;
        if (resume && resume.user === conn.user && resume.link.rebind(conn)) { /* resumed */ }
        else if (m.resumeRunId) conn.emit({ type: "session_reconnected", sessionId: conn.sessionId, runId: String(m.resumeRunId), resumed: false, reason: "that run is no longer active" });
        for (const r of this.runs.values()) if (r !== resume && r.user === conn.user && !r.link.attached) r.link.end();
        this.log({ evt: "hello", user: conn.user, accepted: accepted.length, rejected: rejected.length, hashMatch: m.manifest?.hash === this.catalog.hash });
        return;
      }
      case "ping": conn.emit({ type: "pong", t: Number(m.t) || 0 }); return;
      case "pong": return;
      case "project_state": conn.projectId = String(m.projectId ?? "").slice(0, 100); conn.revision = Number(m.revision) || 0; return;
      case "tool_result": {
        if (m.sessionId !== conn.sessionId) { this.log({ evt: "stray_result", reason: "session" }); return; } // cross-session results are dropped
        const r = m.result;
        if (!r || typeof r.ok !== "boolean") return;
        const run = this.runs.get(String(m.runId));
        const env: ToolResultEnvelope = { ok: r.ok, projectId: String(r.projectId ?? ""), revision: Number(r.revision), data: r.data, warnings: Array.isArray(r.warnings) ? r.warnings.slice(0, 20).map(String) : [], ...(r.error ? { error: { code: String(r.error.code).slice(0, 60), message: String(r.error.message).slice(0, 1000) } } : {}) };
        // Agent runs settle on their RunLink (survives socket drops); MCP renders call this socket directly.
        const settled = run && run.user === conn.user ? run.link.settle(String(m.callId), conn, env) : conn.pending.settle(String(m.callId), String(m.runId), env);
        if (!settled) this.log({ evt: "stray_result", reason: "unknown or duplicate callId" });
        return;
      }
      case "tool_progress": { const run = this.runs.get(String(m.runId)); if (run && run.user === conn.user && run.link.conn === conn && run.link.has(String(m.callId))) conn.emit({ type: "tool_progress", runId: m.runId, callId: m.callId, progress: Number(m.progress) || 0, detail: String(m.detail ?? "").slice(0, 80) }); return; }
      case "cancel_run": { const run = this.runs.get(String(m.runId)); if (run && run.user === conn.user) { run.abort.abort(); for (const callId of run.link.ids()) conn.emit({ type: "cancel_call", runId: String(m.runId), callId }); run.link.rejectAll("OPERATION_CANCELLED", "cancelled"); this.log({ evt: "cancel", user: conn.user, runId: m.runId }); } return; }
      case "reset_conversation": if ([...this.runs.values()].some((r) => r.user === conn.user)) return conn.emit({ type: "error", code: "RUN_ACTIVE", message: "stop the current run first" }); this.convs.reset(conn.user); return;
      case "user_message": return void this.startRun(conn, m);
      default: conn.emit({ type: "error", code: "UNKNOWN_TYPE", message: "unknown message type" });
    }
  }

  private async startRun(conn: BrowserConnection, m: Extract<ClientMessage, { type: "user_message" }>) {
    if (!conn.ready) return conn.emit({ type: "error", code: "NOT_READY", message: "send hello first" });
    const text = typeof m.text === "string" ? m.text : "";
    if (!text.trim()) return conn.emit({ type: "error", code: "EMPTY", message: "empty message" });
    if (text.length > this.cfg.agent.maxInputChars) return conn.emit({ type: "error", code: "INPUT_TOO_LONG", message: `messages are limited to ${this.cfg.agent.maxInputChars} characters` });
    if (!this.cfg.enabled) return conn.emit({ type: "error", code: "DISABLED", message: "the Composer is switched off" });
    if (!this.msgLimiter.take(conn.user)) return conn.emit({ type: "error", code: "RATE_LIMITED", message: `too many messages; wait ${this.msgLimiter.retryAfterSec(conn.user)} s` });
    if (!this.slots.acquire(conn.user)) {
      // A run whose tab closed is only waiting out the reconnect grace. A new message from a live tab supersedes it
      // (the user can't see or stop it), so abort it and take the slot instead of answering RUN_ACTIVE for minutes.
      const orphanIds = [...this.runs].filter(([, r]) => r.user === conn.user && r.origin !== conn).map(([id]) => id);
      const orphans = orphanIds.map((id) => this.runs.get(id)!);
      if (orphans.length) { for (const r of orphans) { r.abort.abort(); if (r.link.attached) for (const callId of r.link.ids()) r.link.conn!.emit({ type: "cancel_call", runId: r.link.runId, callId }); r.link.rejectAll("OPERATION_CANCELLED", "superseded by a new message"); }
        await Promise.race([Promise.all(orphans.map((r) => r.done)), new Promise((ok) => setTimeout(ok, 5000))]); this.log({ evt: "run_superseded", user: conn.user, n: orphans.length }); }
      if (!this.slots.acquire(conn.user)) return conn.emit({ type: "error", code: "RUN_ACTIVE", message: "a run is already in progress; stop it or wait" });
    }
    const model = typeof m.model === "string" && m.model ? m.model : this.cfg.llm.model;
    // #162: a remix session names its source song; keep only bounded, plain-data fields.
    const rawRemix = m.remixOf;
    const remixJson = rawRemix?.summary ? JSON.stringify(rawRemix.summary) : "";
    const remixOf = rawRemix && typeof rawRemix.slug === "string" && typeof rawRemix.title === "string"
      ? { slug: rawRemix.slug.slice(0, 100), title: rawRemix.title.slice(0, 120), ...(remixJson && remixJson.length <= 8192 ? { summary: rawRemix.summary } : {}) }
      : undefined;
    const runId = rid("run"); const abort = new AbortController();
    let finished!: () => void; const done = new Promise<void>((ok) => { finished = ok; });
    const link = new RunLink(runId, conn, this.cfg.agent.reconnectGraceMs, () => this.registry.get(conn.user));
    this.runs.set(runId, { user: conn.user, abort, link, origin: conn, done });
    const conv = this.convs.get(conn.user);
    conn.emit({ type: "run_started", runId, clientMessageId: String(m.clientMessageId ?? "").slice(0, 60), text: text.slice(0, 200) });
    const t0 = Date.now();
    try {
      const r = await this.runtime.run({ runId, user: conn.user, text, model, conv, link, signal: abort.signal, log: this.log, remixOf });
      this.log({ evt: "run_end", user: conn.user, runId, status: r.status, code: r.code, steps: r.steps, ms: Date.now() - t0 });
    } catch (e) {
      this.log({ evt: "run_crash", runId, err: (e as Error).message });
      link.emit({ type: "run_failed", runId, code: "INTERNAL_ERROR", message: "internal error", retryable: true });
    } finally {
      link.end(); this.runs.delete(runId); this.slots.release(conn.user); this.convs.save(conv); finished();
    }
  }
}

export function clientIp(req: IncomingMessage): string {
  const xr = req.headers["x-real-ip"]; // set by our nginx; the backend only listens on 127.0.0.1
  return (typeof xr === "string" && xr) || req.socket.remoteAddress || "?";
}
