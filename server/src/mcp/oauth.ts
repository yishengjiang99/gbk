// OAuth 2.1 authorization server for the MCP endpoint (same origin as the resource server), implementing
// the MCP authorization contract:
//  - RFC 9728 protected-resource metadata at /.well-known/oauth-protected-resource (+ /mcp path variant)
//  - RFC 8414 authorization-server metadata at /.well-known/oauth-authorization-server (+ openid-configuration)
//  - Authorization code + PKCE (S256 only), with the `resource` parameter echoed into the token audience
//  - RFC 9207 issuer identification: every authorization response carries `iss`
//  - Dynamic Client Registration (RFC 7591) for public clients (token_endpoint_auth_method "none")
//  - Client ID Metadata Documents (CIMD): an https URL client_id is accepted when its host is allowlisted
//    (default chatgpt.com); the document is fetched over HTTPS with size/time limits and its redirect_uris
//    are enforced — never fetched for arbitrary hosts (SSRF guard)
//  - Refresh-token rotation with family revocation on reuse, and RFC 7009 revocation
//
// Account linking: /oauth/authorize requires the website's existing GBK session (invite-code login). The
// GBK user from that session becomes the token subject — the OAuth client never chooses the user.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import type { SessionStore } from "../security/authentication.ts";
import { parseCookies, COOKIE } from "../security/authentication.ts";
import { McpStore, hashToken, newOpaqueId } from "./store.ts";
import { SCOPES, issuerOf, resourceOf, type Scope } from "./auth.ts";

const b64url = (b: Buffer) => b.toString("base64url");
const pkceOk = (verifier: string, challenge: string) => {
  const got = createHash("sha256").update(verifier).digest();
  const exp = Buffer.from(challenge, "base64url");
  return got.length === exp.length && timingSafeEqual(got, exp);
};
const err = (reply: FastifyReply, status: number, error: string, description: string) => reply.code(status).send({ error, error_description: description });

export function oauthRoutes(app: FastifyInstance, cfg: Config, sessions: SessionStore, store: McpStore) {
  // OAuth token/registration posts are form-encoded by spec; Fastify ships no urlencoded parser by default.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    try { done(null, Object.fromEntries(new URLSearchParams(body as string))); } catch (e) { done(e as Error); }
  });
  const issuer = issuerOf(cfg);
  const resource = resourceOf(cfg);
  const sessionUser = (req: FastifyRequest): string | null => sessions.fromCookie(parseCookies(req.headers.cookie)[COOKIE])?.user ?? null;

  const protectedResource = {
    resource, authorization_servers: [issuer], scopes_supported: [...SCOPES],
    resource_documentation: `${cfg.publicOrigin}/docs/chatgpt-plugin.md`, bearer_methods_supported: ["header"],
  };
  app.get("/.well-known/oauth-protected-resource", async () => protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", async () => protectedResource);

  const asMetadata = {
    issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`, revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: [...SCOPES], response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
  };
  app.get("/.well-known/oauth-authorization-server", async () => asMetadata);
  app.get("/.well-known/openid-configuration", async () => asMetadata);

  // ---- Dynamic Client Registration (public clients only) -------------------------------
  app.post("/oauth/register", { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const b = (req.body ?? {}) as { client_name?: unknown; redirect_uris?: unknown; grant_types?: unknown };
    const redirects = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (!redirects.length || redirects.length > 10) return err(reply, 400, "invalid_redirect_uri", "redirect_uris must contain 1..10 URIs");
    for (const u of redirects) {
      let url: URL; try { url = new URL(u); } catch { return err(reply, 400, "invalid_redirect_uri", `not a URL: ${u}`); }
      const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
      if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) return err(reply, 400, "invalid_redirect_uri", "redirect URIs must be https (http allowed only for loopback)");
      if (url.hash) return err(reply, 400, "invalid_redirect_uri", "redirect URIs must not contain a fragment");
    }
    const clientId = `gbk_${randomBytes(12).toString("hex")}`;
    store.putClient({ client_id: clientId, client_name: typeof b.client_name === "string" ? b.client_name.slice(0, 80) : "MCP client",
      redirect_uris: JSON.stringify(redirects), grant_types: JSON.stringify(["authorization_code", "refresh_token"]), created_at: Date.now(), cimd: 0 });
    return reply.code(201).send({ client_id: clientId, client_name: typeof b.client_name === "string" ? b.client_name : "MCP client",
      redirect_uris: redirects, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
  });

  /** Resolve a client: DCR row, or a CIMD document (https URL client_id on an allowlisted host). */
  async function resolveClient(clientId: string): Promise<{ client_id: string; redirect_uris: string[] } | null> {
    const row = store.getClient(clientId);
    if (row) return { client_id: row.client_id, redirect_uris: JSON.parse(row.redirect_uris) as string[] };
    if (!/^https:\/\//.test(clientId)) return null;
    let url: URL; try { url = new URL(clientId); } catch { return null; }
    if (!cfg.mcp.cimdHosts.includes(url.hostname)) return null;
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
      const res = await fetch(clientId, { signal: ctl.signal, redirect: "error", headers: { accept: "application/json" } });
      clearTimeout(t);
      if (!res.ok) return null;
      const text = await res.text();
      if (text.length > 32 * 1024) return null;
      const doc = JSON.parse(text) as { client_id?: string; redirect_uris?: string[]; client_name?: string };
      if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length) return null;
      store.putClient({ client_id: clientId, client_name: (doc.client_name ?? "CIMD client").slice(0, 80), redirect_uris: JSON.stringify(doc.redirect_uris.slice(0, 10)), grant_types: JSON.stringify(["authorization_code", "refresh_token"]), created_at: Date.now(), cimd: 1 });
      return { client_id: clientId, redirect_uris: doc.redirect_uris };
    } catch { return null; }
  }

  const redirectWith = (reply: FastifyReply, uri: string, params: Record<string, string>) => {
    const u = new URL(uri); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return reply.redirect(u.toString());
  };

  // ---- Authorization endpoint -------------------------------------------------------------
  app.get("/oauth/authorize", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const clientId = q.client_id ?? ""; const redirectUri = q.redirect_uri ?? "";
    const client = clientId ? await resolveClient(clientId) : null;
    if (!client) return err(reply, 400, "invalid_client", "unknown client_id (use dynamic registration or a CIMD document URL)");
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) return err(reply, 400, "invalid_redirect_uri", "redirect_uri is not registered for this client");
    const fail = (error: string, description: string) => redirectWith(reply, redirectUri, { error, error_description: description, iss: issuer, ...(q.state ? { state: q.state } : {}) });
    if (q.response_type !== "code") return fail("unsupported_response_type", "only response_type=code is supported");
    if (!q.code_challenge || q.code_challenge_method !== "S256") return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
    if (q.resource && q.resource !== resource) return fail("invalid_target", `resource must be ${resource}`);
    const scope = (q.scope ?? SCOPES.join(" ")).split(/\s+/).filter(Boolean);
    const badScope = scope.find((s) => !(SCOPES as readonly string[]).includes(s));
    if (badScope) return fail("invalid_scope", `unknown scope ${badScope}`);
    const user = sessionUser(req);
    if (!user) {
      // Account linking step: the user signs in to GBK (existing invite-code login), then returns here.
      const back = `${issuer}/oauth/authorize?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined) as [string, string][]).toString()}`;
      return reply.type("text/html").send(`<!doctype html><meta charset="utf-8"><title>Connect GBK Composer</title>
<body style="font-family:system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem">
<h1>Connect GBK Composer</h1>
<p>Sign in to GBK Composer first (the same invite code you use at <a href="${issuer}/">${issuer}</a>), then open this link again to approve the connection:</p>
<p><a href="${back.replace(/&/g, "&amp;")}">${back.replace(/&/g, "&amp;")}</a></p>
<p>The app requesting access will receive only the scopes you approve, and only for your own compositions.</p></body>`);
    }
    if (q.confirm !== "1") {
      const approve = new URL(`${issuer}/oauth/authorize`);
      for (const [k, v] of Object.entries(q)) if (v !== undefined) approve.searchParams.set(k, v);
      approve.searchParams.set("confirm", "1");
      return reply.type("text/html").send(`<!doctype html><meta charset="utf-8"><title>Authorize GBK Composer access</title>
<body style="font-family:system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem">
<h1>Authorize access to GBK Composer</h1>
<p>Signed in as <strong>${user.replace(/[<>&"]/g, "")}</strong>. The client <strong>${clientId.replace(/[<>&"]/g, "")}</strong> requests these scopes:</p>
<ul>${scope.map((s) => `<li>${s}</li>`).join("")}</ul>
<p>It will be able to act only on your own compositions and renders. You can revoke access at any time via POST /oauth/revoke.</p>
<p><a href="${approve.toString().replace(/&/g, "&amp;")}" style="font-size:1.1rem">Approve and connect</a></p></body>`);
    }
    const code = b64url(randomBytes(24));
    store.putCode({ code_hash: hashToken(code), client_id: clientId, user, redirect_uri: redirectUri, scope: scope.join(" "),
      code_challenge: q.code_challenge, resource: q.resource ?? resource, expires_at: Date.now() + cfg.mcp.authCodeTtlSec * 1000 });
    req.log.info({ evt: "oauth_code_issued", user, clientId });
    return redirectWith(reply, redirectUri, { code, iss: issuer, ...(q.state ? { state: q.state } : {}) });
  });

  // ---- Token endpoint ---------------------------------------------------------------------
  const issueTokens = (clientId: string, user: string, scope: string, family: string) => {
    const access = `gbk_at_${b64url(randomBytes(24))}`;
    const refresh = `gbk_rt_${b64url(randomBytes(24))}`;
    const now = Date.now();
    store.putToken({ token: access, kind: "access", client_id: clientId, user, scope, resource, expires_at: now + cfg.mcp.accessTokenTtlSec * 1000, family });
    store.putToken({ token: refresh, kind: "refresh", client_id: clientId, user, scope, resource, expires_at: now + cfg.mcp.refreshTokenTtlSec * 1000, family });
    return { access_token: access, token_type: "Bearer", expires_in: cfg.mcp.accessTokenTtlSec, refresh_token: refresh, scope };
  };
  app.post("/oauth/token", { bodyLimit: 16 * 1024 }, async (req, reply) => {
    // Fastify's built-in parser handles both application/x-www-form-urlencoded and JSON bodies.
    const form = (req.body ?? {}) as Record<string, string | undefined>;
    const g = form.grant_type;
    if (g === "authorization_code") {
      const codeRow = form.code ? store.takeCode(hashToken(form.code)) : null;
      if (!codeRow) return err(reply, 400, "invalid_grant", "authorization code is invalid, expired, or already used");
      if (codeRow.expires_at <= Date.now()) return err(reply, 400, "invalid_grant", "authorization code expired");
      if (codeRow.client_id !== form.client_id) return err(reply, 400, "invalid_grant", "client_id does not match the code");
      if (codeRow.redirect_uri !== form.redirect_uri) return err(reply, 400, "invalid_grant", "redirect_uri does not match the authorization request");
      if (form.resource && form.resource !== codeRow.resource) return err(reply, 400, "invalid_target", "resource does not match the authorization request");
      if (!form.code_verifier || !pkceOk(form.code_verifier, codeRow.code_challenge)) return err(reply, 400, "invalid_grant", "PKCE verification failed");
      return issueTokens(codeRow.client_id, codeRow.user, codeRow.scope, newOpaqueId("fam"));
    }
    if (g === "refresh_token") {
      const row = form.refresh_token ? store.getToken(form.refresh_token) : null;
      if (!row || row.kind !== "refresh" || row.client_id !== form.client_id) return err(reply, 400, "invalid_grant", "refresh token is invalid");
      if (row.revoked || row.expires_at <= Date.now()) {
        if (row.revoked) store.revokeFamily(row.family); // reuse of a rotated token revokes the whole family
        return err(reply, 400, "invalid_grant", "refresh token expired or revoked");
      }
      store.revokeToken(form.refresh_token!);
      return issueTokens(row.client_id, row.user, row.scope, row.family);
    }
    return err(reply, 400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  });

  // ---- Revocation (RFC 7009): token owner or the linked GBK session ------------------------
  app.post("/oauth/revoke", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    const b = (req.body ?? {}) as { token?: string };
    const token = typeof b.token === "string" ? b.token : "";
    if (!token) return err(reply, 400, "invalid_request", "token is required");
    const row = store.getToken(token);
    if (row) store.revokeToken(token);
    return { revoked: !!row };
  });
}
