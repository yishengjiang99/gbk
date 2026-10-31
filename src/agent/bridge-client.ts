// WebSocket client: connects the page to wss://<origin>/api/agent/ws, sends the manifest, executes tool calls via
// BrowserToolBridge, reconnects with bounded backoff, and fans server events out to the UI.
import type { WorkstationController } from "../workstation/controller.ts";
import { BrowserToolBridge } from "./browser-bridge.ts";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "./protocol.ts";
import { reportError } from "../telemetry/error-reporter.ts";

export type ConnState = "idle" | "connecting" | "connected" | "reconnecting" | "offline" | "unauthorized";

export function apiBase(): string {
  let base = "/";
  try { base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"; } catch { /* non-Vite */ }
  return `${base.replace(/\/$/, "")}/api`;
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private unsub: (() => void) | undefined;
  sessionId = "";
  activeRunId: string | null = null;
  readonly tabId = Math.random().toString(36).slice(2, 10);
  readonly bridge: BrowserToolBridge;
  maxReconnects = 8;
  /** No server traffic for this long (server pings every ~20s) = a dead socket, e.g. after iOS suspended the tab. */
  static STALE_MS = 45_000;
  private lastSeen = 0; private busy = 0; private gaveUp = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private lifecycle: (() => void) | undefined;
  /** Tool calls of the active run, by callId: executing (no result yet) or finished. The server replays outstanding
   *  calls after a reconnect; a replay is answered from here instead of running the tool twice. */
  private calls = new Map<string, { runId: string; result?: ClientMessage & { type: "tool_result" } }>();
  /** Messages sent while the socket is still CONNECTING, flushed FIFO on open ahead of hello. Lives on the
   *  instance, so it survives reconnect attempts. Capped: past the cap send() fails again rather than queueing
   *  without bound. */
  private outbox: ClientMessage[] = [];
  private static OUTBOX_CAP = 50;

  constructor(private c: WorkstationController, private onEvent: (m: ServerMessage) => void, private onState: (s: ConnState, detail?: string) => void, bridge?: BrowserToolBridge) {
    this.bridge = bridge ?? new BrowserToolBridge(c);
  }

  /** Tab came back (visibilitychange/pageshow/online/focus): reconnect now if the socket is gone or silently dead. */
  resume = () => {
    if (this.closed || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    const ws = this.ws;
    if (ws && ws.readyState === 1 && (this.busy > 0 || Date.now() - this.lastSeen < BridgeClient.STALE_MS)) { this.send({ type: "ping", t: Date.now() }); return; }
    if (ws && ws.readyState === 0) return; // still connecting
    if (!ws && !this.gaveUp && !this.retryTimer) return; // never connected
    // A backoff retry may be up to 15 s away: back on screen means reconnect now (a run may be waiting on this tab).
    clearTimeout(this.retryTimer); this.attempts = Math.min(this.attempts, 1);
    console.warn("gbk-bridge: reconnecting after resume");
    if (ws) { this.ws = null; clearInterval(this.pingTimer); this.unsub?.(); this.unsub = undefined; try { ws.close(4000, "stale"); } catch { /* already closed */ } }
    this.connect();
  };

  private watchLifecycle() {
    if (this.lifecycle || typeof window === "undefined") return;
    const on = () => this.resume();
    document.addEventListener("visibilitychange", on); window.addEventListener("pageshow", on); window.addEventListener("online", on); window.addEventListener("focus", on);
    document.addEventListener("resume", on);
    this.lifecycle = () => { document.removeEventListener("visibilitychange", on); window.removeEventListener("pageshow", on); window.removeEventListener("online", on); window.removeEventListener("focus", on); document.removeEventListener("resume", on); };
  }

  connect() {
    this.closed = false; this.gaveUp = false; this.watchLifecycle(); clearTimeout(this.retryTimer); this.retryTimer = undefined;
    this.onState(this.attempts ? "reconnecting" : "connecting");
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${apiBase()}/agent/ws`;
    const ws = new WebSocket(url); this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0; this.lastSeen = Date.now();
      // Flush the outbox BEFORE hello: sends attempted while CONNECTING (e.g. reset_conversation from a
      // landing) must reach the server ahead of the session hello starts, in the order they were made.
      const queued = this.outbox; this.outbox = [];
      for (const q of queued) this.send(q);
      const p = this.c.project;
      this.send({ type: "hello", protocol: PROTOCOL_VERSION, tabId: this.tabId, manifest: this.bridge.manifest, projectId: p.id, revision: p.revision, ...(this.activeRunId ? { resumeRunId: this.activeRunId } : {}) });
      // Heartbeat: ping every 20s (server answers pong); resume() replaces a socket silent past STALE_MS when the tab comes back.
      this.pingTimer = setInterval(() => this.send({ type: "ping", t: Date.now() }), 20_000);
      let last = `${p.id}:${p.revision}`;
      this.unsub?.();
      this.unsub = this.c.subscribe((s) => { const k = `${s.project.id}:${s.project.revision}`; if (k !== last) { last = k; this.send({ type: "project_state", projectId: s.project.id, revision: s.project.revision }); } });
    };
    ws.onmessage = (ev) => { this.lastSeen = Date.now(); let m: ServerMessage; try { m = JSON.parse(String(ev.data)); } catch (e) { reportError(e, { where: "agent-ws.parse" }); return; } void this.handle(m); };
    ws.onclose = (ev) => {
      clearInterval(this.pingTimer); this.unsub?.(); this.unsub = undefined;
      // A dropped socket mid-run (iOS tab switch) keeps the run's tool calls going: the server holds the run and the
      // results are delivered on the next socket. Without an active run nothing can be waiting for them.
      if (!this.activeRunId) this.bridge.cancel();
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === 4401) { this.onState("unauthorized"); return; }
      if (this.closed) { this.onState("offline"); return; }
      if (this.attempts >= this.maxReconnects) { this.gaveUp = true; this.onState("offline", "could not reconnect"); return; }
      const delay = Math.min(15_000, 500 * 2 ** this.attempts++);
      this.onState("reconnecting", `retry in ${Math.round(delay / 1000)}s`);
      this.retryTimer = setTimeout(() => { this.retryTimer = undefined; if (!this.closed) this.connect(); }, delay);
    };
  }

  close() { this.closed = true; clearTimeout(this.retryTimer); this.lifecycle?.(); this.lifecycle = undefined; this.ws?.close(1000); }
  /** Stop every tool call executing in this tab now (Stop button; the server also sends cancel_call). */
  cancelLocal() { this.bridge.cancel(); }
  get connected() { return this.ws?.readyState === 1; }

  send(m: ClientMessage): boolean {
    if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(m)); return true; }
    // Still CONNECTING: queue instead of dropping (flushed FIFO on open, ahead of hello). Past the cap the
    // send fails as before rather than queueing without bound. No socket at all also fails, queueing nothing.
    if (this.ws && this.ws.readyState === 0 && this.outbox.length < BridgeClient.OUTBOX_CAP) { this.outbox.push(m); return true; }
    return false;
  }

  private async handle(m: ServerMessage) {
    switch (m.type) {
      case "session_ready": this.sessionId = m.sessionId; this.onState("connected"); break;
      case "session_reconnected": if (!m.resumed && m.runId === this.activeRunId) { this.activeRunId = null; this.calls.clear(); this.bridge.cancel(); } break;
      case "ping": this.send({ type: "pong", t: m.t }); return;
      case "run_started": this.activeRunId = m.runId; this.calls.clear(); this.c.supersedePendingProposals(); this.c.setActiveRun?.(m.runId); break;
      // A finished/failed/cancelled run never leaves browser work behind (e.g. an in-page render after Stop).
      case "run_completed": case "run_failed": if (!this.activeRunId || m.runId === this.activeRunId) { this.activeRunId = null; this.calls.clear(); this.bridge.cancel(); this.c.setActiveRun?.(null); } break;
      case "cancel_call": this.bridge.cancel(m.callId); break;
      case "tool_call": {
        const known = this.calls.get(m.callId);
        if (known) { if (known.result) this.send({ ...known.result, sessionId: this.sessionId }); return; } // replay after reconnect
        this.calls.set(m.callId, { runId: m.runId });
        this.busy++; this.lastSeen = Date.now();
        // Executes against this page's session; the result goes to whichever socket is live when it finishes.
        const result = await this.bridge.execute({ ...m, sessionId: this.sessionId }, this.sessionId, (progress, detail) => this.send({ type: "tool_progress", sessionId: this.sessionId, runId: m.runId, callId: m.callId, progress, detail }));
        this.busy--; this.lastSeen = Date.now();
        const msg = { type: "tool_result" as const, sessionId: this.sessionId, runId: m.runId, callId: m.callId, result };
        const entry = this.calls.get(m.callId); if (entry) entry.result = msg; // kept for a replay if this send is lost
        this.send(msg);
        break;
      }
    }
    this.onEvent(m);
  }
}
