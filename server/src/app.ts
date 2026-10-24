// Fastify app factory (used by index.ts and the tests).
import Fastify, { type FastifyInstance } from "fastify";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Config } from "./config.ts";
import { SessionStore } from "./security/authentication.ts";
import { RateLimiter } from "./security/rate-limit.ts";
import { ToolCatalog } from "./agent/tool-catalog.ts";
import { AccountLimits, UsageLedger } from "./agent/limits.ts";
import { AccountStore } from "./persistence/accounts.ts";
import { signinRoutes } from "./routes/signin.ts";
import { AgentRuntime } from "./agent/runtime.ts";
import { createModelClient, type ModelClient } from "./agent/model-client.ts";
import { ConversationStore } from "./persistence/conversations.ts";
import { ShareStore } from "./persistence/shares.ts";
import { AgentHub } from "./bridge/websocket.ts";
import { healthRoutes } from "./routes/health.ts";
import { configRoutes } from "./routes/config.ts";
import { agentRoutes } from "./routes/agent.ts";
import { shareRoutes } from "./routes/shares.ts";
import { McpStore } from "./mcp/store.ts";
import { CompositionService } from "./mcp/service.ts";
import { RenderService } from "./mcp/render.ts";
import { mcpRoutes } from "./mcp/routes.ts";
import { resolveGuestCapability } from "./mcp/guest.ts";
import type { McpMetrics } from "./mcp/server.ts";

export const VERSION = process.env.GBK_COMPOSER_VERSION ?? "dev";

export interface AppDeps { model?: ModelClient; persist?: boolean; logger?: boolean | object; fetch?: typeof fetch; now?: () => number }
export interface McpHandle { store: McpStore; service: CompositionService; renders: RenderService; metrics: McpMetrics; close: () => Promise<void> }
export async function buildApp(cfg: Config, deps: AppDeps = {}): Promise<{ app: FastifyInstance; hub: AgentHub; sessions: SessionStore; ledger: UsageLedger; shares: ShareStore; mcp: McpHandle; accounts: AccountStore }> {
  const app = Fastify({ logger: deps.logger ?? { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.cookie", "req.headers.authorization", "req.headers[\"x-gbk-project-token\"]", "req.headers[\"x-gbk-csrf\"]"] }, bodyLimit: 64 * 1024, trustProxy: "127.0.0.1", disableRequestLogging: false });
  const sessions = new SessionStore(cfg);
  const catalog = new ToolCatalog();
  const persistEarly = deps.persist !== false;
  const accounts = new AccountStore(persistEarly ? join(cfg.dataDir, "accounts.sqlite") : ":memory:", deps.now);
  const limits = new AccountLimits(cfg, accounts, deps.now);
  const ledger = new UsageLedger(cfg, deps.now, accounts, limits);
  const model = deps.model ?? createModelClient(cfg.llm.apiStyle, { baseUrl: cfg.llm.baseUrl, apiKey: cfg.llm.apiKey, timeoutMs: cfg.llm.requestTimeoutMs, maxRetries: cfg.llm.maxRetries, stream: cfg.llm.stream, log: (o) => app.log.warn(o) });
  const runtime = new AgentRuntime(cfg, model, catalog, ledger);
  const persist = deps.persist !== false;
  const convs = new ConversationStore(persist ? cfg.dataDir : null);
  const shares = new ShareStore(persist ? join(cfg.dataDir, "shares.sqlite") : ":memory:");
  const hub = new AgentHub(cfg, sessions, runtime, catalog, convs, new RateLimiter(cfg.security.messagesPerMinute), new RateLimiter(cfg.security.ipRequestsPerMinute), (o) => app.log.info(o));
  const ipLimiter = new RateLimiter(cfg.security.ipRequestsPerMinute);
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/api/health")) return;
    // Network throttling supplements durable global guest budgets; IP is never an identity.
    if (!ipLimiter.take(req.ip)) return reply.code(429).header("retry-after", String(ipLimiter.retryAfterSec(req.ip))).send({ code: "RATE_LIMITED", message: "too many requests" });
  });
  app.addHook("onSend", async (_req, reply, payload) => { reply.header("x-content-type-options", "nosniff"); if (!reply.getHeader("cache-control")) reply.header("cache-control", "no-store"); return payload; });
  healthRoutes(app, cfg, () => ({ connections: hub.registry.size, activeRuns: hub.activeRuns }), VERSION);
  configRoutes(app, cfg);
  agentRoutes(app, cfg, sessions, new RateLimiter(cfg.security.loginPerMinute), accounts, limits, ledger);
  signinRoutes(app, cfg, sessions, accounts, new RateLimiter(cfg.security.loginPerMinute), deps.fetch);
  // Remote MCP (ChatGPT/Codex): durable compositions, OAuth, worker-thread rendering, signed artifacts.
  const mcpStore = new McpStore(persist ? join(cfg.dataDir, "mcp.sqlite") : ":memory:", persist ? cfg.dataDir : mkdtempSync(join(tmpdir(), "gbk-mcp-")));
  shareRoutes(app, cfg, sessions, shares, new RateLimiter(10), model, (token, id, owner) => {
    try { const p = resolveGuestCapability(cfg, mcpStore, token); return p.compositionId === id && p.user === owner; } catch { return false; }
  });
  const mcpService = new CompositionService(cfg, mcpStore, shares, (o) => app.log.info(o));
  const mcpRenders = new RenderService(cfg, mcpStore, (o) => app.log.info(o), (u) => limits.for(u).dailyRenders);
  // Migration from invite-code login: every access-code user and every existing song/composition owner becomes an
  // established account with the same id, so their songs, compositions and OAuth grants keep working unchanged.
  const legacy = new Set([...cfg.security.accessCodes.map((e) => { const i = e.indexOf(":"); return (i > 0 ? e.slice(0, i) : "user").replace(/[^\w.-]/g, "").slice(0, 40) || "user"; }), ...shares.owners(), ...mcpStore.owners()]);
  let migrated = 0; for (const u of legacy) if (!u.startsWith("guest:") && accounts.ensureLegacy(u)) migrated++;
  if (migrated) app.log.info({ evt: "accounts_migrated", count: migrated });
  await mcpRenders.start();
  const mcpMetrics: McpMetrics = { calls: 0, errors: 0, authFailures: 0, byTool: {} };
  const mcpHttp = mcpRoutes(app, cfg, sessions, { store: mcpStore, service: mcpService, renders: mcpRenders, metrics: mcpMetrics, log: (o) => app.log.info(o) });
  const mcp: McpHandle = { store: mcpStore, service: mcpService, renders: mcpRenders, metrics: mcpMetrics,
    close: async () => { await mcpHttp.close(); await mcpRenders.stop(); mcpStore.close(); accounts.close(); } };
  app.addHook("onClose", async () => { await mcp.close(); });
  app.server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] === "/api/agent/ws") hub.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  const sweep = setInterval(() => sessions.sweep(), 60_000); sweep.unref?.();
  app.addHook("preClose", async () => { clearInterval(sweep); for (const c of hub.wss.clients) c.terminate(); });
  return { app, hub, sessions, ledger, shares, mcp, accounts };
}
