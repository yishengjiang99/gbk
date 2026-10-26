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

  constructor(private c: WorkstationController, private onEvent: (m: ServerMessage) => void, private onState: (s: ConnState, detail?: string) => void, bridge?: BrowserToolBridge) {
    this.bridge = bridge ?? new BrowserToolBridge(c);
  }

  /** Tab came back (visibilitychange/pageshow/online/focus): reconnect now if the socket is gone or silently dead. */
  resume = () => {
    if (this.closed || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    const ws = this.ws;
    if (ws && ws.readyState === 1 && (this.busy > 0 || Date.now() - this.lastSeen < BridgeClient.STALE_MS)) { this.send({ type: "ping", t: Date.now() }); return; }
    if (ws && ws.readyState === 0) return; // still connecting
    if (!ws && !this.gaveUp) return; // a backoff retry is already scheduled (or this client was never connected)
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
    this.closed = false; this.gaveUp = false; this.watchLifecycle(); clearTimeout(this.retryTimer);
    this.onState(this.attempts ? "reconnecting" : "connecting");
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${apiBase()}/agent/ws`;
    const ws = new WebSocket(url); this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0; this.lastSeen = Date.now();
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
      this.bridge.cancel(); // results of a dead connection are never applied later
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === 4401) { this.onState("unauthorized"); return; }
      if (this.closed) { this.onState("offline"); return; }
      if (this.attempts >= this.maxReconnects) { this.gaveUp = true; this.onState("offline", "could not reconnect"); return; }
      const delay = Math.min(15_000, 500 * 2 ** this.attempts++);
      this.onState("reconnecting", `retry in ${Math.round(delay / 1000)}s`);
      this.retryTimer = setTimeout(() => { if (!this.closed) this.connect(); }, delay);
    };
  }

  close() { this.closed = true; clearTimeout(this.retryTimer); this.lifecycle?.(); this.lifecycle = undefined; this.ws?.close(1000); }
  /** Stop every tool call executing in this tab now (Stop button; the server also sends cancel_call). */
  cancelLocal() { this.bridge.cancel(); }
  get connected() { return this.ws?.readyState === 1; }

  send(m: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(m)); return true;
  }

  private async handle(m: ServerMessage) {
    switch (m.type) {
      case "session_ready": this.sessionId = m.sessionId; this.onState("connected"); break;
      case "ping": this.send({ type: "pong", t: m.t }); return;
      case "run_started": this.activeRunId = m.runId; break;
      // A finished/failed/cancelled run never leaves browser work behind (e.g. an in-page render after Stop).
      case "run_completed": case "run_failed": this.activeRunId = null; this.bridge.cancel(); break;
      case "cancel_call": this.bridge.cancel(m.callId); break;
      case "tool_call": {
        this.busy++; this.lastSeen = Date.now();
        const result = await this.bridge.execute(m, this.sessionId, (progress, detail) => this.send({ type: "tool_progress", sessionId: m.sessionId, runId: m.runId, callId: m.callId, progress, detail }));
        this.busy--; this.lastSeen = Date.now();
        this.send({ type: "tool_result", sessionId: m.sessionId, runId: m.runId, callId: m.callId, result });
        break;
      }
    }
    this.onEvent(m);
  }
}
