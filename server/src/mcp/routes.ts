// Fastify wiring for the remote MCP endpoint, OAuth endpoints, signed artifact delivery and status.
//
// Transport: official SDK StreamableHTTPServerTransport, stateful sessions keyed by mcp-session-id.
// Auth policy (MCP authorization spec): discovery (initialize / tools/list / resources) and the single
// public read-only tool gbk_get_capabilities may run anonymously; every other tools/call requires a
// principal. A tools/call without one gets HTTP 401 + a WWW-Authenticate challenge pointing at the
// protected-resource metadata, which is what makes ChatGPT start the OAuth flow. A session is bound to
// the user it was created with — presenting a different user on the same session id is rejected.
import { randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "../config.ts";
import type { SessionStore } from "../security/authentication.ts";
import { currentSession } from "../routes/agent.ts";
import type { McpStore } from "./store.ts";
import type { CompositionService } from "./service.ts";
import type { RenderService } from "./render.ts";
import { createGbkMcpServer, type McpMetrics } from "./server.ts";
import { resolvePrincipal, resourceOf, SCOPES, type Principal } from "./auth.ts";
import { McpError } from "./errors.ts";
import { verifyArtifactSignature } from "./urls.ts";
import { oauthRoutes } from "./oauth.ts";

export interface McpDeps {
  store: McpStore; service: CompositionService; renders: RenderService; metrics: McpMetrics;
  log: (o: object) => void;
}

const ANON_METHODS = new Set(["initialize", "ping", "tools/list", "resources/list", "resources/read", "resources/templates/list", "prompts/list"]);
const ANON_TOOLS = new Set(["gbk_get_capabilities"]);

function rpcError(reply: import("fastify").FastifyReply, status: number, message: string, challenge?: string) {
  const r = reply.code(status);
  if (challenge) r.header("www-authenticate", challenge);
  return r.send({ jsonrpc: "2.0", error: { code: -32001, message }, id: null });
}

export function mcpRoutes(app: FastifyInstance, cfg: Config, sessions: SessionStore, deps: McpDeps) {
  if (!cfg.mcp.enabled) {
    app.all("/mcp", async (_req, reply) => reply.code(503).send({ code: "MCP_DISABLED", message: "the MCP endpoint is disabled on this server (MCP_ENABLED=0)" }));
    return { close: async () => {} };
  }
  oauthRoutes(app, cfg, sessions, deps.store);
  const resource = resourceOf(cfg);
  const challenge = `Bearer resource_metadata="${cfg.publicOrigin}/.well-known/oauth-protected-resource", scope="${SCOPES.join(" ")}"`;
  const sessionUserOf = (req: FastifyRequest) => currentSession(req, sessions)?.user ?? null;

  const transports = new Map<string, { transport: StreamableHTTPServerTransport; user: string | null }>();

  const handle = async (req: FastifyRequest, reply: import("fastify").FastifyReply) => {
    const raw = reply.raw;
    raw.setHeader("access-control-allow-origin", "*");
    raw.setHeader("access-control-allow-headers", "content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id");
    raw.setHeader("access-control-expose-headers", "mcp-session-id");
    if (req.method === "OPTIONS") { raw.statusCode = 204; raw.end(); return; }

    const body = (req.body ?? undefined) as { method?: string; params?: { name?: string } } | unknown[] | undefined;
    const first = Array.isArray(body) ? body[0] as { method?: string; params?: { name?: string } } : body;
    const method = first?.method ?? "";
    const isNotification = method.startsWith("notifications/");

    let principal: Principal | null;
    try { principal = resolvePrincipal(cfg, deps.store, req.headers, sessionUserOf(req), resource); }
    catch (e) {
      if (e instanceof McpError && e.code === "UNAUTHENTICATED") return rpcError(reply, 401, e.message, challenge);
      throw e;
    }
    const anonAllowed = ANON_METHODS.has(method) || isNotification || (method === "tools/call" && !!first?.params?.name && ANON_TOOLS.has(first.params.name));
    if (!principal && !anonAllowed) return rpcError(reply, 401, "authentication required: connect your GBK account via OAuth", challenge);

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    reply.hijack();
    if (sessionId && transports.has(sessionId)) {
      const entry = transports.get(sessionId)!;
      if ((entry.user ?? null) !== (principal?.user ?? null)) {
        raw.statusCode = 403; raw.setHeader("content-type", "application/json");
        raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "session belongs to a different user; start a new MCP session" }, id: null }));
        return;
      }
      await entry.transport.handleRequest(req.raw, raw, body);
      return;
    }
    if (!sessionId && req.method === "POST" && method === "initialize") {
      const ac = new AbortController();
      // Abort tool work only when the client actually goes away mid-response; the request's own
      // 'close' fires as soon as the body is consumed and must not cancel the call.
      raw.on("close", () => { if (!raw.writableEnded) ac.abort(); });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports.set(id, { transport, user: principal?.user ?? null }); },
      });
      transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
      const server = createGbkMcpServer({ cfg, store: deps.store, service: deps.service, renders: deps.renders, principal, signal: ac.signal, metrics: deps.metrics, log: deps.log });
      await server.connect(transport);
      await transport.handleRequest(req.raw, raw, body);
      return;
    }
    raw.statusCode = 400; raw.setHeader("content-type", "application/json");
    raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "no MCP session: send an initialize request first (stateless requests are not accepted)" }, id: null }));
  };
  app.route({ method: ["GET", "POST", "DELETE", "OPTIONS"], url: "/mcp", bodyLimit: 1024 * 1024, handler: handle });

  // ---- artifact delivery ------------------------------------------------------------------
  const serveArtifact = async (req: FastifyRequest, reply: import("fastify").FastifyReply) => {
    const { id } = req.params as { id: string };
    const row = deps.store.getArtifactAny(id);
    if (!row) return reply.code(404).send({ code: "NOT_FOUND", message: "no such artifact" });
    const q = req.query as { exp?: string; sig?: string };
    const signed = verifyArtifactSignature(cfg, id, q.exp, q.sig);
    if (!signed) {
      let principal: Principal | null = null;
      try { principal = resolvePrincipal(cfg, deps.store, req.headers, sessionUserOf(req), resource); } catch { principal = null; }
      if (!principal) return reply.code(401).header("www-authenticate", challenge).send({ code: "UNAUTHENTICATED", message: "artifact URLs expire; fetch a fresh one with gbk_get_artifacts, or send your access token" });
      if (principal.user !== row.owner) return reply.code(404).send({ code: "NOT_FOUND", message: "no such artifact" });
      if (!principal.scopes.includes("gbk:artifacts.read") && principal.via !== "test") return reply.code(403).send({ code: "INSUFFICIENT_SCOPE", message: "gbk:artifacts.read scope required" });
    }
    const path = deps.store.artifactAbsPath(row);
    let size: number;
    try { size = statSync(path).size; } catch { return reply.code(410).send({ code: "ARTIFACT_EXPIRED", message: "artifact bytes are no longer stored" }); }
    if (size !== row.size_bytes) req.log.warn({ evt: "mcp_artifact_size_mismatch", artifactId: id, stored: row.size_bytes, onDisk: size });
    const range = req.headers.range;
    reply.header("content-type", row.mime_type).header("accept-ranges", "bytes")
      .header("content-disposition", `inline; filename="${row.filename.replace(/["\\]/g, "_")}"`)
      .header("x-content-type-options", "nosniff").header("cache-control", "private, no-store");
    if (req.method === "HEAD") { reply.header("content-length", String(size)); return reply.code(200).send(); }
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (m) {
      const start = m[1] ? Number(m[1]) : 0; const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start > end || start >= size) return reply.code(416).header("content-range", `bytes */${size}`).send({ code: "INVALID_RANGE", message: "range not satisfiable" });
      reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", String(end - start + 1));
      return reply.send(createReadStream(path, { start, end }));
    }
    reply.header("content-length", String(size));
    return reply.send(createReadStream(path));
  };
  app.get("/api/mcp/artifacts/:id", serveArtifact); // Fastify auto-exposes HEAD for this GET route

  // ---- operational status (no private data) --------------------------------------------------
  app.get("/api/mcp/status", async () => ({
    enabled: true, version: "1.0.0", transport: "streamable-http", executor: deps.renders.executor,
    queueDepth: deps.store.queueDepth(), metrics: { calls: deps.metrics.calls, errors: deps.metrics.errors, authFailures: deps.metrics.authFailures, byTool: deps.metrics.byTool, ...deps.store.metrics() },
  }));

  return { close: async () => { for (const { transport } of transports.values()) await transport.close().catch(() => undefined); transports.clear(); } };
}
