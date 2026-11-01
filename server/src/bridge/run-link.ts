// The browser side of ONE run, independent of any single WebSocket. iOS WKWebView (tab switch, app background) pauses
// or drops the socket mid-run; the run must not be bound to that socket. A RunLink keeps the run's outstanding tool
// calls across a drop: the reconnecting tab (hello.resumeRunId) re-attaches, every outstanding call is replayed to it
// (the tab answers from its result cache or keeps executing; callIds dedupe), and events flow to the new socket.
// If no tab re-attaches within the grace window, or a fresh page (no resumeRunId) takes over, the run ends cleanly.
import type { BrowserLink } from "../agent/runtime.ts";
import type { ServerMessage, ToolResultEnvelope } from "./protocol.ts";
import { BridgeCallError } from "./pending-calls.ts";

/** The socket-level connection a RunLink drives (BrowserConnection implements it). */
export interface Conn { readonly sessionId: string; allowedTools: Set<string>; projectId: string; revision: number; alive: boolean; emit(m: ServerMessage): void }

interface Call { tool: string; args: Record<string, unknown>; opts: { expectProjectId: string | null; consent: { newProject: boolean }; timeoutMs: number }; resolve(r: ToolResultEnvelope): void; reject(e: Error): void; timer?: ReturnType<typeof setTimeout>;
  /** Project open in the tab when this call was first sent (undefined = never sent): server-side create_project dedupe. */
  sentProjectId?: string }

export const TAB_GONE = "This page reloaded or closed, so the run stopped. Finished changes are saved; send your message again to continue.";
/** The tab stayed away (iOS background) past the pause window. The run can be resumed with one tap for a while after. */
export const PAUSED_TOO_LONG = "The app was in the background too long, so the run stopped. Finished changes are saved; tap Resume to continue.";
export type RunLinkState = "running" | "paused" | "ended";

export class RunLink implements BrowserLink {
  conn: Conn | null;
  private calls = new Map<string, Call>();
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private waiters = new Set<(l: RunLink | null) => void>();
  gone = false;
  /** Why the link ended: the pause window ran out ("expired") or a fresh page / the run itself ended it ("replaced"). */
  endReason: "expired" | "replaced" | null = null;
  pausedAt = 0;
  private last: { sessionId: string; allowedTools: Set<string>; projectId: string; revision: number };
  /** `fallback` = where terminal run events go while no tab is attached (the user's current tab, if any). */
  constructor(readonly runId: string, conn: Conn, private graceMs: number, private fallback: () => Conn | null, readonly tabId = "") {
    this.conn = conn; this.last = { sessionId: conn.sessionId, allowedTools: conn.allowedTools, projectId: conn.projectId, revision: conn.revision };
  }
  private get c() { return this.conn ?? this.last; }
  get sessionId() { return this.c.sessionId; }
  get allowedTools() { return this.c.allowedTools; }
  get projectId() { return this.c.projectId; } set projectId(v: string) { this.last.projectId = v; if (this.conn) this.conn.projectId = v; }
  get revision() { return this.c.revision; } set revision(v: number) { this.last.revision = v; if (this.conn) this.conn.revision = v; }
  get attached() { return !!this.conn && this.conn.alive; }
  get state(): RunLinkState { return this.gone ? "ended" : this.attached ? "running" : "paused"; }

  emit(m: ServerMessage) {
    if (this.attached) return this.conn!.emit(m);
    if (m.type === "run_failed" || m.type === "run_completed") this.fallback()?.emit(m);
  }

  callTool(runId: string, callId: string, tool: string, args: Record<string, unknown>, opts: Call["opts"]): Promise<ToolResultEnvelope> {
    if (this.gone) return Promise.reject(new BridgeCallError("BROWSER_DISCONNECTED", TAB_GONE));
    if (this.calls.has(callId)) return Promise.reject(new Error(`duplicate callId ${callId}`));
    const p = new Promise<ToolResultEnvelope>((resolve, reject) => { this.calls.set(callId, { tool, args, opts, resolve, reject }); });
    if (this.attached) this.send(callId); // otherwise queued: replayed when a tab re-attaches
    return p.then((r) => { if (r.projectId) this.projectId = r.projectId; if (typeof r.revision === "number" && r.revision >= 0) this.revision = r.revision; return r; });
  }
  /** Emit (or re-emit) a call to the attached tab and (re)start its deadline; the deadline only runs while attached. */
  private send(callId: string) {
    const c = this.calls.get(callId); if (!c || !this.conn) return;
    clearTimeout(c.timer);
    if (c.sentProjectId === undefined) c.sentProjectId = this.conn.projectId;
    c.timer = setTimeout(() => { if (this.calls.get(callId) !== c) return; this.calls.delete(callId); c.reject(new BridgeCallError("TOOL_TIMEOUT", `${c.tool} did not finish within ${Math.round(c.opts.timeoutMs / 1000)} s`)); }, c.opts.timeoutMs);
    this.conn.emit({ type: "tool_call", sessionId: this.conn.sessionId, runId: this.runId, callId, tool: c.tool, arguments: c.args, expectProjectId: c.opts.expectProjectId, consent: c.opts.consent, deadlineMs: c.opts.timeoutMs });
  }
  settle(callId: string, from: Conn, r: ToolResultEnvelope): boolean {
    const c = this.calls.get(callId); if (!c || from !== this.conn) return false;
    clearTimeout(c.timer); this.calls.delete(callId); c.resolve(r); return true;
  }
  has(callId: string) { return this.calls.has(callId); }
  ids() { return [...this.calls.keys()]; }
  rejectAll(code: BridgeCallError["code"], message: string) { for (const [id, c] of this.calls) { clearTimeout(c.timer); this.calls.delete(id); c.reject(new BridgeCallError(code, message)); } }

  /** The socket dropped: hold every call (paused deadlines) for the grace window. */
  detach(conn: Conn) {
    if (conn !== this.conn) return;
    this.last = { sessionId: conn.sessionId, allowedTools: conn.allowedTools, projectId: conn.projectId, revision: conn.revision };
    this.conn = null; this.pausedAt = Date.now();
    for (const c of this.calls.values()) clearTimeout(c.timer);
    clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => this.end("expired"), this.graceMs);
    this.graceTimer.unref?.();
  }
  /** The same tab came back (hello.resumeRunId): continue on its new socket and replay outstanding calls. */
  rebind(conn: Conn) {
    if (this.gone) return false;
    clearTimeout(this.graceTimer); this.conn = conn; this.pausedAt = 0;
    conn.emit({ type: "session_reconnected", sessionId: conn.sessionId, runId: this.runId, resumed: true });
    for (const [id, c] of [...this.calls]) {
      // Dedupe a create_project that already ran before the drop but whose result was lost with the page (iOS discard):
      // the tab now has a different project open than when the call went out, so that project IS the result.
      if (c.tool === "gbk_create_project" && c.sentProjectId !== undefined && conn.projectId && conn.projectId !== c.sentProjectId) {
        this.calls.delete(id); c.resolve({ ok: true, projectId: conn.projectId, revision: conn.revision, data: { projectId: conn.projectId, recovered: true }, warnings: ["recovered after reconnect: the project had already been created"] });
        continue;
      }
      this.send(id);
    }
    for (const w of this.waiters) w(this); this.waiters.clear();
    return true;
  }
  /** No tab will come back (grace over, or a fresh page took over): fail outstanding calls; the runtime ends the run. */
  end(reason: "expired" | "replaced" = "replaced") {
    if (this.gone) return; this.gone = true; this.endReason = reason; clearTimeout(this.graceTimer);
    if (this.conn) { this.last.projectId = this.conn.projectId; this.conn = null; }
    this.rejectAll("BROWSER_DISCONNECTED", reason === "expired" ? PAUSED_TOO_LONG : TAB_GONE);
    for (const w of this.waiters) w(null); this.waiters.clear();
  }
  awaitReconnect(_ms: number, signal: AbortSignal): Promise<BrowserLink | null> {
    if (this.attached) return Promise.resolve(this);
    if (this.gone || signal.aborted) return Promise.resolve(null);
    return new Promise((res) => {
      const w = (l: RunLink | null) => { this.waiters.delete(w); res(l); };
      this.waiters.add(w);
      signal.addEventListener("abort", () => w(null), { once: true });
    });
  }
}
