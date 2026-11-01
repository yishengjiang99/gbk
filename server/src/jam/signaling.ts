// /api/jam/ws: ticket-in-first-frame auth, then validated signaling relay between current members of one room.
// Separate WebSocketServer from the agent bridge: no agent run slots, no LLM, no one-socket-per-account rule.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "../config.ts";
import { originAllowed } from "../security/authorization.ts";
import { RateLimiter } from "../security/rate-limit.ts";
import { clientIp } from "../bridge/websocket.ts";
import { decodeClientFrame, encodeServerFrame, JAM_MAX_FRAME_BYTES, JAM_PROTOCOL_VERSION, type ServerFrame } from "../../../shared/jam/signaling.ts";
import type { JamRooms } from "./rooms.ts";

type Log = (o: Record<string, unknown>) => void;
interface Conn { ws: WebSocket; pid: string; roomId: string; generation: number; alive: boolean }
export const AUTH_TIMEOUT_MS = 5_000;
const MAX_PENDING_AUTH = 200;

export class JamSignaling {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: JAM_MAX_FRAME_BYTES });
  private conns = new Map<string, Conn>(); // participantId -> live connection
  private pendingAuth = 0;
  private frameLimiter: RateLimiter; private ipLimiter: RateLimiter;
  private timers: NodeJS.Timeout[] = [];
  constructor(private cfg: Config, private rooms: JamRooms, private log: Log, now: () => number = Date.now) {
    this.frameLimiter = new RateLimiter(cfg.jam.framesPerSecond * 10, 10_000, now);
    this.ipLimiter = new RateLimiter(cfg.security.ipRequestsPerMinute, 60_000, now);
    this.timers.push(setInterval(() => { for (const c of this.conns.values()) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; c.ws.ping(); } }, 15_000));
    this.timers.push(setInterval(() => this.sweep(), 1_000));
    for (const t of this.timers) t.unref();
  }
  get size() { return this.conns.size; }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const reject = (code: number, msg: string) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); };
    if (!this.cfg.jam.enabled) return reject(404, "Not Found");
    const ip = clientIp(req);
    if (!this.ipLimiter.take(`jamws:${ip}`)) return reject(429, "Too Many Requests");
    // Browsers always send Origin; native clients send none and still need a valid ticket.
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(this.cfg, origin)) { this.log({ evt: "jam_ws_reject", reason: "origin" }); return reject(403, "Forbidden"); }
    if (this.pendingAuth >= MAX_PENDING_AUTH) return reject(503, "Service Unavailable");
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
  }

  private onSocket(ws: WebSocket) {
    this.pendingAuth++;
    let conn: Conn | null = null; let authed = false;
    const send = (f: ServerFrame) => { if (ws.readyState === 1) ws.send(encodeServerFrame(f)); };
    const timer = setTimeout(() => { if (!authed) { send({ type: "error", code: "AUTH_TIMEOUT", message: "authenticate first" }); ws.close(4401, "auth timeout"); } }, AUTH_TIMEOUT_MS);
    const settleAuth = () => { if (!authed) { authed = true; this.pendingAuth--; clearTimeout(timer); } };
    ws.on("message", (raw, isBinary) => {
      if (isBinary) { send({ type: "error", code: "BAD_FRAME", message: "text frames only" }); if (!conn) ws.close(4400, "bad frame"); return; }
      const d = decodeClientFrame(String(raw));
      if (!conn) {
        // Before auth: exactly one `auth` frame; anything else closes the socket.
        if (!d.ok) { send({ type: "error", code: d.code, message: d.message }); settleAuth(); ws.close(4400, "bad frame"); return; }
        if (d.frame.type !== "auth") { send({ type: "error", code: "AUTH_REQUIRED", message: "authenticate first" }); settleAuth(); ws.close(4401, "auth required"); return; }
        const t = this.rooms.redeemTicket(d.frame.ticket); settleAuth();
        if (!t) { send({ type: "error", code: "AUTH_FAILED", message: "ticket invalid, expired or used" }); ws.close(4401, "auth failed"); return; }
        const prev = this.conns.get(t.participantId);
        if (prev) { this.sendTo(prev, { type: "error", code: "REPLACED", message: "this device reconnected elsewhere" }); prev.ws.close(4409, "replaced"); }
        const generation = this.rooms.connect(t.participantId);
        conn = { ws, pid: t.participantId, roomId: t.roomId, generation, alive: true };
        this.conns.set(t.participantId, conn);
        const c = conn; ws.on("pong", () => { c.alive = true; });
        send({ type: "welcome", v: JAM_PROTOCOL_VERSION, participantId: c.pid, generation, snapshot: this.rooms.snapshot(c.roomId), serverTime: performance.now() });
        this.broadcastSnapshot(c.roomId, c.pid);
        this.log({ evt: "jam_ws_open", room: c.roomId, generation });
        return;
      }
      this.onFrame(conn, d);
    });
    ws.on("close", () => {
      settleAuth(); clearTimeout(timer);
      if (!conn) return;
      if (this.conns.get(conn.pid) === conn) { this.conns.delete(conn.pid); this.rooms.disconnect(conn.pid, conn.generation); if (this.rooms.roomOf(conn.pid)) this.broadcastSnapshot(conn.roomId); }
    });
    ws.on("error", () => { /* close follows */ });
  }

  private onFrame(c: Conn, d: ReturnType<typeof decodeClientFrame>) {
    c.alive = true;
    if (!d.ok) return this.sendTo(c, { type: "error", code: d.code, message: d.message });
    if (!this.frameLimiter.take(c.pid)) return this.sendTo(c, { type: "error", code: "RATE_LIMITED", message: "slow down" });
    if (this.rooms.roomOf(c.pid) !== c.roomId) { this.sendTo(c, { type: "error", code: "NOT_MEMBER", message: "not a member" }); c.ws.close(4403, "not a member"); return; }
    const f = d.frame;
    switch (f.type) {
      case "auth": return this.sendTo(c, { type: "error", code: "BAD_FRAME", message: "already authenticated" });
      case "ping": return this.sendTo(c, { type: "pong", t: f.t, serverTime: performance.now() });
      case "state": { const p = this.rooms.presenceOf(c.pid); p.state = f.state; if (f.instrumentRevision !== undefined) p.instrumentRevision = f.instrumentRevision; return this.broadcastSnapshot(c.roomId); }
      case "signal": {
        const snap = this.rooms.snapshot(c.roomId);
        if (f.epoch !== snap.epoch) return this.sendTo(c, { type: "error", code: "STALE", message: "room epoch changed; refresh snapshot" });
        const target = f.to === c.pid ? undefined : this.conns.get(f.to);
        if (!target || target.roomId !== c.roomId || this.rooms.roomOf(f.to) !== c.roomId) return this.sendTo(c, { type: "error", code: "BAD_TARGET", message: "target is not a connected member of this room" });
        if (f.toGeneration !== target.generation) return this.sendTo(c, { type: "error", code: "STALE", message: "target generation changed" });
        if ((f.kind === "offer" || f.kind === "answer") && !f.sdp) return this.sendTo(c, { type: "error", code: "BAD_FRAME", message: "sdp required" });
        if (f.kind === "candidate" && !f.candidate) return this.sendTo(c, { type: "error", code: "BAD_FRAME", message: "candidate required" });
        return this.sendTo(target, { type: "signal", from: c.pid, fromGeneration: c.generation, epoch: f.epoch, revision: f.revision, kind: f.kind, ...(f.sdp !== undefined ? { sdp: f.sdp } : {}), ...(f.candidate ? { candidate: f.candidate } : {}) });
      }
    }
  }

  private sendTo(c: Conn, f: ServerFrame) { if (c.ws.readyState === 1) c.ws.send(encodeServerFrame(f)); }
  broadcast(roomId: string, f: ServerFrame, except?: string) { for (const c of this.conns.values()) if (c.roomId === roomId && c.pid !== except) this.sendTo(c, f); }
  broadcastSnapshot(roomId: string, except?: string) { if (this.rooms.hostOf(roomId) === null) return; this.broadcast(roomId, { type: "snapshot", snapshot: this.rooms.snapshot(roomId) }, except); }
  /** Close one participant's socket (kick/leave/expiry) after telling them why. */
  drop(pid: string, f: ServerFrame, code: number, reason: string) { const c = this.conns.get(pid); if (!c) return; this.conns.delete(pid); this.sendTo(c, f); c.ws.close(code, reason); }
  removed(roomId: string, pid: string, reason: "left" | "kicked" | "expired") {
    this.drop(pid, reason === "kicked" ? { type: "kicked" } : { type: "peer-left", participantId: pid, reason }, 4000, reason);
    this.broadcast(roomId, { type: "peer-left", participantId: pid, reason }); this.broadcastSnapshot(roomId);
  }
  ended(members: string[], reason: "host" | "expired" | "disabled" | "shutdown") { for (const pid of members) this.drop(pid, { type: "ended", reason }, 4000, "ended"); }

  /** Lease enforcement: disconnected past the grace -> removed; host absent past the grace -> successor. */
  sweep() {
    for (const { roomId, pid } of this.rooms.stale(this.cfg.jam.reconnectGraceSec * 1000)) {
      const r = this.rooms.expire(roomId, pid);
      this.log({ evt: "jam_member_expired", room: roomId });
      if (r.ended) continue;
      this.broadcast(roomId, { type: "peer-left", participantId: pid, reason: "expired" }); this.broadcastSnapshot(roomId);
    }
    for (const roomId of this.rooms.absentHosts(this.cfg.jam.hostGraceSec * 1000)) { this.rooms.reassignHost(roomId); this.broadcastSnapshot(roomId); }
    for (const x of this.rooms.sweep()) this.ended(x.members, "expired");
  }
  close() { for (const t of this.timers) clearInterval(t); for (const c of this.conns.values()) { this.sendTo(c, { type: "ended", reason: "shutdown" }); c.ws.terminate(); } this.conns.clear(); for (const ws of this.wss.clients) ws.terminate(); }
}
