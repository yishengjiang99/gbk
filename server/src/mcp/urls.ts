// Short-lived signed artifact URLs. The signature binds the artifact id + expiry and is keyed by the
// server SESSION_SECRET (never shipped to clients). Possession of a signed URL authorizes ONE artifact
// until expiry; the artifact route ALSO accepts a Bearer token / session cookie and re-checks ownership
// on every request, so revoked access stops working for non-URL paths immediately.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.ts";

export function signArtifactUrl(cfg: Config, artifactId: string): { url: string; expiresAt: string } {
  const exp = Math.floor(Date.now() / 1000) + cfg.mcp.artifactUrlTtlSec;
  const sig = createHmac("sha256", cfg.security.sessionSecret).update(`artifact:${artifactId}:${exp}`).digest("base64url");
  return { url: `${cfg.publicOrigin}/api/mcp/artifacts/${artifactId}?exp=${exp}&sig=${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyArtifactSignature(cfg: Config, artifactId: string, expRaw: string | undefined, sig: string | undefined): boolean {
  if (!expRaw || !sig) return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const want = createHmac("sha256", cfg.security.sessionSecret).update(`artifact:${artifactId}:${exp}`).digest("base64url");
  const a = Buffer.from(want), b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}
