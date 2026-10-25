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
import { pricingRoutes, WaitlistStore } from "./routes/pricing.ts";
import { pageRoutes, openaiChallengeRoute } from "./routes/pages.ts";
import { reviewerRoutes } from "./routes/reviewer.ts";
import { configRoutes } from "./routes/config.ts";
import { agentRoutes } from "./routes/agent.ts";
import { shareRoutes } from "./routes/shares.ts";
import { clientErrorRoutes } from "./routes/client-errors.ts";
import { ClientErrorStore } from "./persistence/client-errors.ts";
import { FunnelStore } from "./persistence/funnel.ts";
import { funnelRoutes } from "./routes/funnel.ts";
import { galleryRoutes } from "./routes/gallery.ts";
import { McpStore } from "./mcp/store.ts";
import { CompositionService } from "./mcp/service.ts";
import { RenderService, resolveSoundFontPath } from "./mcp/browser-render.ts";
import { ServerRenderPool } from "./mcp/server-render.ts";
import { mcpRoutes } from "./mcp/routes.ts";
import { SocialStore } from "./persistence/social.ts";
import { NativeStore } from "./persistence/native.ts";
import { createNotifier } from "./push/notifier.ts";
import type { ApnsSender } from "./push/apns.ts";
import { nativeRoutes } from "./routes/native.ts";
import { currentSession } from "./routes/agent.ts";
import { authExtraRoutes } from "./routes/auth-extra.ts";
import { socialRoutes } from "./routes/social.ts";
import { eventRoutes } from "./routes/events.ts";
import { EventStore } from "./persistence/events.ts";
import { Ranker } from "./ranking/ranker.ts";
import { isGuest, resolveGuestCapability } from "./mcp/guest.ts";
import type { McpMetrics } from "./mcp/server.ts";

export const VERSION = process.env.GBK_COMPOSER_VERSION ?? "dev";

export interface AppDeps { model?: ModelClient; persist?: boolean; logger?: boolean | object; fetch?: typeof fetch; now?: () => number; apns?: ApnsSender }
export interface McpHandle { store: McpStore; service: CompositionService; renders: RenderService; metrics: McpMetrics; close: () => Promise<void> }
export async function buildApp(cfg: Config, deps: AppDeps = {}): Promise<{ app: FastifyInstance; hub: AgentHub; sessions: SessionStore; ledger: UsageLedger; shares: ShareStore; mcp: McpHandle; accounts: AccountStore; clientErrors: ClientErrorStore }> {
  const app = Fastify({ logger: deps.logger ?? { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.cookie", "req.headers.authorization", "req.headers[\"x-gbk-project-token\"]", "req.headers[\"x-gbk-csrf\"]"] }, bodyLimit: 64 * 1024, trustProxy: "127.0.0.1", disableRequestLogging: false });
  const sessions = new SessionStore(cfg, deps.now, deps.persist !== false ? join(cfg.dataDir, "sessions.sqlite") : ":memory:");
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
    // MCP + OAuth discovery are exempt from the per-IP limiter: hosted MCP clients share egress IPs and
    // poll render status legitimately; abuse is bounded per authenticated user (render quotas, job caps).
    if (req.url.startsWith("/mcp") || req.url.startsWith("/.well-known/") || req.url.startsWith("/oauth/") || req.url.startsWith("/api/mcp/")) return;
    if (!ipLimiter.take(req.ip)) return reply.code(429).header("retry-after", String(ipLimiter.retryAfterSec(req.ip))).send({ code: "RATE_LIMITED", message: "too many requests" });
  });
  app.addHook("onSend", async (_req, reply, payload) => { reply.header("x-content-type-options", "nosniff"); if (!reply.getHeader("cache-control")) reply.header("cache-control", "no-store"); return payload; });
  healthRoutes(app, cfg, () => ({ connections: hub.registry.size, activeRuns: hub.activeRuns }), VERSION);
  configRoutes(app, cfg);
  const funnel = new FunnelStore(persist ? join(cfg.dataDir, "analytics.sqlite") : ":memory:");
  pageRoutes(app, cfg, funnel);
  const proWaitlist = new WaitlistStore(persist ? join(cfg.dataDir, "pro-waitlist.sqlite") : ":memory:");
  pricingRoutes(app, cfg, sessions, accounts, proWaitlist);
  funnelRoutes(app, cfg, sessions, funnel);
  galleryRoutes(app, cfg, funnel);
  openaiChallengeRoute(app, cfg.openaiAppsChallenge);
  agentRoutes(app, cfg, sessions, new RateLimiter(cfg.security.loginPerMinute), accounts, limits, ledger);
  reviewerRoutes(app, cfg, sessions, accounts);
  signinRoutes(app, cfg, sessions, accounts, new RateLimiter(cfg.security.loginPerMinute), deps.fetch);
  const clientErrors = new ClientErrorStore(persistEarly ? join(cfg.dataDir, "accounts.sqlite") : ":memory:");
  clientErrorRoutes(app, cfg, sessions, clientErrors);
  // Remote MCP (ChatGPT/Codex): durable compositions, OAuth, Studio-tab rendering, signed artifacts.
  const mcpStore = new McpStore(persist ? join(cfg.dataDir, "mcp.sqlite") : ":memory:", persist ? cfg.dataDir : mkdtempSync(join(tmpdir(), "gbk-mcp-")));
  // Private Studio links for account-free MCP projects carry the read capability (sent as x-gbk-project-token).
  shareRoutes(app, cfg, sessions, shares, new RateLimiter(cfg.security.sharesPerMinute), model, (token, projectId, owner) => {
    try { const g = resolveGuestCapability(cfg, mcpStore, token); return g.compositionId === projectId && g.user === owner; } catch { return false; }
  }, (id) => {
    social.markPublished(id);
    const r = shares.byId(id); const parent = r?.parent_id ? shares.byId(r.parent_id) : null;
    if (r && parent && parent.owner !== r.owner && !isGuest(r.owner)) notify(parent.owner, { kind: "fork", title: `${social.ensureProfile(r.owner, accounts.get(r.owner)?.name ?? r.owner).display_name} remixed ${parent.title}`, body: r.title, link: `${cfg.publicOrigin}/s/${r.slug}` });
  });
  const social = new SocialStore(shares.database, deps.now);
  const native = new NativeStore(persist ? join(cfg.dataDir, "native.sqlite") : ":memory:", deps.now);
  const notify = createNotifier(cfg, native, (o) => app.log.info(o), deps.apns);
  const events = new EventStore(shares.database, deps.now);
  const ranker = new Ranker(shares.database, deps.now);
  const socialApi = socialRoutes(app, cfg, sessions, shares, accounts, social, notify, ranker);
  eventRoutes(app, cfg, sessions, shares, events, cfg.adminUsers);
  // P3: suggested prompt for opt-in prompt sharing = the owner's first AI Composer prompt (owner edits before sharing).
  app.get("/api/songs/:slug/prompt-suggestion", async (req, reply) => {
    const s = currentSession(req, sessions); const row = shares.bySlug((req.params as { slug: string }).slug);
    if (!s || !row || row.owner !== s.user) return reply.code(404).send({ code: "NOT_FOUND", message: "no such song of yours" });
    const c = convs.get(s.user); const first = c.messages.find((m) => m.role === "user");
    const text = typeof first?.content === "string" ? first.content : Array.isArray(first?.content) ? (first!.content as { text?: string }[]).map((x) => x.text ?? "").join(" ") : "";
    return { prompt: text.trim().slice(0, 4000) || null, sameProject: !!row.project_id && c.projectId === row.project_id };
  });
  // Unknown /api routes: Fastify's {message,error,statusCode} plus our `code` so clients can rely on one shape.
  app.all("/api/*", async (req, reply) => reply.code(404).send({ code: "NOT_FOUND", message: `Route ${req.method}:${req.url.split("?")[0]} not found`, error: "Not Found", statusCode: 404 }));
  const nativeApi = nativeRoutes(app, cfg, { sessions, accounts, native, shares, social, me: socialApi.me, fetch: deps.fetch });
  authExtraRoutes(app, cfg, { sessions, accounts, pair: nativeApi.pair, fetch: deps.fetch });
  // Nightly (03:30 server time) retrain of the pointwise ranking model; no-op until enough impressions exist.
  const trainTimer = setInterval(() => { const d = new Date(); if (d.getHours() === 3 && d.getMinutes() >= 30 && d.getMinutes() < 40) { try { events.prune(); const r = ranker.train(); if (r) app.log.info({ evt: "rank_train", version: r.version, n: r.n, auc: r.auc }); } catch (e) { app.log.warn({ evt: "rank_train_error", message: (e as Error).message }); } } }, 600_000); trainTimer.unref();
  const rescoreTimer = setInterval(() => { try { social.rescoreAll(); } catch { /* best effort */ } }, 600_000); rescoreTimer.unref();
  const mcpService = new CompositionService(cfg, mcpStore, shares, (o) => app.log.info(o));
  // MCP renders run in the user's connected Studio tab or the in-chat player; with no tab (Codex, guests, headless
  // clients) they run on the server in worker threads (SERVER_RENDER=0 turns that off).
  const serverPool = new ServerRenderPool(cfg, () => resolveSoundFontPath(cfg), (o) => app.log.info(o));
  const mcpRenders = new RenderService(cfg, mcpStore, (u) => hub.registry.get(u), (o) => { const e = o as { evt?: string; executor?: string }; if (e.evt === "mcp_render_completed") { if (e.executor === "server") funnel.bump("server_render_completed", "server"); else funnel.bump("browser_render_completed", e.executor === "widget" ? "widget" : "studio-tab"); } if (e.evt === "mcp_render_failed") funnel.bump("render_failed"); app.log.info(o); }, (u) => limits.for(u).dailyRenders, serverPool);
  // Migration from invite-code login: every access-code user and every existing song/composition owner becomes an
  // established account with the same id, so their songs, compositions and OAuth grants keep working unchanged.
  const legacy = new Set([...cfg.security.accessCodes.map((e) => { const i = e.indexOf(":"); return (i > 0 ? e.slice(0, i) : "user").replace(/[^\w.-]/g, "").slice(0, 40) || "user"; }), ...shares.owners(), ...mcpStore.owners()]);
  let migrated = 0; for (const u of legacy) if (!isGuest(u) && accounts.ensureLegacy(u)) migrated++;
  if (migrated) app.log.info({ evt: "accounts_migrated", count: migrated });
  await mcpRenders.start();
  if (process.env.NODE_ENV === "production") void serverPool.start(); // warm the workers + SoundFont at boot
  // Artifact expiry: bytes + rows past MCP_ARTIFACT_RETENTION_DAYS are deleted at startup and hourly.
  const prune = () => { try { const n = mcpStore.pruneArtifacts(cfg.mcp.artifactRetentionDays); if (n) app.log.info({ evt: "mcp_artifacts_pruned", count: n }); } catch (e) { app.log.warn({ evt: "mcp_artifact_prune_failed", message: (e as Error).message }); } };
  prune(); const pruneTimer = setInterval(prune, 3_600_000); pruneTimer.unref();
  const mcpMetrics: McpMetrics = { calls: 0, errors: 0, authFailures: 0, byTool: {} };
  const mcpHttp = mcpRoutes(app, cfg, sessions, { store: mcpStore, service: mcpService, renders: mcpRenders, metrics: mcpMetrics, funnel, log: (o) => app.log.info(o) });
  const mcp: McpHandle = { store: mcpStore, service: mcpService, renders: mcpRenders, metrics: mcpMetrics,
    close: async () => { clearInterval(pruneTimer); clearInterval(rescoreTimer); native.close(); await mcpHttp.close(); await mcpRenders.stop(); await serverPool.stop(); mcpStore.close(); accounts.close(); clientErrors.close(); funnel.close(); proWaitlist.close(); sessions.close(); } };
  app.addHook("onClose", async () => { await mcp.close(); });
  app.server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] === "/api/agent/ws") hub.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  const sweepSessions = () => { try { sessions.sweep(); } catch (e) { app.log.warn({ evt: "session_sweep_failed", message: (e as Error).message }); } };
  sweepSessions(); const sweep = setInterval(sweepSessions, 3_600_000); sweep.unref?.();
  app.addHook("preClose", async () => { clearInterval(sweep); for (const c of hub.wss.clients) c.terminate(); });
  return { app, hub, sessions, ledger, shares, mcp, accounts, clientErrors };
}
