// Authentication + authorization for the remote MCP surface.
//
// Principals come from exactly three sources, checked in this order:
//  1. OAuth 2.1 access tokens issued by this server's authorization endpoints (Bearer). The token record
//     carries the GBK user it was linked to, its scopes and its audience (resource); all three are verified
//     on every request. The model can never assert a user id — identity comes only from the token row.
//  2. The website's existing HMAC session cookie (same GBK user names as invite-code login). This is how
//     GBK Studio and local tooling call the MCP endpoint same-origin.
//  3. An explicitly configured LOCAL TEST mode (MCP_TEST_AUTH=1, refused in production by loadConfig):
//     `Authorization: Bearer test:<user>` or `x-gbk-test-user: <user>`, granting all scopes. For automated
//     tests and MCP Inspector development only.
import type { Config } from "../config.ts";
import type { McpStore } from "./store.ts";
import { McpError } from "./errors.ts";

export const SCOPES = [
  "gbk:compositions.read",
  "gbk:compositions.write",
  "gbk:renders.create",
  "gbk:artifacts.read",
  "gbk:shares.publish",
] as const;
export type Scope = (typeof SCOPES)[number];
export const ALL_SCOPES: Scope[] = [...SCOPES];

export interface Principal {
  user: string;
  scopes: Scope[];
  via: "oauth" | "session" | "test";
  clientId?: string;
}

export function requireScope(p: Principal | null, scope: Scope): Principal {
  if (!p) throw new McpError("UNAUTHENTICATED", "authentication required: connect your GBK account (OAuth) and retry");
  if (!p.scopes.includes(scope)) throw new McpError("INSUFFICIENT_SCOPE", `this token lacks the ${scope} scope`, { required: scope, granted: p.scopes });
  return p;
}

const sanitizeUser = (u: string) => u.replace(/[^\w.-]/g, "").slice(0, 40);

export function resolvePrincipal(
  cfg: Config,
  store: McpStore,
  headers: Record<string, string | string[] | undefined>,
  sessionUser: string | null,
  resource: string,
): Principal | null {
  const auth = typeof headers.authorization === "string" ? headers.authorization : "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (bearer) {
    if (cfg.mcp.testAuth && bearer.startsWith("test:")) {
      const user = sanitizeUser(bearer.slice(5));
      if (user) return { user, scopes: [...ALL_SCOPES], via: "test" };
    }
    const tok = store.getToken(bearer);
    if (tok && tok.kind === "access" && !tok.revoked) {
      if (tok.expires_at <= Date.now()) throw new McpError("UNAUTHENTICATED", "access token expired; re-authorize");
      if (tok.resource !== resource) throw new McpError("UNAUTHENTICATED", "access token was issued for a different resource (audience mismatch)");
      const scopes = tok.scope.split(/\s+/).filter((s): s is Scope => (ALL_SCOPES as string[]).includes(s));
      return { user: tok.user, scopes, via: "oauth", clientId: tok.client_id };
    }
    // A Bearer header that matches nothing is a failed login attempt, not an anonymous request.
    throw new McpError("UNAUTHENTICATED", "invalid access token");
  }
  if (cfg.mcp.testAuth) {
    const h = headers["x-gbk-test-user"];
    const user = typeof h === "string" ? sanitizeUser(h) : "";
    if (user) return { user, scopes: [...ALL_SCOPES], via: "test" };
  }
  if (sessionUser) return { user: sessionUser, scopes: [...ALL_SCOPES], via: "session" };
  return null;
}

/** Canonical resource identifier for this MCP server (audience). */
export const resourceOf = (cfg: Config) => `${cfg.publicOrigin}/mcp`;
/** Issuer identifier: this server is its own authorization server (same origin). */
export const issuerOf = (cfg: Config) => cfg.publicOrigin;
