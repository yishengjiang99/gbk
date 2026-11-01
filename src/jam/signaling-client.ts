// /api/jam/ws client: fresh one-use ticket per attempt, ticket as the first frame, exponential backoff with jitter,
// bounded signaling-loss grace, ping/pong clock samples. Transport factories are injected for tests.
import type { ClientFrame, ServerFrame } from "../../shared/jam/signaling.ts";

export interface WsLike { readyState: number; send(s: string): void; close(code?: number, reason?: string): void; onopen: ((e: unknown) => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onclose: ((e: { code: number }) => void) | null; onerror: ((e: unknown) => void) | null }
export interface SignalingDeps { ticket(): Promise<{ ticket: string; url: string }>; openWs(url: string): WsLike; now(): number; setTimer(f: () => void, ms: number): unknown; clearTimer(t: unknown): void; random(): number }
export type SignalingState = "connecting" | "open" | "reconnecting" | "suspended" | "closed";
export const FINAL_CODES = new Set([4000, 4403, 4409]); // removed/ended, not a member, replaced elsewhere

export class SignalingClient {
  state: SignalingState = "closed"; attempts = 0; reconnects = 0;
  private ws: WsLike | null = null; private pingTimer: unknown = null; private retryTimer: unknown = null; private lostAt = 0; private stopped = false;
  onFrame: (f: ServerFrame) => void = () => {};
  onState: (s: SignalingState) => void = () => {};
  onClockSample: (s: { t0: number; ts: number; t3: number }) => void = () => {};
  constructor(private d: SignalingDeps, private graceMs = 60_000, private pingMs = 1000) {}
  start() { this.stopped = false; this.lostAt = 0; void this.connect(); }
  private set(s: SignalingState) { if (this.state !== s) { this.state = s; this.onState(s); } }
  private async connect() {
    if (this.stopped) return;
    this.set(this.attempts ? "reconnecting" : "connecting"); this.attempts++;
    let t: { ticket: string; url: string };
    try { t = await this.d.ticket(); } catch (e) { const st = (e as { status?: number }).status; if (st === 404 || st === 401) { this.set("closed"); this.onFrame({ type: "error", code: "NOT_MEMBER", message: (e as Error).message }); return; } return this.retry(); }
    if (this.stopped) return;
    const ws = this.d.openWs(t.url); this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", v: 1, ticket: t.ticket } satisfies ClientFrame));
    ws.onmessage = (ev) => {
      let f: ServerFrame; try { f = JSON.parse(String(ev.data)); } catch { return; }
      if (f.type === "welcome") { this.attempts = 0; this.lostAt = 0; this.set("open"); this.startPing(); }
      if (f.type === "pong") this.onClockSample({ t0: f.t, ts: f.serverTime, t3: this.d.now() });
      this.onFrame(f);
    };
    ws.onerror = () => { /* close follows */ };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return; this.ws = null; this.stopPing();
      if (this.stopped) return;
      if (FINAL_CODES.has(ev.code)) { this.set("closed"); return; }
      this.retry();
    };
  }
  private retry() {
    if (this.stopped) return;
    if (!this.lostAt) this.lostAt = this.d.now();
    if (this.d.now() - this.lostAt > this.graceMs) { this.set("suspended"); return; }
    this.reconnects++; this.set("reconnecting");
    const delay = Math.min(10_000, 500 * 2 ** Math.min(this.attempts, 5)) * (0.5 + this.d.random() * 0.5);
    this.retryTimer = this.d.setTimer(() => void this.connect(), delay);
  }
  private startPing() { this.stopPing(); const tick = () => { this.send({ type: "ping", t: this.d.now() }); this.pingTimer = this.d.setTimer(tick, this.pingMs); }; tick(); }
  private stopPing() { if (this.pingTimer) this.d.clearTimer(this.pingTimer); this.pingTimer = null; }
  send(f: ClientFrame) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(f)); }
  stop() { this.stopped = true; this.stopPing(); if (this.retryTimer) this.d.clearTimer(this.retryTimer); const ws = this.ws; this.ws = null; ws?.close(1000, "bye"); this.set("closed"); }
}

export function browserSignalingDeps(ticket: SignalingDeps["ticket"]): SignalingDeps {
  return {
    ticket, now: () => performance.now(), setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (t) => clearTimeout(t as number), random: Math.random,
    openWs: (url) => new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${url}`) as unknown as WsLike,
  };
}
