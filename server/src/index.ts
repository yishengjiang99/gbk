// GBK Composer agent API entry point. Listens on 127.0.0.1 only: reachable solely through the nginx proxy.
import { loadConfig } from "./config.ts";
import { buildApp } from "./app.ts";

const cfg = loadConfig();
const { app } = await buildApp(cfg);
await app.listen({ port: cfg.port, host: cfg.host });
app.log.info({ evt: "started", port: cfg.port, host: cfg.host, origin: cfg.publicOrigin, model: cfg.llm.model, provider: cfg.llm.provider, enabled: cfg.enabled, accessCodes: cfg.security.accessCodes.length });
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { void app.close().then(() => process.exit(0)); });
