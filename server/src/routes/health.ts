import type { FastifyInstance } from "fastify";
import { llmConfigured, type Config } from "../config.ts";
/** /api/health: liveness + coarse readiness. Exposes no secrets, keys, hosts or user data. */
export function healthRoutes(app: FastifyInstance, cfg: Config, stats: () => Record<string, number>, version: string) {
  app.get("/api/health", async () => ({ ok: true, service: "gbk-composer", version, enabled: cfg.enabled, llmConfigured: llmConfigured(cfg), uptimeSec: Math.round(process.uptime()), ...stats() }));
}
