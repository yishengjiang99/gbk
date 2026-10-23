import type { FastifyInstance } from "fastify";
import { toPublic, type Config } from "../config.ts";
export function configRoutes(app: FastifyInstance, cfg: Config) {
  app.get("/api/config", async () => toPublic(cfg));
}
