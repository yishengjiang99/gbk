// Feasibility + regression check for rendering inside the ChatGPT in-chat player (MCP Apps widget).
// Mimics the host sandbox: host page (origin H) -> <iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups ...">
// on a DIFFERENT origin (S) served with a CSP header built from the resource's declared csp (connect/resource domains),
// talking the MCP Apps postMessage bridge (ui/initialize, tools/call, ui/notifications/tool-result). The GBK server runs
// on origin A. Then: click Render, wait for the in-browser OfflineAudioContext render, play, and probe downloads + Stop.
//   node --import tsx/esm test/e2e/widget-sandbox.check.ts [chromium|webkit|webkit-iphone|all]
// Needs Node 22 (node:sqlite), Playwright browsers and a built widget (node scripts/build-widget.mjs).
// Prints a JSON report; exits 1 when the strict-CSP render fails.
import { createServer, type Server } from "node:http";
import { type AddressInfo, createServer as netServer } from "node:net";
import { chromium, webkit, devices, type Browser, type BrowserContextOptions } from "playwright";
import { buildApp } from "../../server/src/app.ts";
import { testConfig, ScriptModel, reply } from "../../server/test/helpers.ts";

const freePort = () => new Promise<number>((res) => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
const listen = (srv: Server, port: number) => new Promise<void>((res) => srv.listen(port, "127.0.0.1", () => res()));

const CSP_VARIANTS = {
  // Spec-default directives + declared domains only: no blob:, no worker-src, no 'unsafe-eval' (strictest plausible host).
  strict: (a: string) => `default-src 'none'; script-src 'self' 'unsafe-inline' ${a}; style-src 'self' 'unsafe-inline' ${a}; img-src 'self' data: ${a}; font-src 'self' data: ${a}; media-src 'self' data: ${a}; connect-src 'self' ${a}; frame-src 'none'; object-src 'none'; base-uri 'self'`,
  // The MCP Apps reference host (ext-apps examples/basic-host/serve.ts): adds blob:/data: and worker-src.
  basicHost: (a: string) => `default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${a}; style-src 'self' 'unsafe-inline' blob: data: ${a}; img-src 'self' data: blob: ${a}; font-src 'self' data: blob: ${a}; media-src 'self' data: blob: ${a}; connect-src 'self' ${a}; worker-src 'self' blob: ${a}; frame-src 'none'; object-src 'none'`,
  // Control: the same strict policy WITHOUT our declared domains - must fail (proves the harness enforces CSP).
  undeclared: (_a: string) => `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' data:; object-src 'none'`,
} as const;
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";
type P = { __gbkPlayer: { job: { worklet?: string }; pl: { mode: string; playing: boolean; ac: AudioContext | null } } };

async function main() {
  const which = process.argv[2] ?? "all";
  const [pa, ph, ps] = [await freePort(), await freePort(), await freePort()];
  const A = `http://127.0.0.1:${pa}`;
  const built = await buildApp(testConfig({ COMPOSER_PUBLIC_ORIGIN: A, MCP_TEST_AUTH: "1" }), { model: new ScriptModel([() => reply("x")]), persist: false, logger: false });
  await built.app.listen({ port: pa, host: "127.0.0.1" });
  let rpcId = 1; let session = "";
  const mcp = async (method: string, params: unknown) => {
    const r = await fetch(`${A}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-gbk-test-user": "alice", ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) });
    session ||= r.headers.get("mcp-session-id") ?? "";
    const t = await r.text(); const line = t.split("\n").find((l) => l.startsWith("data:")); return JSON.parse(line ? line.slice(5) : t);
  };
  await mcp("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "sandbox-check", version: "0" } });
  const created = (await mcp("tools/call", { name: "gbk_create_composition", arguments: { title: "Sandbox check", style: "classical", tempo: 120, bars: 4, seed: 3, instrumentation: ["piano", "violin"] } })).result.structuredContent;
  const shown = (await mcp("tools/call", { name: "gbk_show_composition_ui", arguments: { compositionId: created.compositionId } })).result.structuredContent;
  const resource = (await mcp("resources/read", { uri: "ui://gbk/composer-v2.html" })).result.contents[0];
  const declared: string[] = [...new Set([...(resource._meta.ui.csp.resourceDomains as string[]), ...(resource._meta.ui.csp.connectDomains as string[])])];

  // Host H: forwards the widget's tools/call to the MCP server (like ChatGPT does) and sends the initial tool result.
  const host = createServer(async (req, res) => {
    const u = new URL(req.url!, "http://h");
    if (u.pathname === "/mcp-proxy") {
      let body = ""; for await (const c of req) body += c;
      const { name, arguments: args } = JSON.parse(body);
      const out = await mcp("tools/call", { name, arguments: args });
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(out.result ?? { isError: true, content: [{ type: "text", text: JSON.stringify({ error: out.error }) }] })); return;
    }
    const variant = u.searchParams.get("csp") ?? "strict"; const extra = u.searchParams.get("sandbox") ?? "";
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><body style="margin:0"><iframe id="w" style="width:900px;height:900px;border:0" sandbox="${SANDBOX}${extra ? " " + extra : ""}" src="http://localhost:${ps}/widget?csp=${variant}"></iframe>
<script>
const out=${JSON.stringify(shown)}; const f=document.getElementById("w");
addEventListener("message", async (ev) => {
  const m=ev.data; if(!m||m.jsonrpc!=="2.0") return;
  const send=(x)=>f.contentWindow.postMessage(x,"*");
  if(m.method==="ui/initialize") send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2026-01-26",hostContext:{theme:"light"},hostCapabilities:{}}});
  else if(m.method==="ui/notifications/initialized") send({jsonrpc:"2.0",method:"ui/notifications/tool-result",params:{structuredContent:out}});
  else if(m.method==="tools/call"){ const r=await fetch("/mcp-proxy",{method:"POST",body:JSON.stringify(m.params)}); send({jsonrpc:"2.0",id:m.id,result:await r.json()}); }
});
</script></body>`);
  });
  // Sandbox origin S: serves the widget HTML exactly as returned by resources/read, under the host CSP.
  const sandbox = createServer((req, res) => {
    const u = new URL(req.url!, "http://s"); const variant = (u.searchParams.get("csp") ?? "strict") as keyof typeof CSP_VARIANTS;
    res.setHeader("content-security-policy", CSP_VARIANTS[variant](declared.join(" "))); res.setHeader("content-type", "text/html"); res.end(resource.text);
  });
  await listen(host, ph); await listen(sandbox, ps);

  const report: Record<string, unknown> = { declaredDomains: declared, sandboxAttr: SANDBOX };
  // "webkit-iphone" = WebKit with an iPhone 13 viewport, touch and UA (a stand-in, not a real iPhone or real ChatGPT).
  const engines: [string, () => Promise<Browser>, BrowserContextOptions][] = [["chromium", () => chromium.launch(), {}], ["webkit", () => webkit.launch(), {}],
    ["webkit-iphone", () => webkit.launch(), { ...devices["iPhone 13"] }]];
  let strictOk = true;
  for (const [name, launch, device] of engines) {
    if (which !== "all" && which !== name) continue;
    const browser = await launch();
    for (const variant of Object.keys(CSP_VARIANTS)) {
      const ctx = await browser.newContext({ ...device, acceptDownloads: true }); const page = await ctx.newPage();
      const cspViolations: string[] = [];
      page.on("console", (m) => { if (/Content Security Policy|Refused|blocked/i.test(m.text())) cspViolations.push(m.text().slice(0, 240)); });
      const t0 = Date.now(); const r: Record<string, unknown> = {};
      try {
        await page.goto(`http://127.0.0.1:${ph}/?csp=${variant}`);
        const w = page.frameLocator("#w");
        await w.locator("#renderBtn").waitFor({ state: "visible", timeout: 20_000 });
        await w.locator("#renderBtn").click();
        const frame = page.frames().find((f) => f.url().includes("/widget"))!;
        await frame.waitForFunction(() => /^(Done|Render failed|Rendered and playable|Render stopped|Render timed out|Sign in)/.test(document.getElementById("renderStatus")!.textContent || ""), null, { timeout: 300_000, polling: 500 });
        r.status = await frame.locator("#renderStatus").textContent();
        r.worklet = await frame.evaluate(() => (window as unknown as P).__gbkPlayer.job.worklet ?? null);
        r.renderSeconds = Math.round((Date.now() - t0) / 1000);
        r.playerMode = await frame.evaluate(() => (window as unknown as P).__gbkPlayer.pl.mode);
        if (!/^Done/.test(String(r.status))) throw new Error("render did not complete");
        await w.locator("#playBtn").click(); await page.waitForTimeout(1500);
        r.playback = await frame.evaluate(() => { const p = (window as unknown as P).__gbkPlayer.pl; return { playing: p.playing, audioContextState: p.ac?.state ?? null, seekValue: (document.getElementById("seek") as HTMLInputElement).value }; });
        await w.locator("#playBtn").click();
        r.wavHref = ((await frame.locator("#dlWav").getAttribute("href")) ?? "").replace(/sig=[^&]+/, "sig=…").slice(0, 100);
        const popup = ctx.waitForEvent("page", { timeout: 5000 }).then((p) => p.url().replace(/sig=[^&]+/, "sig=…").slice(0, 100)).catch(() => null);
        const dl = page.waitForEvent("download", { timeout: 5000 }).then((d) => d.suggestedFilename()).catch(() => null);
        await w.locator("#dlWav").click();
        r.downloadClick = { popup: await popup, download: await dl };
        await w.locator("#renderBtn").click(); await page.waitForTimeout(300); await w.locator("#stopBtn").click();
        await frame.waitForFunction(() => /Render stopped/.test(document.getElementById("renderStatus")!.textContent || ""), null, { timeout: 20_000 }).then(() => { r.stop = "ok"; }, () => { r.stop = "not observed"; });
      } catch (e) { r.error = (e as Error).message.split("\n")[0]; }
      r.cspViolations = [...new Set(cspViolations)].slice(0, 6);
      report[`${name}/${variant}`] = r;
      if (variant === "undeclared" && /^Done/.test(String(r.status))) strictOk = false;
      if (variant === "strict" && !/^Done/.test(String(r.status))) strictOk = false;
      await ctx.close();
    }
    await browser.close();
  }
  console.log(JSON.stringify(report, null, 2));
  host.close(); sandbox.close(); await built.app.close();
  process.exit(strictOk ? 0 : 1);
}
void main();
