import WebSocket from "ws";
import { buildApp } from "../src/app.ts";
import type { ModelClient } from "../src/agent/model-client.ts";
import { testConfig } from "./helpers.ts";
import { WorkstationController } from "../../src/workstation/controller.ts";
import { BrowserToolBridge } from "../../src/agent/browser-bridge.ts";
import type { ServerMessage } from "../src/bridge/protocol.ts";

export async function startServer(model: ModelClient, over: Record<string, string> = {}) {
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test", ...over });
  const built = await buildApp(cfg, { model, persist: false, logger: false });
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (built.app.server.address() as { port: number }).port;
  return { ...built, cfg, port, base: `http://127.0.0.1:${port}` };
}
export async function login(base: string, code: string, origin = "http://composer.test") {
  const s = await fetch(`${base}/api/session`); const csrf = (await s.json()).csrf as string;
  const r = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin, "x-gbk-csrf": csrf, cookie: `gbk_csrf=${csrf}` }, body: JSON.stringify({ code }) });
  const setc = r.headers.getSetCookie().map((c) => c.split(";")[0]);
  const body = await r.json();
  return { status: r.status, cookie: setc.join("; "), csrf: body.csrf as string, body };
}

/** A node "browser tab": real WorkstationController + BrowserToolBridge over a real WebSocket. */
export class TestTab {
  ws!: WebSocket; events: ServerMessage[] = []; sessionId = ""; c: WorkstationController; bridge: BrowserToolBridge; executed: string[] = [];
  autoRespond = true;
  constructor(c?: WorkstationController) { this.c = c ?? new WorkstationController(); this.bridge = new BrowserToolBridge(this.c); }
  open(base: string, cookie: string, origin = "http://composer.test", manifest = this.bridge.manifest): Promise<void> {
    return new Promise((ok, fail) => {
      this.ws = new WebSocket(`${base.replace("http", "ws")}/api/agent/ws`, { headers: { cookie, origin } });
      this.ws.on("unexpected-response", (_r, res) => fail(new Error(`HTTP ${res.statusCode}`)));
      this.ws.on("error", fail);
      this.ws.on("open", () => this.send({ type: "hello", protocol: 1, tabId: "t", manifest, projectId: this.c.project.id, revision: this.c.project.revision }));
      this.ws.on("message", async (raw) => {
        const m = JSON.parse(String(raw)) as ServerMessage; this.events.push(m);
        if (m.type === "session_ready") { this.sessionId = m.sessionId; ok(); }
        if (m.type === "tool_call" && this.autoRespond) { this.executed.push(m.tool); const result = await this.bridge.execute(m, this.sessionId); this.send({ type: "tool_result", sessionId: m.sessionId, runId: m.runId, callId: m.callId, result }); }
        if (m.type === "cancel_call") this.bridge.cancel(m.callId);
      });
    });
  }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  waitFor<T extends ServerMessage["type"]>(type: T, ms = 10000): Promise<Extract<ServerMessage, { type: T }>> {
    const t0 = Date.now();
    return new Promise((ok, fail) => { const iv = setInterval(() => { const e = this.events.find((x) => x.type === type); if (e) { clearInterval(iv); ok(e as never); } else if (Date.now() - t0 > ms) { clearInterval(iv); fail(new Error(`timeout waiting for ${type}: ${JSON.stringify(this.events.map((x) => x.type))}`)); } }, 10); });
  }
  close() { this.ws.close(); }
}
