// Live Jam room registry. Rooms, invites and memberships persist in SQLite (low-frequency writes only:
// create/join/leave/kick/host/end). Presence, generations and tickets are in memory and die with the process;
// a restart gets a new serverEpoch and clients re-ticket.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { nextTransport, STOPPED_TRANSPORT, type PeerState, type ParticipantView, type RoomSnapshot, type TransportState } from "../../../shared/jam/signaling.ts";

export interface JamLimits { maxParticipants: number; roomTtlSec: number; inviteTtlSec: number; codeTtlSec: number; maxRoomsPerIdentity: number }
interface RoomRow { id: string; host_id: string; created_by: string; created_at: number; expires_at: number; ended_at: number | null; epoch: number; locked: number; open: number }
interface MemberRow { participant_id: string; room_id: string; account: string; name: string; joined_at: number; left_at: number | null }
export interface Presence { generation: number; state: PeerState; instrumentRevision: number; connected: boolean; disconnectedAt: number }

export class JamError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
// Human code alphabet without 0/O/1/I/L.
const CODE_ABC = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const newCode = () => { const b = randomBytes(8); let s = ""; for (const x of b) s += CODE_ABC[x % CODE_ABC.length]; return s; };
/** Human codes are case/dash/space-insensitive; link tokens are used verbatim. */
export const normalizeInvite = (s: string) => { const t = s.trim(); return t.length <= 14 ? t.toUpperCase().replace(/[\s-]/g, "") : t; };

export class JamRooms {
  readonly db: DatabaseSync;
  readonly serverEpoch = randomBytes(6).toString("hex");
  private presence = new Map<string, Presence>();
  /** Metronome timeline per room (ephemeral: a restart stops the metronome; the new serverEpoch tells clients). */
  private transports = new Map<string, TransportState>();
  private tickets = new Map<string, { participantId: string; roomId: string; exp: number }>();
  constructor(file: string, private lim: JamLimits, private now: () => number = Date.now) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000;
      CREATE TABLE IF NOT EXISTS jam_rooms (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, ended_at INTEGER, epoch INTEGER NOT NULL DEFAULT 1, locked INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS jam_rooms_creator ON jam_rooms(created_by, ended_at);
      CREATE TABLE IF NOT EXISTS jam_invites (token_hash TEXT PRIMARY KEY, room_id TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS jam_invites_room ON jam_invites(room_id);
      CREATE TABLE IF NOT EXISTS jam_members (participant_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, account TEXT NOT NULL, name TEXT NOT NULL,
        joined_at INTEGER NOT NULL, left_at INTEGER, left_reason TEXT);
      CREATE INDEX IF NOT EXISTS jam_members_room ON jam_members(room_id, left_at);`);
    if (!(this.db.prepare("PRAGMA table_info(jam_rooms)").all() as { name: string }[]).some((c) => c.name === "open")) this.db.exec("ALTER TABLE jam_rooms ADD COLUMN open INTEGER NOT NULL DEFAULT 0");
  }
  close() { try { this.db.close(); } catch { /* closed */ } }
  private tx<T>(f: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const r = f(); this.db.exec("COMMIT"); return r; } catch (e) { this.db.exec("ROLLBACK"); throw e; } }

  private room(id: string): RoomRow | null {
    const r = this.db.prepare("SELECT * FROM jam_rooms WHERE id = ?").get(id) as RoomRow | undefined;
    return r && r.ended_at === null && r.expires_at > this.now() ? r : null;
  }
  private active(roomId: string) { return this.db.prepare("SELECT * FROM jam_members WHERE room_id = ? AND left_at IS NULL ORDER BY joined_at, participant_id").all(roomId) as unknown as MemberRow[]; }
  member(participantId: string): MemberRow | null { return (this.db.prepare("SELECT * FROM jam_members WHERE participant_id = ? AND left_at IS NULL").get(participantId) as MemberRow | undefined) ?? null; }

  /** Membership check: the participant exists, is active, belongs to `account` and to a live room. 404 otherwise (no enumeration). */
  authorize(roomId: string, account: string, participantId: string) {
    const r = this.room(roomId); const m = this.member(participantId);
    if (!r || !m || m.room_id !== roomId || m.account !== account) throw new JamError(404, "NOT_FOUND", "no such room");
    return { room: r, member: m };
  }
  private requireHost(roomId: string, account: string, participantId: string) {
    const a = this.authorize(roomId, account, participantId);
    if (a.room.host_id !== participantId) throw new JamError(403, "NOT_HOST", "only the host can do that");
    return a;
  }

  private mintInvites(roomId: string) {
    const t = this.now(); const token = randomBytes(24).toString("base64url"); const code = newCode();
    const ins = this.db.prepare("INSERT INTO jam_invites (token_hash, room_id, kind, expires_at) VALUES (?, ?, ?, ?)");
    ins.run(sha(token), roomId, "link", t + this.lim.inviteTtlSec * 1000);
    ins.run(sha(code), roomId, "code", t + this.lim.codeTtlSec * 1000);
    return { token, code, expiresAt: t + this.lim.inviteTtlSec * 1000, codeExpiresAt: t + this.lim.codeTtlSec * 1000 };
  }

  create(account: string, name: string) {
    return this.tx(() => {
      const t = this.now();
      const open = Number((this.db.prepare("SELECT COUNT(*) n FROM jam_rooms WHERE created_by = ? AND ended_at IS NULL AND expires_at > ?").get(account, t) as { n: number }).n);
      if (open >= this.lim.maxRoomsPerIdentity) throw new JamError(429, "ROOM_LIMIT", "too many open rooms; end one first");
      const roomId = randomUUID().replace(/-/g, "").slice(0, 20); const pid = `p${randomBytes(8).toString("hex")}`;
      this.db.prepare("INSERT INTO jam_rooms (id, host_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(roomId, pid, account, t, t + this.lim.roomTtlSec * 1000);
      this.db.prepare("INSERT INTO jam_members (participant_id, room_id, account, name, joined_at) VALUES (?, ?, ?, ?, ?)").run(pid, roomId, account, name, t);
      return { participantId: pid, invite: this.mintInvites(roomId), snapshot: this.snapshot(roomId) };
    });
  }

  /** Redeem an invite. Synchronous SQLite transaction = the participant limit is atomic. */
  join(roomIdOrNull: string | null, account: string, name: string, invite: string, resume?: string) {
    return this.tx(() => {
      const roomId = roomIdOrNull ?? (this.db.prepare("SELECT room_id FROM jam_invites WHERE token_hash = ?").get(sha(normalizeInvite(invite))) as { room_id: string } | undefined)?.room_id ?? "";
      const r = this.room(roomId); if (!r) throw new JamError(404, "INVITE_INVALID", "invite is invalid or expired");
      if (resume) { const m = this.member(resume); if (m && m.room_id === roomId && m.account === account) return { participantId: resume, snapshot: this.snapshot(roomId) }; }
      const inv = this.db.prepare("SELECT * FROM jam_invites WHERE token_hash = ? AND room_id = ?").get(sha(normalizeInvite(invite)), roomId) as { expires_at: number; revoked: number } | undefined;
      if (!inv || inv.revoked || inv.expires_at <= this.now()) throw new JamError(404, "INVITE_INVALID", "invite is invalid or expired");
      if (r.locked) throw new JamError(403, "ROOM_LOCKED", "the host locked this room");
      if (this.active(roomId).length >= this.lim.maxParticipants) throw new JamError(409, "ROOM_FULL", `rooms hold at most ${this.lim.maxParticipants} players`);
      const pid = `p${randomBytes(8).toString("hex")}`;
      this.db.prepare("INSERT INTO jam_members (participant_id, room_id, account, name, joined_at) VALUES (?, ?, ?, ?, ?)").run(pid, roomId, account, name, this.now());
      return { participantId: pid, snapshot: this.snapshot(roomId) };
    });
  }
  /** Join any open, unlocked, live room with a free slot (fullest first, so players meet). Atomic like join(). */
  joinRandom(account: string, name: string) {
    return this.tx(() => {
      const t = this.now();
      const r = this.db.prepare(`SELECT r.id FROM jam_rooms r WHERE r.open = 1 AND r.locked = 0 AND r.ended_at IS NULL AND r.expires_at > ?
          AND NOT EXISTS (SELECT 1 FROM jam_members m WHERE m.room_id = r.id AND m.left_at IS NULL AND m.account = ?)
          AND (SELECT COUNT(*) FROM jam_members m WHERE m.room_id = r.id AND m.left_at IS NULL) < ?
        ORDER BY (SELECT COUNT(*) FROM jam_members m WHERE m.room_id = r.id AND m.left_at IS NULL) DESC, random() LIMIT 1`).get(t, account, this.lim.maxParticipants) as { id: string } | undefined;
      if (!r) throw new JamError(404, "NO_OPEN_ROOM", "no open room right now");
      const pid = `p${randomBytes(8).toString("hex")}`;
      this.db.prepare("INSERT INTO jam_members (participant_id, room_id, account, name, joined_at) VALUES (?, ?, ?, ?, ?)").run(pid, r.id, account, name, t);
      return { participantId: pid, snapshot: this.snapshot(r.id) };
    });
  }
  /** Rooms whose host has been disconnected for at least graceMs. */
  absentHosts(graceMs: number) {
    const t = this.now(); const out: string[] = [];
    for (const r of this.db.prepare("SELECT id, host_id FROM jam_rooms WHERE ended_at IS NULL").all() as { id: string; host_id: string }[]) {
      const p = this.presence.get(r.host_id); if (p && !p.connected && t - p.disconnectedAt >= graceMs && this.active(r.id).some((m) => this.presence.get(m.participant_id)?.connected)) out.push(r.id);
    }
    return out;
  }

  rotateInvites(roomId: string, account: string, pid: string) { this.requireHost(roomId, account, pid); return this.tx(() => { this.revokeAll(roomId); return this.mintInvites(roomId); }); }
  revokeInvites(roomId: string, account: string, pid: string) { this.requireHost(roomId, account, pid); this.revokeAll(roomId); }
  private revokeAll(roomId: string) { this.db.prepare("UPDATE jam_invites SET revoked = 1 WHERE room_id = ?").run(roomId); }
  setOpen(roomId: string, account: string, pid: string, open: boolean) { this.requireHost(roomId, account, pid); this.db.prepare("UPDATE jam_rooms SET open = ? WHERE id = ?").run(open ? 1 : 0, roomId); }
  setLocked(roomId: string, account: string, pid: string, locked: boolean) { this.requireHost(roomId, account, pid); this.db.prepare("UPDATE jam_rooms SET locked = ? WHERE id = ?").run(locked ? 1 : 0, roomId); }

  /** Removes a participant. Returns true if the room ended (no one left). */
  private remove(roomId: string, pid: string, reason: "left" | "kicked" | "expired"): { ended: boolean; newHost: string | null } {
    return this.tx(() => {
      this.db.prepare("UPDATE jam_members SET left_at = ?, left_reason = ? WHERE participant_id = ? AND left_at IS NULL").run(this.now(), reason, pid);
      this.presence.delete(pid); for (const [k, v] of this.tickets) if (v.participantId === pid) this.tickets.delete(k);
      const rest = this.active(roomId); const r = this.db.prepare("SELECT * FROM jam_rooms WHERE id = ?").get(roomId) as unknown as RoomRow;
      if (!rest.length) { this.endRow(roomId); return { ended: true, newHost: null }; }
      if (r.host_id === pid) { const next = this.successor(rest); this.db.prepare("UPDATE jam_rooms SET host_id = ? WHERE id = ?").run(next, roomId); return { ended: false, newHost: next }; }
      return { ended: false, newHost: null };
    });
  }
  /** Oldest connected member, else oldest member. */
  private successor(rest: MemberRow[]) { return (rest.find((m) => this.presence.get(m.participant_id)?.connected) ?? rest[0]).participant_id; }
  leave(roomId: string, account: string, pid: string) { this.authorize(roomId, account, pid); return this.remove(roomId, pid, "left"); }
  kick(roomId: string, account: string, pid: string, target: string) {
    this.requireHost(roomId, account, pid);
    const t = this.member(target); if (!t || t.room_id !== roomId || target === pid) throw new JamError(404, "NOT_FOUND", "no such participant");
    return this.remove(roomId, target, "kicked");
  }
  expire(roomId: string, pid: string) { return this.remove(roomId, pid, "expired"); }
  transferHost(roomId: string, account: string, pid: string, target: string) {
    this.requireHost(roomId, account, pid);
    const t = this.member(target); if (!t || t.room_id !== roomId) throw new JamError(404, "NOT_FOUND", "no such participant");
    this.db.prepare("UPDATE jam_rooms SET host_id = ? WHERE id = ? AND host_id = ?").run(target, roomId, pid);
  }
  /** Host grace expired: server picks a successor. */
  reassignHost(roomId: string) { const rest = this.active(roomId); if (!rest.length) return null; const next = this.successor(rest); this.db.prepare("UPDATE jam_rooms SET host_id = ? WHERE id = ?").run(next, roomId); return next; }
  end(roomId: string, account: string, pid: string) { this.requireHost(roomId, account, pid); const ids = this.active(roomId).map((m) => m.participant_id); this.endRow(roomId); return ids; }
  private endRow(roomId: string) {
    const t = this.now();
    for (const m of this.active(roomId)) { this.presence.delete(m.participant_id); }
    this.db.prepare("UPDATE jam_members SET left_at = ?, left_reason = 'ended' WHERE room_id = ? AND left_at IS NULL").run(t, roomId);
    this.db.prepare("UPDATE jam_rooms SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(t, roomId); this.transports.delete(roomId);
    this.revokeAll(roomId);
  }
  /** TTL cleanup: returns the ids of rooms that just expired, with their member ids. */
  sweep(): { roomId: string; members: string[] }[] {
    const t = this.now(); const out: { roomId: string; members: string[] }[] = [];
    for (const r of this.db.prepare("SELECT id FROM jam_rooms WHERE ended_at IS NULL AND expires_at <= ?").all(t) as { id: string }[]) { out.push({ roomId: r.id, members: this.active(r.id).map((m) => m.participant_id) }); this.endRow(r.id); }
    this.db.prepare("DELETE FROM jam_invites WHERE expires_at < ? OR revoked = 1").run(t - 86_400_000);
    for (const [k, v] of this.tickets) if (v.exp <= t) this.tickets.delete(k);
    return out;
  }
  roomOf(pid: string) { return this.member(pid)?.room_id ?? null; }
  hostOf(roomId: string) { return this.room(roomId)?.host_id ?? null; }
  activeIds(roomId: string) { return this.active(roomId).map((m) => m.participant_id); }

  // Signaling tickets: single use, 30 s, bound to participant + room. Stored hashed.
  issueTicket(roomId: string, account: string, pid: string) {
    this.authorize(roomId, account, pid);
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(sha(ticket), { participantId: pid, roomId, exp: this.now() + 30_000 });
    return { ticket, expiresAt: this.now() + 30_000 };
  }
  redeemTicket(ticket: string): { participantId: string; roomId: string } | null {
    const k = sha(ticket); const t = this.tickets.get(k); this.tickets.delete(k);
    if (!t || t.exp <= this.now()) return null;
    const m = this.member(t.participantId); if (!m || m.room_id !== t.roomId || !this.room(t.roomId)) return null;
    return { participantId: t.participantId, roomId: t.roomId };
  }

  presenceOf(pid: string): Presence { let p = this.presence.get(pid); if (!p) { p = { generation: 0, state: "joining", instrumentRevision: 0, connected: false, disconnectedAt: this.now() }; this.presence.set(pid, p); } return p; }
  /** New authenticated connection: bump the generation. */
  connect(pid: string) { const p = this.presenceOf(pid); p.generation++; p.connected = true; p.state = p.state === "left" ? "joining" : p.state; return p.generation; }
  disconnect(pid: string, generation: number) { const p = this.presence.get(pid); if (p && p.generation === generation) { p.connected = false; p.state = "reconnecting"; p.disconnectedAt = this.now(); } }
  /** Disconnected participants whose reconnect grace has elapsed. */
  stale(graceMs: number) { const t = this.now(); const out: { roomId: string; pid: string }[] = []; for (const [pid, p] of this.presence) if (!p.connected && t - p.disconnectedAt >= graceMs) { const r = this.roomOf(pid); if (r) out.push({ roomId: r, pid }); else this.presence.delete(pid); } return out; }

  snapshot(roomId: string): RoomSnapshot {
    const r = this.db.prepare("SELECT * FROM jam_rooms WHERE id = ?").get(roomId) as unknown as RoomRow;
    const participants: ParticipantView[] = this.active(roomId).map((m) => { const p = this.presenceOf(m.participant_id); return { participantId: m.participant_id, name: m.name, role: m.participant_id === r.host_id ? "host" : "member", state: p.state, generation: p.generation, connected: p.connected, instrumentRevision: p.instrumentRevision }; });
    return { roomId, epoch: r.epoch, serverEpoch: this.serverEpoch, hostId: r.host_id, maxParticipants: this.lim.maxParticipants, locked: !!r.locked, open: !!r.open, expiresAt: r.expires_at, participants, transport: this.transports.get(roomId) ?? STOPPED_TRANSPORT };
  }
  /** Host-only metronome change; `nowRoomMs` is the server's performance.now(). */
  setTransport(roomId: string, pid: string, req: { running: boolean; bpm: number; beatsPerBar: number; countInBars: number }, nowRoomMs: number): TransportState {
    if (this.hostOf(roomId) !== pid) throw new JamError(403, "NOT_HOST", "only the host can do that");
    const t = nextTransport(this.transports.get(roomId) ?? STOPPED_TRANSPORT, req, nowRoomMs); this.transports.set(roomId, t); return t;
  }
}
