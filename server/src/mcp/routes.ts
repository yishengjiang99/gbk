// Fastify wiring for the remote MCP endpoint, OAuth endpoints, signed artifact delivery and status.
//
// Transport: official SDK StreamableHTTPServerTransport, stateful sessions keyed by mcp-session-id.
// Auth policy: with guest projects enabled (default; MCP_GUEST=0 turns them off) anonymous tools/calls are
// accepted and authorized per call by explicit per-project capabilities (guest.ts) — a transport session is
// never a project credential, and anonymous calls are IP-throttled on top of durable global guest budgets.
// OAuth / website sessions keep working for account users. With guests off, discovery and
// gbk_get_capabilities stay anonymous and every other tools/call gets HTTP 401 + a WWW-Authenticate
// challenge pointing at the protected-resource metadata (which makes ChatGPT start the OAuth flow). A session is bound to
// the user it was created with — presenting a different user on the same session id is rejected — but
// its authorization is NOT frozen at initialize: on every request the session is rebound to the
// credentials actually presented (same user), so refreshed/narrower tokens take effect immediately,
// and an anonymous session may upgrade to an authenticated one. Idle sessions are evicted.
import { createHmac, randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DEFAULT_SOUNDFONT_PATH } from "../../../src/audio/soundfont-assets.ts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "../config.ts";
import type { SessionStore } from "../security/authentication.ts";
import { currentSession } from "../routes/agent.ts";
import type { McpStore } from "./store.ts";
import type { CompositionService } from "./service.ts";
import type { RenderService } from "./browser-render.ts";
import { createGbkMcpServer, type McpMetrics, type SessionAuth } from "./server.ts";
import { resolvePrincipal, resourceOf, SCOPES, type Principal } from "./auth.ts";
import { McpError } from "./errors.ts";
import { verifyArtifactSignature } from "./urls.ts";
import { oauthRoutes } from "./oauth.ts";
import type { FunnelStore } from "../persistence/funnel.ts";
import { resolveGuestCapability } from "./guest.ts";
import { RateLimiter } from "../security/rate-limit.ts";
import { resolveSoundFontPath, resolveWidgetAsset } from "./browser-render.ts";

export interface McpDeps {
  store: McpStore; service: CompositionService; renders: RenderService; metrics: McpMetrics; funnel?: FunnelStore;
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

  const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
  interface SessionEntry { transport: StreamableHTTPServerTransport; user: string | null; auth: SessionAuth; lastSeen: number }
  const transports = new Map<string, SessionEntry>();
  const MAX_SESSIONS = 2000;
  const guestLimiter = new RateLimiter(cfg.mcp.guestCallsPerMinute);
  const clientKey = (ip: string) => createHmac("sha256", cfg.security.sessionSecret).update(`guest-client:${ip}`).digest("hex").slice(0, 24);

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
    if (!principal && !anonAllowed) {
      if (!cfg.mcp.guestEnabled) return rpcError(reply, 401, "authentication required: connect your GBK account via OAuth", challenge);
      if (method === "tools/call" && !guestLimiter.take(req.ip)) {
        return reply.code(429).header("retry-after", String(guestLimiter.retryAfterSec(req.ip))).send({ jsonrpc: "2.0", error: { code: -32002, message: "too many account-free MCP calls from this network; retry shortly" }, id: null });
      }
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    reply.hijack();
    if (sessionId && transports.has(sessionId)) {
      const entry = transports.get(sessionId)!;
      entry.lastSeen = Date.now();
      entry.auth.client = clientKey(req.ip);
      const reqUser = principal?.user ?? null;
      if (entry.user !== reqUser) {
        // The only legal transition is anonymous -> authenticated (the OAuth flow completes after
        // initialize). A different user, or dropping credentials mid-session, is rejected.
        if (entry.user === null && reqUser !== null) { entry.user = reqUser; entry.auth.current = principal; }
        else {
          raw.statusCode = 403; raw.setHeader("content-type", "application/json");
          raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "session belongs to a different user; start a new MCP session" }, id: null }));
          return;
        }
      } else if (principal) {
        // Same user: rebind to THIS request's credentials, so scope changes (e.g. a refreshed token
        // with fewer scopes) apply to the very next tool call instead of living on from initialize.
        entry.auth.current = principal;
      }
      await entry.transport.handleRequest(req.raw, raw, body);
      return;
    }
    if (!sessionId && req.method === "POST" && method === "initialize") {
      // Evict idle sessions so abandoned transports cannot accumulate for the process lifetime.
      for (const [id, e] of transports) {
        if (Date.now() - e.lastSeen > SESSION_IDLE_MS) { transports.delete(id); void e.transport.close().catch(() => undefined); }
      }
      if (transports.size >= MAX_SESSIONS) {
        raw.statusCode = 429; raw.setHeader("retry-after", "60"); raw.setHeader("content-type", "application/json");
        raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32002, message: "MCP session capacity reached; retry later" }, id: null })); return;
      }
      deps.funnel?.bump("mcp_connect", principal ? "account" : "guest");
      const ac = new AbortController();
      // Abort tool work only when the client actually goes away mid-response; the request's own
      // 'close' fires as soon as the body is consumed and must not cancel the call.
      raw.on("close", () => { if (!raw.writableEnded) ac.abort(); });
      const auth: SessionAuth = { current: principal, client: clientKey(req.ip) };
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports.set(id, { transport, user: principal?.user ?? null, auth, lastSeen: Date.now() }); },
      });
      transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
      const server = createGbkMcpServer({ cfg, store: deps.store, service: deps.service, renders: deps.renders, auth, signal: ac.signal, metrics: deps.metrics, funnel: deps.funnel, log: deps.log });
      await server.connect(transport);
      await transport.handleRequest(req.raw, raw, body);
      return;
    }
    if (sessionId) {
      // Unknown/expired session (evicted, or lost on a restart/deploy): 404 per the MCP spec so the
      // client starts a fresh session with initialize instead of failing hard on a 400.
      raw.statusCode = 404; raw.setHeader("content-type", "application/json");
      raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "MCP session not found or expired; send a new initialize request" }, id: null }));
      return;
    }
    if (req.method === "GET" || req.method === "DELETE") {
      // No session yet: there is no standalone SSE stream to open (or session to end). Clients such as
      // Codex probe GET /mcp before initialize; 405 tells them to proceed POST-only.
      raw.statusCode = 405; raw.setHeader("allow", "POST"); raw.setHeader("content-type", "application/json");
      raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "method not allowed without an MCP session; POST initialize first" }, id: null }));
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
    if (row.created_at <= Date.now() - cfg.mcp.artifactRetentionDays * 86_400_000) return reply.code(410).send({ code: "ARTIFACT_EXPIRED", message: "artifact retention period ended; render again" });
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
    // One download per full fetch or first range (players issue many range requests per listen).
    if (!range || /^bytes=0-/.test(range)) deps.funnel?.bump(row.kind === "wav" ? "wav_download" : "midi_download", row.owner.startsWith("guest:") ? "guest" : "account");
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

  // ---- Studio-tab render handoff (browser-render.ts): capability-token endpoints the tab calls ----------
  // The in-chat player (ChatGPT widget sandbox, a different origin) calls these too: CORS without credentials - the
  // capability token in x-gbk-render-token is the only authority, so "*" grants nothing a cookie would.
  const cors = (reply: import("fastify").FastifyReply) => reply.header("access-control-allow-origin", "*").header("access-control-allow-methods", "GET, PUT, OPTIONS")
    .header("access-control-allow-headers", "x-gbk-render-token, content-type").header("access-control-max-age", "600");
  app.options("/api/mcp/render-jobs/:id/:what", async (_req, reply) => cors(reply).code(204).send());
  app.get("/api/mcp/render-jobs/:id/snapshot", async (req, reply) => {
    cors(reply);
    try { reply.header("cache-control", "no-store"); return deps.renders.snapshotFor((req.params as { id: string }).id, (req.headers["x-gbk-render-token"] ?? (req.query as { token?: string }).token)); }
    catch (e) { return reply.code(404).send({ code: "NOT_FOUND", message: (e as Error).message }); }
  });
  app.put("/api/mcp/render-jobs/:id/wav", { bodyLimit: 9 * 1024 * 1024 }, async (req, reply) => {
    cors(reply);
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf)) return reply.code(415).send({ code: "BAD_TYPE", message: "send raw bytes (application/octet-stream)" });
    try { return deps.renders.acceptChunk((req.params as { id: string }).id, req.headers["x-gbk-render-token"], Number((req.query as { offset?: string }).offset ?? 0), new Uint8Array(buf)); }
    catch (e) { const code = (e as McpError).code ?? "INVALID_ARGUMENT"; return reply.code(code === "NOT_FOUND" ? 404 : 400).send({ code, message: (e as Error).message }); }
  });

  // ---- account-free browser rendering: the read capability fetches the exact project snapshot ---------
  // Used by the in-chat player widget and the Studio tab opened from a private link to synthesize audio
  // locally (OfflineAudioContext). Token-authorized (no cookies), so it is safe to allow any origin.
  app.route({ method: ["GET", "OPTIONS"], url: "/api/mcp/guest/snapshot", handler: async (req, reply) => {
    reply.header("access-control-allow-origin", "*").header("access-control-allow-headers", "x-gbk-project-token").header("cache-control", "no-store");
    if (req.method === "OPTIONS") return reply.code(204).send();
    const token = req.headers["x-gbk-project-token"];
    try {
      if (typeof token !== "string") throw new McpError("NOT_FOUND", "send the project readAccessToken in x-gbk-project-token");
      const g = resolveGuestCapability(cfg, deps.store, token);
      const row = deps.service.getRow(g.user, g.compositionId);
      return { compositionId: row.id, revision: row.revision, title: row.title, project: JSON.parse(row.project_json) };
    } catch (e) { return reply.code(404).send({ code: "NOT_FOUND", message: (e as Error).message }); }
  } });
  // ---- in-chat player assets (scripts/build-widget.mjs): renderer bundle, SF2 worklet, the bundled SoundFont ----
  // Public, static, no user data. CORS + CORP so the sandboxed widget origin may load them (script, worklet, fetch).
  const widgetFiles: Record<string, string> = { "gbk-widget-render.js": "text/javascript; charset=utf-8", "sf2-processor.js": "text/javascript; charset=utf-8" };
  app.get("/api/mcp/widget/:file", async (req, reply) => {
    const file = (req.params as { file: string }).file;
    reply.header("access-control-allow-origin", "*").header("cross-origin-resource-policy", "cross-origin");
    let path: string; let type: string;
    try {
      if (file === "soundfont.sf2") {
        path = resolveSoundFontPath(cfg); type = "application/octet-stream";
        // ?v=<sha12> (the widget's pinned font) is immutable; precompressed gzip sibling from the build when accepted.
        const v = String((req.query as { v?: string }).v ?? "");
        const pinned = v && DEFAULT_SOUNDFONT_PATH.includes(`.${v}.sf2`);
        reply.header("cache-control", pinned ? "public, max-age=31536000, immutable" : "public, max-age=86400").header("vary", "Accept-Encoding");
        const gz = join(dirname(path), "sf", `${basename(DEFAULT_SOUNDFONT_PATH)}.gz`);
        if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? "")) && existsSync(gz)) {
          reply.type(type).header("content-encoding", "gzip").header("content-length", String(statSync(gz).size));
          return reply.send(createReadStream(gz));
        }
      }
      else if (widgetFiles[file]) { path = resolveWidgetAsset(file); type = widgetFiles[file]; reply.header("cache-control", "public, max-age=300"); }
      else return reply.code(404).send({ code: "NOT_FOUND", message: "no such widget asset" });
    } catch (e) { return reply.code(404).send({ code: "NOT_FOUND", message: (e as Error).message }); }
    reply.type(type).header("content-length", String(statSync(path).size));
    return reply.send(createReadStream(path));
  });

  // ---- operational status (no private data) --------------------------------------------------
  app.get("/api/mcp/status", async () => ({
    enabled: true, version: "1.0.0", transport: "streamable-http", executor: deps.renders.executor,
    queueDepth: deps.store.queueDepth(), metrics: { calls: deps.metrics.calls, errors: deps.metrics.errors, authFailures: deps.metrics.authFailures, byTool: deps.metrics.byTool, ...deps.store.metrics() },
  }));

  return { close: async () => { for (const { transport } of transports.values()) await transport.close().catch(() => undefined); transports.clear(); } };
}
