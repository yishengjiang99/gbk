import { readFileSync } from "node:fs";
// Environment configuration. Secrets stay server-side; toPublic() is the only view that leaves the process.
export interface Config {
  publicOrigin: string; allowedOrigins: string[];
  /** Account ids allowed to read admin endpoints (GET /api/admin/client-errors). COMPOSER_ADMIN_USERS, comma-separated. */
  adminUsers: string[]; port: number; host: string; dataDir: string; enabled: boolean;
  /** Public ChatGPT plugin listing URL. Unset = the /chatgpt page shows "coming soon" instead of an install button. */
  chatgptPluginUrl: string;
  /** OpenAI plugin portal domain-verification token served at /.well-known/openai-apps-challenge (OPENAI_APPS_CHALLENGE). */
  openaiAppsChallenge: string;
  llm: { baseUrl: string; apiKey: string; model: string; models: string[]; apiStyle: "chat_completions" | "responses"; provider: string; priceInPerMTok: number; priceOutPerMTok: number; /** #163 #12: cached prompt tokens are priced at this rate when the provider reports them. */
    priceCachedInPerMTok: number; requestTimeoutMs: number; maxRetries: number; stream: boolean; parallelToolCalls: boolean };
  agent: { maxToolSteps: number; maxConcurrentRunsPerUser: number; toolTimeoutMs: number; renderTimeoutMs: number; maxInputChars: number; maxContextTokens: number; maxOutputTokens: number; dailyTokenBudget: number; newAccountDailyTokenBudget: number; dailyCostBudgetUsd: number; globalDailyCostBudgetUsd: number; reconnectGraceMs: number; maxToolResultChars: number };
  security: { sessionSecret: string; accessCodes: string[]; cookieSecure: boolean; loginPerMinute: number; messagesPerMinute: number; ipRequestsPerMinute: number; sharesPerMinute: number };
  /** Sign-in. A provider is offered only when both its client id and secret are set. */
  /** Native iOS client: Sign in with Apple, Google ID tokens, APNs, universal links. All optional; unset = feature answers 503/404. */
  /** Web Sign in with Apple (Services ID) and SMS sign-in (Twilio Verify + Turnstile). Unset = 503. */
  signin2: { appleServicesId: string; twilio: { accountSid: string; user: string; secret: string; verifySid: string } | null; turnstileSecret: string; turnstileSiteKey: string; smsPrefixes: string[] };
  /** Apple IAP: sandbox/Xcode transactions accepted only when allowSandbox (default: on outside production). */
  iap: { bundleId: string; allowSandbox: boolean };
  /** Stripe (web) Pro entitlement lookup on grepawk.com. Empty token = Stripe Pro off (Apple only). */
  stripe: { entitlementOrigin: string; entitlementToken: string };
  /** Billing funnel telemetry (#118): shared token for the finalcut -> composer event hop
   * (POST /api/billing/stripe-events). Empty = the hop is disabled (404). */
  billing: { webhookToken: string };
  native: { appleBundleId: string; googleClientIds: string[]; iosAppIds: string[]; apns: { keyId: string; teamId: string; privateKey: string; topic: string } };
  auth: { github: { clientId: string; clientSecret: string } | null; google: { clientId: string; clientSecret: string } | null; newAccountDays: number;
    /** OpenAI app-review login (one account, openai-reviewer). Off unless REVIEWER_LOGIN_ENABLED=1 and REVIEWER_PASSWORD_HASH are set. */
    reviewer: { enabled: boolean; passwordHash: string } };
  mcp: {
    enabled: boolean;
    /** Local test auth (x-gbk-test-user header / Bearer test:<user>). Refused outright in production. */
    testAuth: boolean;
    /** Absolute path to the bundled .sf2 (preset/instrument metadata and the headless server renderer). Empty = auto-detect. */
    soundFontPath: string;
    renderTimeoutMs: number; maxRenderSeconds: number;
    /** Per-user caps that bound render cost. */
    maxRendersPerDay: number; newAccountRendersPerDay: number; maxCompositions: number;
    /** Signed artifact download URLs live this long (seconds). */
    artifactUrlTtlSec: number; artifactRetentionDays: number;
    /** Tier limits for signed-in accounts (#132; guests keep the guest* caps): revision snapshots
     * kept per composition, render-file retention for Pro owners, max composition length in bars. */
    tierFreeRevisions: number; tierProRevisions: number; tierProArtifactRetentionDays: number;
    tierFreeMaxBars: number; tierProMaxBars: number;
    /** Hosts allowed to act as CIMD client_id documents (SSRF guard). */
    cimdHosts: string[];
    accessTokenTtlSec: number; refreshTokenTtlSec: number; authCodeTtlSec: number; consentTtlSec: number;
    /** Account-free MCP projects (MCP_GUEST=0 is the off switch: then every private tool needs OAuth again). */
    guestEnabled: boolean;
    guestMaxSeconds: number; guestMaxBars: number; guestMaxEvents: number; guestMaxRevisions: number;
    /** MIDI exports / browser-render handoffs per guest project per rolling day. */
    guestRendersPerDay: number;
    /** Durable global rolling-24h budgets: new sessions/IPs/projects cannot reset them. */
    guestCreatesPerDay: number; guestMutationsPerDay: number;
    guestMaxCompositions: number; guestMaxStorageBytes: number; guestMaxProjectBytes: number; guestProjectTtlDays: number; guestArtifactRetentionDays: number;
    /** Per-IP throttle for anonymous tool calls (supplements the global budgets; IP is never an identity). */
    guestCallsPerMinute: number;
    /** Per-client creation cap (rolling 24h, keyed by a salted hash of the client IP), far below the global cap. */
    guestCreatesPerClientPerDay: number;
  };
  /** Headless server-side rendering for MCP clients without a Studio tab. SERVER_RENDER=0 turns it off. */
  serverRender: { enabled: boolean; concurrency: number; maxQueue: number; timeoutMs: number; workerHeapMb: number;
    guestMaxSeconds: number; accountMaxSeconds: number; guestPerHour: number; accountPerHour: number; proPerHour: number; proMaxSeconds: number; guestPerClientPerDay: number };
}

const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) ? n : d; };
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicOrigin = (env.COMPOSER_PUBLIC_ORIGIN ?? "http://localhost:8080").replace(/\/$/, "");
  const model = env.LLM_MODEL ?? "";
  const models = [...new Set([model, ...list(env.LLM_MODELS)].filter(Boolean))];
  const secret = env.SESSION_SECRET ?? "";
  if (env.NODE_ENV === "production" && secret.length < 32) throw new Error("SESSION_SECRET must be set (>= 32 chars) in production");
  if (env.NODE_ENV === "production" && env.MCP_TEST_AUTH === "1") throw new Error("MCP_TEST_AUTH=1 is forbidden in production (test authentication must fail closed)");
  const style = env.LLM_API_STYLE ?? "chat_completions";
  if (style !== "chat_completions" && style !== "responses") throw new Error(`LLM_API_STYLE must be chat_completions or responses, got ${style}`);
  return {
    publicOrigin, allowedOrigins: [publicOrigin, ...list(env.COMPOSER_EXTRA_ORIGINS)], adminUsers: list(env.COMPOSER_ADMIN_USERS), port: num(env.PORT, 8080), host: env.HOST ?? "127.0.0.1",
    dataDir: env.COMPOSER_DATA_DIR ?? "./composer-data", enabled: env.COMPOSER_ENABLED !== "0", chatgptPluginUrl: (env.CHATGPT_PLUGIN_URL ?? "").trim(), openaiAppsChallenge: (env.OPENAI_APPS_CHALLENGE ?? "").trim(),
    llm: { baseUrl: (env.LLM_BASE_URL ?? "").replace(/\/$/, ""), apiKey: env.LLM_API_KEY ?? "", model, models, apiStyle: style, provider: env.LLM_PROVIDER_NAME ?? hostOf(env.LLM_BASE_URL),
      priceInPerMTok: num(env.LLM_PRICE_INPUT_PER_MTOK, 3), priceOutPerMTok: num(env.LLM_PRICE_OUTPUT_PER_MTOK, 15),
      priceCachedInPerMTok: num(env.LLM_PRICE_CACHED_INPUT_PER_MTOK, num(env.LLM_PRICE_INPUT_PER_MTOK, 3) / 2), requestTimeoutMs: num(env.LLM_REQUEST_TIMEOUT_MS, 120_000), maxRetries: num(env.LLM_MAX_RETRIES, 3),
      stream: env.LLM_STREAM !== "0", parallelToolCalls: env.LLM_PARALLEL_TOOL_CALLS !== "0" },
    agent: { maxToolSteps: num(env.AGENT_MAX_TOOL_STEPS, 40), maxConcurrentRunsPerUser: num(env.AGENT_MAX_CONCURRENT_RUNS_PER_USER, 1), toolTimeoutMs: num(env.AGENT_TOOL_TIMEOUT_MS, 120_000), renderTimeoutMs: num(env.AGENT_RENDER_TIMEOUT_MS, 660_000),
      maxInputChars: num(env.AGENT_MAX_INPUT_CHARS, 12_000), maxContextTokens: num(env.AGENT_MAX_CONTEXT_TOKENS, 32_000), maxOutputTokens: num(env.AGENT_MAX_OUTPUT_TOKENS, 4096),
      dailyTokenBudget: num(env.AGENT_DAILY_TOKEN_BUDGET, 2_000_000), newAccountDailyTokenBudget: num(env.AGENT_NEW_ACCOUNT_DAILY_TOKEN_BUDGET, 200_000), dailyCostBudgetUsd: num(env.AGENT_DAILY_COST_BUDGET_USD, 5),
      globalDailyCostBudgetUsd: num(env.AGENT_GLOBAL_DAILY_COST_BUDGET_USD, 20), reconnectGraceMs: num(env.AGENT_RECONNECT_GRACE_MS, 300_000), maxToolResultChars: num(env.AGENT_MAX_TOOL_RESULT_CHARS, 12_000) },
    security: { sessionSecret: secret || "dev-only-insecure-secret-change-me-please!!", accessCodes: list(env.COMPOSER_ACCESS_CODES), cookieSecure: publicOrigin.startsWith("https://"),
      loginPerMinute: num(env.RATE_LOGIN_PER_MINUTE, 10), messagesPerMinute: num(env.RATE_MESSAGES_PER_MINUTE, 6), ipRequestsPerMinute: num(env.RATE_IP_PER_MINUTE, 120), sharesPerMinute: num(env.RATE_SHARES_PER_MINUTE, 10) },
    signin2: {
      appleServicesId: (env.APPLE_SERVICES_ID ?? "").trim(),
      twilio: env.TWILIO_ACCOUNT_SID && env.TWILIO_VERIFY_SID && (env.TWILIO_AUTH_TOKEN || (env.TWILIO_API_KEY && env.TWILIO_API_SECRET))
        ? { accountSid: env.TWILIO_ACCOUNT_SID, verifySid: env.TWILIO_VERIFY_SID, user: env.TWILIO_API_KEY || env.TWILIO_ACCOUNT_SID, secret: env.TWILIO_API_SECRET || env.TWILIO_AUTH_TOKEN || "" } : null,
      turnstileSecret: (env.TURNSTILE_SECRET ?? "").trim(), turnstileSiteKey: (env.TURNSTILE_SITE_KEY ?? "").trim(),
      smsPrefixes: env.SMS_COUNTRY_PREFIXES ? list(env.SMS_COUNTRY_PREFIXES) : ["+1"],
    },
    iap: { bundleId: (env.IAP_BUNDLE_ID ?? "com.grepawk.moviefone").trim(), allowSandbox: env.IAP_ALLOW_SANDBOX === undefined ? env.NODE_ENV !== "production" : env.IAP_ALLOW_SANDBOX === "1" },
    stripe: { entitlementOrigin: (env.COMPOSE_ENTITLEMENT_ORIGIN ?? "https://grepawk.com").trim().replace(/\/$/, ""), entitlementToken: (env.COMPOSE_ENTITLEMENT_TOKEN ?? "").trim() },
    billing: { webhookToken: (env.COMPOSE_BILLING_WEBHOOK_TOKEN ?? "").trim() },
    native: {
      // iOS bundle id: Sign in with Apple client id (id_token aud) and APNs topic. Set APPLE_BUNDLE_ID="" to disable.
      appleBundleId: (env.APPLE_BUNDLE_ID ?? "com.grepawk.moviefone").trim(),
      googleClientIds: list(env.GOOGLE_IOS_CLIENT_IDS),
      iosAppIds: env.IOS_APP_IDS === undefined ? ["83D36RPMUM.com.grepawk.moviefone"] : list(env.IOS_APP_IDS),
      apns: { keyId: (env.APNS_KEY_ID ?? "").trim(), teamId: (env.APNS_TEAM_ID ?? "").trim(), privateKey: apnsKey(env), topic: (env.APNS_TOPIC ?? env.APPLE_BUNDLE_ID ?? "com.grepawk.moviefone").trim() },
    },
    auth: {
      github: env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } : null,
      google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : null,
      newAccountDays: num(env.ACCOUNT_NEW_DAYS, 7),
      reviewer: { enabled: env.REVIEWER_LOGIN_ENABLED === "1", passwordHash: (env.REVIEWER_PASSWORD_HASH ?? "").trim() },
    },
    mcp: {
      enabled: env.MCP_ENABLED !== "0",
      testAuth: env.MCP_TEST_AUTH === "1",
      soundFontPath: env.GBK_SOUNDFONT_PATH ?? "",
      renderTimeoutMs: num(env.MCP_RENDER_TIMEOUT_MS, 300_000),
      maxRenderSeconds: num(env.MCP_MAX_RENDER_SECONDS, 600),
      maxRendersPerDay: num(env.MCP_MAX_RENDERS_PER_DAY, 200),
      newAccountRendersPerDay: num(env.MCP_NEW_ACCOUNT_RENDERS_PER_DAY, 10),
      maxCompositions: num(env.MCP_MAX_COMPOSITIONS_PER_USER, 500),
      artifactUrlTtlSec: num(env.MCP_ARTIFACT_URL_TTL_SEC, 900),
      artifactRetentionDays: num(env.MCP_ARTIFACT_RETENTION_DAYS, 30),
      tierFreeRevisions: Math.max(1, Math.floor(num(env.TIER_FREE_REVISIONS, 10))),
      tierProRevisions: Math.max(1, Math.floor(num(env.TIER_PRO_REVISIONS, 100))),
      tierProArtifactRetentionDays: Math.max(1, Math.floor(num(env.TIER_PRO_ARTIFACT_RETENTION_DAYS, 365))),
      tierFreeMaxBars: Math.max(1, Math.floor(num(env.TIER_FREE_MAX_BARS, 64))),
      tierProMaxBars: Math.max(1, Math.floor(num(env.TIER_PRO_MAX_BARS, 256))),
      cimdHosts: list(env.MCP_OAUTH_CIMD_HOSTS).length ? list(env.MCP_OAUTH_CIMD_HOSTS) : ["chatgpt.com"],
      accessTokenTtlSec: num(env.MCP_ACCESS_TOKEN_TTL_SEC, 3600),
      refreshTokenTtlSec: num(env.MCP_REFRESH_TOKEN_TTL_SEC, 30 * 86400),
      authCodeTtlSec: num(env.MCP_AUTH_CODE_TTL_SEC, 600),
      consentTtlSec: num(env.MCP_CONSENT_TTL_SEC, 600),
      guestEnabled: env.MCP_GUEST !== "0",
      guestMaxSeconds: Math.max(1, num(env.MCP_GUEST_MAX_SECONDS, 180)),
      guestMaxBars: Math.max(1, Math.floor(num(env.MCP_GUEST_MAX_BARS, 64))),
      guestMaxEvents: Math.max(1, Math.floor(num(env.MCP_GUEST_MAX_EVENTS, 20000))),
      guestMaxRevisions: Math.max(1, Math.floor(num(env.MCP_GUEST_MAX_REVISIONS, 100))),
      guestRendersPerDay: Math.max(1, Math.floor(num(env.MCP_GUEST_RENDERS_PER_DAY, 20))),
      guestCreatesPerDay: Math.max(1, Math.floor(num(env.MCP_GUEST_CREATES_PER_DAY, 200))),
      guestMutationsPerDay: Math.max(1, Math.floor(num(env.MCP_GUEST_MUTATIONS_PER_DAY, 2000))),
      guestMaxCompositions: Math.max(1, Math.floor(num(env.MCP_GUEST_MAX_COMPOSITIONS, 2000))),
      guestMaxStorageBytes: Math.max(1, num(env.MCP_GUEST_MAX_STORAGE_BYTES, 256 * 1024 ** 2)), // all guests: project data only
      guestMaxProjectBytes: Math.max(1, num(env.MCP_GUEST_MAX_PROJECT_BYTES, 64 * 1024 ** 2)), // one guest project incl. its renders
      guestProjectTtlDays: Math.max(1, num(env.MCP_GUEST_PROJECT_TTL_DAYS, 14)),
      guestArtifactRetentionDays: Math.max(1, num(env.MCP_GUEST_ARTIFACT_RETENTION_DAYS, 7)),
      guestCallsPerMinute: Math.max(1, Math.floor(num(env.MCP_GUEST_CALLS_PER_MINUTE, 60))),
      guestCreatesPerClientPerDay: Math.max(1, Math.floor(num(env.MCP_GUEST_CREATES_PER_CLIENT_PER_DAY, 20))),
    },
    serverRender: {
      enabled: env.SERVER_RENDER !== "0",
      concurrency: Math.max(1, Math.floor(num(env.SERVER_RENDER_CONCURRENCY, 1))),
      maxQueue: Math.max(0, Math.floor(num(env.SERVER_RENDER_MAX_QUEUE, 8))),
      timeoutMs: Math.max(1000, num(env.SERVER_RENDER_TIMEOUT_MS, 180_000)),
      workerHeapMb: Math.max(64, num(env.SERVER_RENDER_WORKER_HEAP_MB, 768)),
      guestMaxSeconds: Math.max(1, num(env.SERVER_RENDER_GUEST_MAX_SECONDS, 180)),
      accountMaxSeconds: Math.max(1, num(env.SERVER_RENDER_ACCOUNT_MAX_SECONDS, 300)),
      guestPerHour: Math.max(1, Math.floor(num(env.SERVER_RENDER_GUEST_PER_HOUR, 6))),
      accountPerHour: Math.max(1, Math.floor(num(env.SERVER_RENDER_ACCOUNT_PER_HOUR, 30))),
      proPerHour: Math.max(1, Math.floor(num(env.SERVER_RENDER_PRO_PER_HOUR, 120))),
      proMaxSeconds: Math.max(1, num(env.SERVER_RENDER_PRO_MAX_SECONDS, 600)),
      guestPerClientPerDay: Math.max(1, Math.floor(num(env.SERVER_RENDER_GUEST_PER_CLIENT_PER_DAY, 30))),
    },
  };
}
function hostOf(u?: string) { try { return u ? new URL(u).host : "unconfigured"; } catch { return "invalid"; } }

export const llmConfigured = (c: Config) => !!(c.llm.baseUrl && c.llm.apiKey && c.llm.model);
export function toPublic(c: Config) {
  return { enabled: c.enabled, provider: c.llm.provider, model: c.llm.model, models: c.llm.models, apiStyle: c.llm.apiStyle, llmConfigured: llmConfigured(c), authRequired: true, authProviders: authProviders(c),
    limits: { maxToolSteps: c.agent.maxToolSteps, maxInputChars: c.agent.maxInputChars, maxOutputTokens: c.agent.maxOutputTokens, dailyTokenBudget: c.agent.dailyTokenBudget, dailyCostBudgetUsd: c.agent.dailyCostBudgetUsd, toolTimeoutMs: c.agent.toolTimeoutMs } };
}
export const authProviders = (c: Config) => [...(c.auth.github ? ["github" as const] : []), ...(c.auth.google ? ["google" as const] : [])];

/** APNs .p8 from APNS_P8 (PEM text, \n escapes allowed) or APNS_P8_PATH. Never logged. */
function apnsKey(env: Record<string, string | undefined>): string {
  if (env.APNS_P8) return env.APNS_P8.replace(/\\n/g, "\n");
  if (env.APNS_P8_PATH) { try { return readFileSync(env.APNS_P8_PATH, "utf8"); } catch { return ""; } }
  return "";
}
