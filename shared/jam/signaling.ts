// Live Jam signaling protocol v1: JSON frames over /api/jam/ws. Shared by the server, web and (as fixtures) iOS.
// The server derives the sender from the authenticated socket; `from` on inbound frames is never trusted.
import { z } from "zod";

export const JAM_PROTOCOL_VERSION = 1;
export const JAM_MAX_FRAME_BYTES = 16 * 1024;
export const JAM_MAX_SDP_CHARS = 12_000;
export const JAM_MAX_CANDIDATE_CHARS = 1_000;

const id = z.string().min(1).max(64).regex(/^[\w-]+$/);
const gen = z.number().int().min(0).max(2 ** 31 - 1);

export const PeerState = z.enum(["joining", "preparing", "connecting", "ready", "degraded", "reconnecting", "suspended", "left"]);
export type PeerState = z.infer<typeof PeerState>;

/** Client -> server. `auth` must be the first frame; nothing else is accepted before it. */
export const ClientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), v: z.literal(JAM_PROTOCOL_VERSION), ticket: z.string().min(16).max(128) }),
  z.object({ type: z.literal("ping"), t: z.number().finite() }),
  z.object({ type: z.literal("state"), state: PeerState, instrumentRevision: gen.optional() }),
  z.object({
    type: z.literal("signal"), to: id, toGeneration: gen, epoch: gen, revision: gen,
    kind: z.enum(["offer", "answer", "candidate", "end-of-candidates", "restart"]),
    sdp: z.string().max(JAM_MAX_SDP_CHARS).optional(),
    candidate: z.object({ candidate: z.string().max(JAM_MAX_CANDIDATE_CHARS), sdpMid: z.string().max(32).nullable().optional(), sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional() }).optional(),
  }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

export interface ParticipantView { participantId: string; name: string; role: "host" | "member"; state: PeerState; generation: number; connected: boolean; instrumentRevision: number }
export interface RoomSnapshot { roomId: string; epoch: number; serverEpoch: string; hostId: string; maxParticipants: number; locked: boolean; expiresAt: number; participants: ParticipantView[] }

/** Server -> client. */
export type ServerFrame =
  | { type: "welcome"; v: number; participantId: string; generation: number; snapshot: RoomSnapshot; serverTime: number }
  | { type: "snapshot"; snapshot: RoomSnapshot }
  | { type: "pong"; t: number; serverTime: number }
  | { type: "signal"; from: string; fromGeneration: number; epoch: number; revision: number; kind: Extract<ClientFrame, { type: "signal" }>["kind"]; sdp?: string; candidate?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } }
  | { type: "peer-left"; participantId: string; reason: "left" | "kicked" | "expired" }
  | { type: "kicked" } | { type: "ended"; reason: "host" | "expired" | "disabled" | "shutdown" }
  | { type: "error"; code: JamErrorCode; message: string };

export type JamErrorCode = "BAD_FRAME" | "PROTOCOL_MISMATCH" | "AUTH_REQUIRED" | "AUTH_FAILED" | "AUTH_TIMEOUT" | "RATE_LIMITED" | "BAD_TARGET" | "STALE" | "REPLACED" | "NOT_MEMBER";

export type DecodeResult = { ok: true; frame: ClientFrame } | { ok: false; code: "BAD_FRAME" | "PROTOCOL_MISMATCH"; message: string };
/** Size + JSON + schema validation for one inbound text frame. */
export function decodeClientFrame(raw: string): DecodeResult {
  if (raw.length > JAM_MAX_FRAME_BYTES) return { ok: false, code: "BAD_FRAME", message: "frame too large" };
  let j: unknown; try { j = JSON.parse(raw); } catch { return { ok: false, code: "BAD_FRAME", message: "invalid JSON" }; }
  if (j && typeof j === "object" && (j as { type?: unknown }).type === "auth" && (j as { v?: unknown }).v !== JAM_PROTOCOL_VERSION) return { ok: false, code: "PROTOCOL_MISMATCH", message: `server speaks jam protocol ${JAM_PROTOCOL_VERSION}` };
  const r = ClientFrame.safeParse(j);
  return r.success ? { ok: true, frame: r.data } : { ok: false, code: "BAD_FRAME", message: r.error.issues[0]?.message ?? "invalid frame" };
}
export const encodeServerFrame = (f: ServerFrame) => JSON.stringify(f);

// HTTP bodies
export const CreateRoomBody = z.object({ name: z.string().max(40).optional() }).strict();
export const JoinRoomBody = z.object({ invite: z.string().min(6).max(128), name: z.string().max(40).optional(), participantId: id.optional() }).strict();
export const ParticipantBody = z.object({ participantId: id }).strict();
export const TargetBody = z.object({ participantId: id, target: id }).strict();
