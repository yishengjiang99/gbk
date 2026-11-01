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
  /** The page's per-tab id from hello (persisted in sessionStorage, so it survives an iOS page discard + reload). */
  tabId = "";
  /** Last time this socket showed signs of life (pong or any frame). */
  lastSeen = Date.now();
  readonly pending = new PendingCalls();
  constructor(public user: string, public authSessionId: string, private ws: WebSocket, private hub: AgentHub) { this.sessionId = rid("bs"); }
  emit(m: ServerMessage) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  close(code: number, reason: string) { try { this.ws.close(code, reason); } catch { /* closed */ } }
  /** The page reports it is going to the background (iOS may freeze it any moment): probe now and drop the socket if it
   *  goes silent, so the run pauses within seconds instead of after the heartbeat's two missed pongs. */
  probe(ms: number) {
    const t = Date.now(); try { this.ws.ping(); } catch { /* closed */ }
    setTimeout(() => { if (this.alive && this.lastSeen <= t) { this.hub.log({ evt: "ws_suspect_drop", user: this.user, session: this.sessionId }); this.ws.terminate(); } }, ms).unref?.();
  }
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
  /** Runs that stopped because their tab stayed away past the grace window: one per user, resumable by the same tab. */
  private resumable = new Map<string, { runId: string; tabId: string; text: string; model: string; until: number }>();
  /** Resume attempts (hello.resumeRunId + resume_run) per user: timestamps in the last minute. */
  private resumeHits = new Map<string, number[]>();
  static RESUME_PER_MINUTE = 5;
  constructor(private cfg: Config, private sessions: SessionStore, private runtime: AgentRuntime, private catalog: ToolCatalog, private convs: ConversationStore, private msgLimiter: RateLimiter, private ipLimiter: RateLimiter, readonly log: Log) {
    this.slots = new RunSlots(cfg.agent.maxConcurrentRunsPerUser);
    // Heartbeat: a socket that missed 2 pongs in a row is dead (iOS froze the page with TCP half-open): terminate it so
    // its run pauses now rather than minutes later.
    const hb = setInterval(() => { for (const c of this.wss.clients) { const s = c as WebSocket & { _alive?: boolean; _missed?: number }; if (s._alive === false) { s._missed = (s._missed ?? 0) + 1; if (s._missed >= 2) { c.terminate(); continue; } } else s._missed = 0; s._alive = false; c.ping(); } }, cfg.agent.heartbeatMs);
    hb.unref?.();
  }
  get activeRuns() { return this.runs.size; }
  private resumeAllowed(user: string) {
    const now = Date.now(); const hits = (this.resumeHits.get(user) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= AgentHub.RESUME_PER_MINUTE) { this.resumeHits.set(user, hits); return false; }
    hits.push(now); this.resumeHits.set(user, hits); return true;
  }

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
    ws.on("pong", () => { (ws as WebSocket & { _alive?: boolean })._alive = true; conn.lastSeen = Date.now(); });
    this.log({ evt: "ws_open", user, session: conn.sessionId });
    ws.on("message", (raw, isBinary) => {
      conn.lastSeen = Date.now(); (ws as WebSocket & { _alive?: boolean })._alive = true;
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
      // At most one paused run held per user: older ones end now.
      const held = [...this.runs.values()].filter((r) => r.user === user && r.link.state === "paused").sort((a, b) => b.link.pausedAt - a.link.pausedAt);
      for (const r of held.slice(1)) r.link.end();
      this.log({ evt: "ws_close", user, session: conn.sessionId });
    });
  }

  private onMessage(conn: BrowserConnection, m: ClientMessage) {
    switch (m.type) {
      case "hello": {
        if (m.protocol !== PROTOCOL_VERSION) { conn.emit({ type: "error", code: "PROTOCOL_MISMATCH", message: `server speaks protocol ${PROTOCOL_VERSION}; reload the page` }); conn.close(4400, "protocol"); return; }
        const { accepted, rejected } = this.catalog.reconcile(m.manifest?.tools);
        conn.tabId = typeof m.tabId === "string" ? m.tabId.slice(0, 64) : "";
        conn.allowedTools = new Set(accepted); conn.projectId = String(m.projectId ?? "").slice(0, 100); conn.revision = Number(m.revision) || 0; conn.ready = true;
        this.registry.attach(conn);
        const conv = this.convs.get(conn.user);
        conn.emit({ type: "session_ready", sessionId: conn.sessionId, user: conn.user, model: this.cfg.llm.model, models: this.cfg.llm.models, provider: this.cfg.llm.provider, llmConfigured: llmConfigured(this.cfg), manifestHash: this.catalog.hash, acceptedTools: accepted, rejectedTools: rejected, history: conv.history.slice(-40), limits: { maxToolSteps: this.cfg.agent.maxToolSteps, maxInputChars: this.cfg.agent.maxInputChars } });
        // The same tab reconnecting re-attaches to its in-flight run (outstanding tool calls are replayed). A fresh page
        // (reload, iOS /studio?new=...) has no resumeRunId: the tab that ran this user's detached runs is gone, end them.
        // A resume must come from the same signed-in user AND the same tab (tabId) that started the run; attempts are rate limited.
        const wantId = m.resumeRunId ? String(m.resumeRunId).slice(0, 64) : "";
        const limited = !!wantId && !this.resumeAllowed(conn.user);
        const cand = wantId && !limited ? this.runs.get(wantId) : undefined;
        const resume = cand && cand.user === conn.user && cand.link.tabId === conn.tabId ? cand : undefined;
        const late = this.resumable.get(conn.user);
        if (resume && resume.link.rebind(conn)) this.log({ evt: "run_resumed", user: conn.user, runId: wantId, pausedMs: Date.now() - (resume.link.pausedAt || Date.now()) });
        else if (wantId && !limited && !cand && late && late.runId === wantId && late.tabId === conn.tabId && late.until > Date.now())
          conn.emit({ type: "session_reconnected", sessionId: conn.sessionId, runId: wantId, resumed: false, resumable: true, reason: "paused too long" });
        else if (wantId) {
          const denied = limited || (!!cand && !resume);
          if (denied) this.log({ evt: "resume_denied", user: conn.user, runId: wantId, reason: limited ? "rate" : "mismatch" });
          conn.emit({ type: "session_reconnected", sessionId: conn.sessionId, runId: wantId, resumed: false, ...(denied ? { code: "RESUME_DENIED" } : {}), reason: limited ? "too many resume attempts" : denied ? "that run belongs to another tab" : "that run is no longer active" });
        }
        for (const r of this.runs.values()) if (r !== resume && r.user === conn.user && !r.link.attached) r.link.end();
        this.log({ evt: "hello", user: conn.user, accepted: accepted.length, rejected: rejected.length, hashMatch: m.manifest?.hash === this.catalog.hash });
        return;
      }
      case "backgrounded": conn.probe(5000); return;
      case "resume_run": return void this.resumeRun(conn, m);
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

  /** One-tap Resume after a run stopped for pausing too long: same user + same tab + inside the window, rate limited. */
  private resumeRun(conn: BrowserConnection, m: Extract<ClientMessage, { type: "resume_run" }>) {
    const r = this.resumable.get(conn.user); const runId = String(m.runId ?? "").slice(0, 64);
    if (!this.resumeAllowed(conn.user)) return conn.emit({ type: "error", code: "RATE_LIMITED", message: "too many resume attempts; wait a minute" });
    if (!r || r.runId !== runId || r.tabId !== conn.tabId || r.until <= Date.now()) { this.log({ evt: "resume_denied", user: conn.user, runId, reason: r ? "mismatch" : "none" }); return conn.emit({ type: "error", code: "RESUME_DENIED", message: "That run can't be resumed anymore. Send your message again." }); }
    this.resumable.delete(conn.user);
    this.log({ evt: "run_resume_late", user: conn.user, runId });
    const note = "[resume] The previous run stopped because the app was in the background too long. Re-read the open project state, then finish this request: ";
    return this.startRun(conn, { type: "user_message", clientMessageId: String(m.clientMessageId ?? "").slice(0, 60), text: (note + r.text).slice(0, this.cfg.agent.maxInputChars), model: r.model });
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
    // #163 #3: explicit run intent from the UI entry point (bounded to the enum; anything else = derive).
    // Legacy clients could also send mode:"remix" plus a remixOf payload: both are ignored — a remix is
    // now just a chat opened on the fork, and its runs derive their mode the ordinary way.
    const rawMode = (m as { mode?: unknown }).mode;
    const mode = rawMode === "new" || rawMode === "edit" ? rawMode : undefined;
    const runId = rid("run"); const abort = new AbortController();
    let finished!: () => void; const done = new Promise<void>((ok) => { finished = ok; });
    const link = new RunLink(runId, conn, this.cfg.agent.reconnectGraceMs, () => this.registry.get(conn.user), conn.tabId);
    this.resumable.delete(conn.user); // a new run supersedes an older resumable one
    this.runs.set(runId, { user: conn.user, abort, link, origin: conn, done });
    const conv = this.convs.get(conn.user);
    conn.emit({ type: "run_started", runId, clientMessageId: String(m.clientMessageId ?? "").slice(0, 60), text: text.slice(0, 200) });
    const t0 = Date.now();
    try {
      const r = await this.runtime.run({ runId, user: conn.user, text, model, conv, link, signal: abort.signal, log: this.log, mode, onCheckpoint: () => this.convs.save(conv) });
      this.log({ evt: "run_end", user: conn.user, runId, status: r.status, code: r.code, steps: r.steps, ms: Date.now() - t0 });
      if (r.code === "RUN_PAUSED_TOO_LONG") this.resumable.set(conn.user, { runId, tabId: link.tabId, text: text.startsWith("[resume]") ? text.slice(text.indexOf(": ") + 2) : text, model, until: Date.now() + this.cfg.agent.resumeWindowMs });
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
