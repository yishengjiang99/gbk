// StoreKit 2 / App Store Server Notifications v2 JWS verification (docs/social-api.md "In-app purchases — Apple").
// x5c chain [leaf, intermediate, (root)] must chain to a pinned root; every cert within validity; leaf carries the
// Apple receipt-signing OID 1.2.840.113635.100.6.11.1; ES256 signature checked with the leaf key.
import { X509Certificate, verify } from "node:crypto";
import { APPLE_ROOT_CA_G3_B64 } from "./apple-root.ts";

export class JwsError extends Error {}
export const appleRoot = () => new X509Certificate(Buffer.from(APPLE_ROOT_CA_G3_B64, "base64"));
// DER of OID 1.2.840.113635.100.6.11.1
const LEAF_OID = Buffer.from("060a2a864886f76364060b01", "hex");

export function verifyAppleJws<T = Record<string, unknown>>(jws: unknown, o: { roots: X509Certificate[]; now?: number }): T {
  if (typeof jws !== "string" || jws.length > 65536) throw new JwsError("not a JWS");
  const parts = jws.split("."); if (parts.length !== 3) throw new JwsError("not a JWS");
  let header: { alg?: string; x5c?: string[] }; let payload: T;
  try { header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { throw new JwsError("malformed JWS"); }
  if (header.alg !== "ES256") throw new JwsError("alg must be ES256");
  if (!Array.isArray(header.x5c) || header.x5c.length < 2 || header.x5c.length > 3) throw new JwsError("x5c chain missing");
  let chain: X509Certificate[]; try { chain = header.x5c.map((c) => new X509Certificate(Buffer.from(c, "base64"))); } catch { throw new JwsError("bad x5c certificate"); }
  const now = o.now ?? Date.now();
  for (const c of chain) if (now < Date.parse(c.validFrom) || now > Date.parse(c.validTo)) throw new JwsError("certificate outside validity");
  const [leaf, inter] = chain;
  if (!leaf.verify(inter.publicKey)) throw new JwsError("leaf not signed by intermediate");
  const root = o.roots.find((r) => inter.verify(r.publicKey) && inter.checkIssued(r));
  if (!root) throw new JwsError("chain does not reach the pinned Apple root");
  if (chain[2] && chain[2].fingerprint256 !== root.fingerprint256) throw new JwsError("x5c root is not the pinned root");
  if (!leaf.raw.includes(LEAF_OID)) throw new JwsError("leaf lacks the Apple receipt-signing OID");
  const ok = verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: leaf.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2], "base64url"));
  if (!ok) throw new JwsError("bad signature");
  return payload;
}
