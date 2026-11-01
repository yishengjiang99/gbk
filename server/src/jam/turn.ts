// Short-lived TURN credentials (coturn "use-auth-secret" / TURN REST convention). The shared secret never leaves the server.
import { createHmac } from "node:crypto";

export interface IceConfig { iceServers: { urls: string[]; username?: string; credential?: string }[]; iceTransportPolicy: "all" | "relay"; expiresAt: number; ttlSec: number }
export function turnCredentials(o: { urls: string[]; secret: string; ttlSec: number; relayOnly: boolean; subject: string; nowMs: number }): IceConfig {
  const exp = Math.floor(o.nowMs / 1000) + o.ttlSec;
  const username = `${exp}:${o.subject}`;
  const credential = createHmac("sha1", o.secret).update(username).digest("base64");
  return { iceServers: [{ urls: o.urls, username, credential }], iceTransportPolicy: o.relayOnly ? "relay" : "all", expiresAt: exp * 1000, ttlSec: o.ttlSec };
}
/** Same check coturn does; used by tests and the smoke script. */
export function verifyTurnCredential(secret: string, username: string, credential: string, nowMs: number) {
  const exp = Number(username.split(":")[0]);
  return Number.isFinite(exp) && exp * 1000 > nowMs && createHmac("sha1", secret).update(username).digest("base64") === credential;
}
