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

  constructor(private c: WorkstationController, private onEvent: (m: ServerMessage) => void, private onState: (s: ConnState, detail?: string) => void, bridge?: BrowserToolBridge) {
    this.bridge = bridge ?? new BrowserToolBridge(c);
  }

  connect() {
    this.closed = false;
    this.onState(this.attempts ? "reconnecting" : "connecting");
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${apiBase()}/agent/ws`;
    const ws = new WebSocket(url); this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      const p = this.c.project;
      this.send({ type: "hello", protocol: PROTOCOL_VERSION, tabId: this.tabId, manifest: this.bridge.manifest, projectId: p.id, revision: p.revision, ...(this.activeRunId ? { resumeRunId: this.activeRunId } : {}) });
      this.pingTimer = setInterval(() => this.send({ type: "ping", t: Date.now() }), 20_000);
      let last = `${p.id}:${p.revision}`;
      this.unsub?.();
      this.unsub = this.c.subscribe((s) => { const k = `${s.project.id}:${s.project.revision}`; if (k !== last) { last = k; this.send({ type: "project_state", projectId: s.project.id, revision: s.project.revision }); } });
    };
    ws.onmessage = (ev) => { let m: ServerMessage; try { m = JSON.parse(String(ev.data)); } catch (e) { reportError(e, { where: "agent-ws.parse" }); return; } void this.handle(m); };
    ws.onclose = (ev) => {
      clearInterval(this.pingTimer); this.unsub?.(); this.unsub = undefined;
      this.bridge.cancel(); // results of a dead connection are never applied later
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === 4401) { this.onState("unauthorized"); return; }
      if (this.closed) { this.onState("offline"); return; }
      if (this.attempts >= this.maxReconnects) { this.onState("offline", "could not reconnect"); return; }
      const delay = Math.min(15_000, 500 * 2 ** this.attempts++);
      this.onState("reconnecting", `retry in ${Math.round(delay / 1000)}s`);
      setTimeout(() => { if (!this.closed) this.connect(); }, delay);
    };
  }

  close() { this.closed = true; this.ws?.close(1000); }
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
      case "run_completed": case "run_failed": this.activeRunId = null; break;
      case "cancel_call": this.bridge.cancel(m.callId); break;
      case "tool_call": {
        const result = await this.bridge.execute(m, this.sessionId, (progress, detail) => this.send({ type: "tool_progress", sessionId: m.sessionId, runId: m.runId, callId: m.callId, progress, detail }));
        this.send({ type: "tool_result", sessionId: m.sessionId, runId: m.runId, callId: m.callId, result });
        break;
      }
    }
    this.onEvent(m);
  }
}
