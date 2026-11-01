// Live Jam HTTP client (same-origin cookie + CSRF, like the rest of the web app).
import type { RoomSnapshot } from "../../shared/jam/signaling.ts";
import { apiBase } from "../agent/bridge-client.ts";

export interface Invite { token: string; code: string; expiresAt: number; codeExpiresAt: number }
export interface IceConfig { iceServers: RTCIceServer[]; iceTransportPolicy: RTCIceTransportPolicy; expiresAt?: number }
export class JamApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
const csrf = () => decodeURIComponent(document.cookie.match(/(?:^|; )gbk_csrf=([^;]+)/)?.[1] ?? "");

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${apiBase()}${path}`, { method, credentials: "same-origin", headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(method !== "GET" ? { "x-gbk-csrf": csrf() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({})) as { code?: string; message?: string };
  if (!r.ok) throw new JamApiError(r.status, j.code ?? "ERROR", j.message ?? `HTTP ${r.status}`);
  return j as T;
}
export async function ensureSession(): Promise<{ authenticated: boolean; user: string | null; name: string | null }> {
  return call("GET", "/session");
}
/** Anonymous guest identity (existing /api/auth/guest/web), so invite links work without an account. */
export async function continueAsGuest(name?: string) {
  let dev = localStorage.getItem("gbk.deviceId"); if (!dev) { dev = crypto.randomUUID(); localStorage.setItem("gbk.deviceId", dev); }
  await call("GET", "/session"); // sets the csrf cookie
  const r = await fetch(`${apiBase()}/auth/guest/web`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-gbk-csrf": csrf(), "x-gbk-device": dev, ...(name ? { "x-gbk-guest-name": name.slice(0, 40) } : {}) }, body: "{}" });
  if (!r.ok) { const j = await r.json().catch(() => ({})) as { code?: string; message?: string }; throw new JamApiError(r.status, j.code ?? "GUEST_FAILED", j.message ?? "could not start a guest session"); }
}
export const jamApi = {
  create: (name?: string) => call<{ participantId: string; snapshot: RoomSnapshot; invite: Invite }>("POST", "/jam/rooms", name ? { name } : {}),
  join: (roomId: string | null, invite: string, name?: string, participantId?: string) => call<{ participantId: string; snapshot: RoomSnapshot }>("POST", roomId ? `/jam/rooms/${encodeURIComponent(roomId)}/join` : "/jam/join", { invite, ...(name ? { name } : {}), ...(participantId ? { participantId } : {}) }),
  snapshot: (roomId: string, pid: string) => call<{ snapshot: RoomSnapshot }>("GET", `/jam/rooms/${encodeURIComponent(roomId)}?participantId=${encodeURIComponent(pid)}`),
  ticket: (roomId: string, pid: string) => call<{ ticket: string; url: string }>("POST", `/jam/rooms/${encodeURIComponent(roomId)}/ws-ticket`, { participantId: pid }),
  ice: async (roomId: string, pid: string): Promise<IceConfig> => {
    try { return await call<IceConfig>("POST", `/jam/rooms/${encodeURIComponent(roomId)}/ice-credentials`, { participantId: pid }); }
    catch (e) { if (e instanceof JamApiError && e.code === "TURN_UNCONFIGURED") return { iceServers: [], iceTransportPolicy: "all" }; throw e; }
  },
  rotate: (roomId: string, pid: string) => call<{ invite: Invite }>("POST", `/jam/rooms/${roomId}/invite`, { participantId: pid }),
  revoke: (roomId: string, pid: string) => call("POST", `/jam/rooms/${roomId}/invite/revoke`, { participantId: pid }),
  lock: (roomId: string, pid: string, locked: boolean) => call("POST", `/jam/rooms/${roomId}/${locked ? "lock" : "unlock"}`, { participantId: pid }),
  kick: (roomId: string, pid: string, target: string) => call("POST", `/jam/rooms/${roomId}/kick`, { participantId: pid, target }),
  host: (roomId: string, pid: string, target: string) => call("POST", `/jam/rooms/${roomId}/host`, { participantId: pid, target }),
  leave: (roomId: string, pid: string) => call("POST", `/jam/rooms/${roomId}/leave`, { participantId: pid }),
  end: (roomId: string, pid: string) => call("POST", `/jam/rooms/${roomId}/end`, { participantId: pid }),
};
