// APNs HTTP/2 sender with token (JWT ES256) auth, ported from earsheet server/src/apns.ts.
// Key: APNS_P8 / APNS_P8_PATH, APNS_KEY_ID, APNS_TEAM_ID, topic APNS_TOPIC (defaults to APPLE_BUNDLE_ID). Never logged.
import crypto from "node:crypto";
import http2 from "node:http2";
import type { Config } from "../config.ts";

export type ApnsEnv = "sandbox" | "production";
export type ApnsResult = { status: number; apnsId: string | null; reason: string | null };
export type ApnsSender = (token: string, env: ApnsEnv, payload: object, opts?: { pushType?: string; priority?: number }) => Promise<ApnsResult>;

export const apnsConfigured = (cfg: Config) => Boolean(cfg.native.apns.keyId && cfg.native.apns.teamId && cfg.native.apns.privateKey && cfg.native.apns.topic);

export function apnsJwt(cfg: Config, nowSec = Math.floor(Date.now() / 1000)): string {
  const h = Buffer.from(JSON.stringify({ alg: "ES256", kid: cfg.native.apns.keyId })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ iss: cfg.native.apns.teamId, iat: nowSec })).toString("base64url");
  const sig = crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: cfg.native.apns.privateKey, dsaEncoding: "ieee-p1363" });
  return `${h}.${p}.${sig.toString("base64url")}`;
}

export function createApnsSender(cfg: Config): ApnsSender {
  let cached: { jwt: string; at: number } | null = null;
  const jwt = () => { const now = Date.now(); if (!cached || now - cached.at > 40 * 60_000) cached = { jwt: apnsJwt(cfg), at: now }; return cached.jwt; };
  return (token, env, payload, opts = {}) => new Promise((resolve, reject) => {
    if (!apnsConfigured(cfg)) return reject(new Error("APNs not configured"));
    const client = http2.connect(env === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com");
    client.on("error", (e) => { client.close(); reject(e); });
    const req = client.request({ ":method": "POST", ":path": `/3/device/${token}`, authorization: `bearer ${jwt()}`, "apns-topic": cfg.native.apns.topic,
      "apns-push-type": opts.pushType ?? "alert", "apns-priority": String(opts.priority ?? 10), "content-type": "application/json" });
    let status = 0, apnsId: string | null = null, body = "";
    req.on("response", (h) => { status = Number(h[":status"]); apnsId = (h["apns-id"] as string) ?? null; });
    req.setEncoding("utf8"); req.on("data", (c) => { body += c; });
    req.on("end", () => { client.close(); let reason: string | null = null; try { reason = body ? JSON.parse(body).reason ?? null : null; } catch { reason = body.slice(0, 80); } resolve({ status, apnsId, reason }); });
    req.on("error", (e) => { client.close(); reject(e); });
    req.setTimeout(15_000, () => { req.close(); client.close(); reject(new Error("APNs timeout")); });
    req.end(JSON.stringify(payload));
  });
}

/** APNs answers that mean the token is permanently dead. */
export const deadToken = (r: ApnsResult) => r.status === 410 || ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"].includes(r.reason ?? "");
