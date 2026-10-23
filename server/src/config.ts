// Environment configuration. Secrets stay server-side; toPublic() is the only view that leaves the process.
export interface Config {
  publicOrigin: string; allowedOrigins: string[]; port: number; host: string; dataDir: string; enabled: boolean;
  llm: { baseUrl: string; apiKey: string; model: string; models: string[]; apiStyle: "chat_completions" | "responses"; provider: string; priceInPerMTok: number; priceOutPerMTok: number; requestTimeoutMs: number; maxRetries: number; stream: boolean; parallelToolCalls: boolean };
  agent: { maxToolSteps: number; maxConcurrentRunsPerUser: number; toolTimeoutMs: number; maxInputChars: number; maxContextTokens: number; maxOutputTokens: number; sessionIdleSeconds: number; dailyTokenBudget: number; dailyCostBudgetUsd: number; globalDailyCostBudgetUsd: number; reconnectGraceMs: number; maxToolResultChars: number };
  security: { sessionSecret: string; accessCodes: string[]; cookieSecure: boolean; loginPerMinute: number; messagesPerMinute: number; ipRequestsPerMinute: number };
}

const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) ? n : d; };
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicOrigin = (env.COMPOSER_PUBLIC_ORIGIN ?? "http://localhost:8080").replace(/\/$/, "");
  const model = env.LLM_MODEL ?? "";
  const models = [...new Set([model, ...list(env.LLM_MODELS)].filter(Boolean))];
  const secret = env.SESSION_SECRET ?? "";
  if (env.NODE_ENV === "production" && secret.length < 32) throw new Error("SESSION_SECRET must be set (>= 32 chars) in production");
  const style = env.LLM_API_STYLE ?? "chat_completions";
  if (style !== "chat_completions" && style !== "responses") throw new Error(`LLM_API_STYLE must be chat_completions or responses, got ${style}`);
  return {
    publicOrigin, allowedOrigins: [publicOrigin, ...list(env.COMPOSER_EXTRA_ORIGINS)], port: num(env.PORT, 8080), host: env.HOST ?? "127.0.0.1",
    dataDir: env.COMPOSER_DATA_DIR ?? "./composer-data", enabled: env.COMPOSER_ENABLED !== "0",
    llm: { baseUrl: (env.LLM_BASE_URL ?? "").replace(/\/$/, ""), apiKey: env.LLM_API_KEY ?? "", model, models, apiStyle: style, provider: env.LLM_PROVIDER_NAME ?? hostOf(env.LLM_BASE_URL),
      priceInPerMTok: num(env.LLM_PRICE_INPUT_PER_MTOK, 3), priceOutPerMTok: num(env.LLM_PRICE_OUTPUT_PER_MTOK, 15), requestTimeoutMs: num(env.LLM_REQUEST_TIMEOUT_MS, 120_000), maxRetries: num(env.LLM_MAX_RETRIES, 3),
      stream: env.LLM_STREAM !== "0", parallelToolCalls: env.LLM_PARALLEL_TOOL_CALLS !== "0" },
    agent: { maxToolSteps: num(env.AGENT_MAX_TOOL_STEPS, 40), maxConcurrentRunsPerUser: num(env.AGENT_MAX_CONCURRENT_RUNS_PER_USER, 1), toolTimeoutMs: num(env.AGENT_TOOL_TIMEOUT_MS, 120_000),
      maxInputChars: num(env.AGENT_MAX_INPUT_CHARS, 12_000), maxContextTokens: num(env.AGENT_MAX_CONTEXT_TOKENS, 32_000), maxOutputTokens: num(env.AGENT_MAX_OUTPUT_TOKENS, 4096),
      sessionIdleSeconds: num(env.AGENT_SESSION_IDLE_SECONDS, 1800), dailyTokenBudget: num(env.AGENT_DAILY_TOKEN_BUDGET, 2_000_000), dailyCostBudgetUsd: num(env.AGENT_DAILY_COST_BUDGET_USD, 5),
      globalDailyCostBudgetUsd: num(env.AGENT_GLOBAL_DAILY_COST_BUDGET_USD, 20), reconnectGraceMs: num(env.AGENT_RECONNECT_GRACE_MS, 30_000), maxToolResultChars: num(env.AGENT_MAX_TOOL_RESULT_CHARS, 12_000) },
    security: { sessionSecret: secret || "dev-only-insecure-secret-change-me-please!!", accessCodes: list(env.COMPOSER_ACCESS_CODES), cookieSecure: publicOrigin.startsWith("https://"),
      loginPerMinute: num(env.RATE_LOGIN_PER_MINUTE, 10), messagesPerMinute: num(env.RATE_MESSAGES_PER_MINUTE, 6), ipRequestsPerMinute: num(env.RATE_IP_PER_MINUTE, 120) },
  };
}
function hostOf(u?: string) { try { return u ? new URL(u).host : "unconfigured"; } catch { return "invalid"; } }

export const llmConfigured = (c: Config) => !!(c.llm.baseUrl && c.llm.apiKey && c.llm.model);
export function toPublic(c: Config) {
  return { enabled: c.enabled, provider: c.llm.provider, model: c.llm.model, models: c.llm.models, apiStyle: c.llm.apiStyle, llmConfigured: llmConfigured(c), authRequired: true,
    limits: { maxToolSteps: c.agent.maxToolSteps, maxInputChars: c.agent.maxInputChars, maxOutputTokens: c.agent.maxOutputTokens, dailyTokenBudget: c.agent.dailyTokenBudget, dailyCostBudgetUsd: c.agent.dailyCostBudgetUsd, toolTimeoutMs: c.agent.toolTimeoutMs } };
}
