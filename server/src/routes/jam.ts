// Live Jam HTTP API. Auth = existing session cookie (+ Origin/CSRF on writes) or native bearer, via currentSession/guardWrite.
// Every room route also requires the caller's participantId to belong to their account (404 otherwise).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Config } from "../config.ts";
import type { SessionStore } from "../security/authentication.ts";
import { RateLimiter } from "../security/rate-limit.ts";
import { currentSession, guardWrite } from "./agent.ts";
import { isGuestAccount, type AccountStore } from "../persistence/accounts.ts";
import { CreateRoomBody, JoinRoomBody, OpenBody, ParticipantBody, TargetBody } from "../../../shared/jam/signaling.ts";
import { JamError, type JamRooms } from "../jam/rooms.ts";
import type { JamSignaling } from "../jam/signaling.ts";
import { turnCredentials } from "../jam/turn.ts";

export function jamRoutes(app: FastifyInstance, cfg: Config, d: { sessions: SessionStore; accounts: AccountStore; rooms: JamRooms; signaling: JamSignaling; now?: () => number }) {
  const now = d.now ?? Date.now;
  const creates = new RateLimiter(cfg.jam.createsPerHour, 3_600_000, now);
  const guestCreates = new RateLimiter(Math.max(1, Math.floor(cfg.jam.createsPerHour / 4)), 3_600_000, now);
  const joins = new RateLimiter(cfg.jam.joinsPerMinute, 60_000, now);
  const ice = new RateLimiter(cfg.jam.icePerMinute, 60_000, now);
  const sig = d.signaling;

  const auth = (req: FastifyRequest, reply: FastifyReply, write: boolean) => {
    const s = currentSession(req, d.sessions);
    if (!s) { void reply.code(401).send({ code: "UNAUTHENTICATED", message: "sign in first" }); return null; }
    if (write && !guardWrite(cfg, req, reply, s)) return null;
    return s;
  };
  const body = <T extends z.ZodTypeAny>(schema: T, req: FastifyRequest, reply: FastifyReply): z.infer<T> | null => {
    const r = schema.safeParse(req.body ?? {}); if (r.success) return r.data;
    void reply.code(400).send({ code: "BAD_REQUEST", message: r.error.issues[0]?.message ?? "invalid body" }); return null;
  };
  const run = async <T>(reply: FastifyReply, f: () => T) => { try { return f(); } catch (e) { if (e instanceof JamError) return reply.code(e.status).send({ code: e.code, message: e.message }); throw e; } };
  const rid = (req: FastifyRequest) => (req.params as { id: string }).id;
  const nameOf = (user: string, given?: string) => (given?.trim() || d.accounts.get(user)?.name || "Player").slice(0, 40);

  app.post("/api/jam/rooms", async (req, reply) => {
    const s = auth(req, reply, true); if (!s) return; const b = body(CreateRoomBody, req, reply); if (!b) return;
    const guest = isGuestAccount(s.user);
    if (!(guest ? guestCreates : creates).take(s.user)) return reply.code(429).send({ code: "RATE_LIMITED", message: "too many rooms created; try later" });
    return run(reply, () => d.rooms.create(s.user, nameOf(s.user, b.name)));
  });
  const join = (byRoom: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const s = auth(req, reply, true); if (!s) return; const b = body(JoinRoomBody, req, reply); if (!b) return;
    if (!joins.take(s.user) || !joins.take(`ip:${req.ip}`)) return reply.code(429).send({ code: "RATE_LIMITED", message: "too many join attempts; wait a minute" });
    return run(reply, () => { const r = d.rooms.join(byRoom ? rid(req) : null, s.user, nameOf(s.user, b.name), b.invite, b.participantId); sig.broadcastSnapshot(r.snapshot.roomId, r.participantId); return r; });
  };
  app.post("/api/jam/rooms/random", async (req, reply) => {
    const s = auth(req, reply, true); if (!s) return; const b = body(CreateRoomBody, req, reply); if (!b) return;
    if (!joins.take(s.user) || !joins.take(`ip:${req.ip}`)) return reply.code(429).send({ code: "RATE_LIMITED", message: "too many join attempts; wait a minute" });
    return run(reply, () => { const r = d.rooms.joinRandom(s.user, nameOf(s.user, b.name)); sig.broadcastSnapshot(r.snapshot.roomId, r.participantId); return r; });
  });
  app.post("/api/jam/rooms/:id/open", async (req, reply) => {
    const s = auth(req, reply, true); if (!s) return; const b = body(OpenBody, req, reply); if (!b) return;
    return run(reply, () => { d.rooms.setOpen(rid(req), s.user, b.participantId, b.open); sig.broadcastSnapshot(rid(req)); return { ok: true }; });
  });
  app.post("/api/jam/rooms/:id/join", join(true));
  app.post("/api/jam/join", join(false)); // human code without a room id

  // GET carries the participant as a query param (no body on GET).
  app.get("/api/jam/rooms/:id", async (req, reply) => {
    const s = auth(req, reply, false); if (!s) return; const pid = String((req.query as { participantId?: string }).participantId ?? "");
    return run(reply, () => { d.rooms.authorize(rid(req), s.user, pid); return { snapshot: d.rooms.snapshot(rid(req)) }; });
  });
  app.post("/api/jam/rooms/:id/ws-ticket", async (req, reply) => {
    const s = auth(req, reply, true); if (!s) return; const b = body(ParticipantBody, req, reply); if (!b) return;
    return run(reply, () => ({ ...d.rooms.issueTicket(rid(req), s.user, b.participantId), url: "/api/jam/ws" }));
  });
  app.post("/api/jam/rooms/:id/ice-credentials", async (req, reply) => {
    const s = auth(req, reply, true); if (!s) return; const b = body(ParticipantBody, req, reply); if (!b) return;
    if (!ice.take(s.user)) return reply.code(429).send({ code: "RATE_LIMITED", message: "too many credential requests" });
    return run(reply, () => {
      d.rooms.authorize(rid(req), s.user, b.participantId);
      if (!cfg.jam.turnUrls.length) return reply.code(503).send({ code: "TURN_UNCONFIGURED", message: "no TURN server configured", iceServers: [], iceTransportPolicy: "all" });
      return turnCredentials({ urls: cfg.jam.turnUrls, secret: cfg.jam.turnSecret, ttlSec: cfg.jam.turnTtlSec, relayOnly: cfg.jam.relayOnly, subject: b.participantId, nowMs: now() });
    });
  });
  app.post("/api/jam/rooms/:id/invite", async (req, reply) => { // rotate: old invites stop working
    const s = auth(req, reply, true); if (!s) return; const b = body(ParticipantBody, req, reply); if (!b) return;
    return run(reply, () => ({ invite: d.rooms.rotateInvites(rid(req), s.user, b.participantId) }));
  });
  app.post("/api/jam/rooms/:id/invite/revoke", async (req, reply) => {
    const s = auth(req, reply, true); if (!s) return; const b = body(ParticipantBody, req, reply); if (!b) return;
    return run(reply, () => { d.rooms.revokeInvites(rid(req), s.user, b.participantId); return { ok: true }; });
  });
  for (const [path, locked] of [["lock", true], ["unlock", false]] as const)
    app.post(`/api/jam/rooms/:id/${path}`, async (req, reply) => {
      const s = auth(req, reply, true); if (!s) return; const b = body(ParticipantBody, req, reply); if (!b) return;
      return run(reply, () => { d.rooms.setLocked(rid(req), s.user, b.participantId, locked); sig.broadcastSnapshot(rid(req)); return { ok: true }; });
    });
  app.post("/api/jam/rooms/:id/kick", async (req, reply) => {
    const s = auth(req, reply, true); if (!s) return; const b = body(TargetBody, req, reply); if (!b) return;
    return run(reply, () => { d.rooms.kick(rid(req), s.user, b.participantId, b.target); sig.removed(rid(req), b.target, "kicked"); return { ok: true }; });
  });
  app.post("/api/jam/rooms/:id/host", async (req, reply) => {
    const s = auth(req, reply, true); if (!s) return; const b = body(TargetBody, req, reply); if (!b) return;
    return run(reply, () => { d.rooms.transferHost(rid(req), s.user, b.participantId, b.target); sig.broadcastSnapshot(rid(req)); return { ok: true }; });
  });
  app.post("/api/jam/rooms/:id/leave", async (req, reply) => {
    const s = auth(req, reply, true); if (!s) return; const b = body(ParticipantBody, req, reply); if (!b) return;
    return run(reply, () => { const r = d.rooms.leave(rid(req), s.user, b.participantId); sig.removed(rid(req), b.participantId, "left"); return { ok: true, ended: r.ended }; });
  });
  app.post("/api/jam/rooms/:id/end", async (req, reply) => {
    const s = auth(req, reply, true); if (!s) return; const b = body(ParticipantBody, req, reply); if (!b) return;
    return run(reply, () => { sig.ended(d.rooms.end(rid(req), s.user, b.participantId), "host"); return { ok: true }; });
  });
}
