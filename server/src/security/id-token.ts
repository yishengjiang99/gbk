// RS256 ID-token verification against a provider JWKS (Sign in with Apple, Google). node:crypto only.
import { createPublicKey, verify, type JsonWebKeyInput } from "node:crypto";
type JsonWebKey = JsonWebKeyInput["key"];

type FetchLike = typeof fetch;
export interface IdClaims { iss: string; aud: string | string[]; sub: string; exp: number; iat?: number; email?: string; email_verified?: boolean | string; name?: string; nonce?: string; [k: string]: unknown }
export class IdTokenError extends Error {}
const cache = new Map<string, { at: number; keys: (JsonWebKey & { kid?: string })[] }>();
const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

async function jwks(url: string, http: FetchLike, now: number, force = false) {
  const c = cache.get(url); if (c && !force && now - c.at < 3_600_000) return c.keys;
  const r = await http(url, { signal: AbortSignal.timeout(10_000) }); if (!r.ok) throw new IdTokenError(`jwks ${r.status}`);
  const keys = ((await r.json()) as { keys?: (JsonWebKey & { kid?: string })[] }).keys ?? []; cache.set(url, { at: now, keys }); return keys;
}

export async function verifyIdToken(jwt: unknown, o: { jwksUrl: string; issuers: string[]; audiences: string[]; fetch?: FetchLike; now?: number; leewaySec?: number }): Promise<IdClaims> {
  if (typeof jwt !== "string" || jwt.length > 8192) throw new IdTokenError("token missing");
  const parts = jwt.split("."); if (parts.length !== 3) throw new IdTokenError("malformed token");
  let h: { alg?: string; kid?: string }, p: IdClaims;
  try { h = b64json(parts[0]); p = b64json(parts[1]); } catch { throw new IdTokenError("malformed token"); }
  if (h.alg !== "RS256" || !h.kid) throw new IdTokenError("unsupported alg");
  const now = o.now ?? Date.now(); const http = o.fetch ?? fetch;
  let key = (await jwks(o.jwksUrl, http, now)).find((k) => k.kid === h.kid);
  if (!key) key = (await jwks(o.jwksUrl, http, now, true)).find((k) => k.kid === h.kid); // key rotation
  if (!key) throw new IdTokenError("unknown key");
  const ok = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url"));
  if (!ok) throw new IdTokenError("bad signature");
  const t = Math.floor(now / 1000), lee = o.leewaySec ?? 60;
  if (!o.issuers.includes(p.iss)) throw new IdTokenError("bad issuer");
  const auds = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!auds.some((a) => o.audiences.includes(a))) throw new IdTokenError("bad audience");
  if (typeof p.exp !== "number" || p.exp + lee < t) throw new IdTokenError("expired");
  if (typeof p.iat === "number" && p.iat - lee > t) throw new IdTokenError("issued in the future");
  if (typeof p.sub !== "string" || !p.sub) throw new IdTokenError("no subject");
  return p;
}
