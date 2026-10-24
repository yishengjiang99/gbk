#!/usr/bin/env node
// Plugin discovery eval: does a tool-calling model pick GBK's tools for the right prompts?
//
// 1. Fetches the LIVE tool list from the MCP server (initialize + tools/list; anonymous, no secrets).
// 2. For each fixture in test/fixtures/plugin-discovery/*.json, asks an OpenAI-compatible chat model (the
//    server's xAI config: LLM_BASE_URL / LLM_API_KEY / LLM_MODEL from the environment) with the GBK tools plus
//    a few generic distractor tools, tool_choice "auto", and records the first tool it calls (or none).
//    Nothing is executed: tool calls are only recorded.
// 3. Scores with score.ts and writes a JSON + Markdown report.
//
// Budget-capped: stops before estimated spend exceeds EVAL_MAX_USD (default 1.00) using
// LLM_PRICE_INPUT_PER_MTOK / LLM_PRICE_OUTPUT_PER_MTOK. The API key is read from the environment only and is
// never printed or written to the report. Owner usage, on the server (key stays there):
//   set -a; . /etc/gbk-composer.env; set +a; node plugin-discovery-eval.mjs --fixtures DIR --out DIR
// or locally:  LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=... npm run eval:discovery
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { summarize, type Fixture, type Outcome } from "./score.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const MCP = opt("mcp", process.env.EVAL_MCP_URL ?? "https://compose.grepawk.com/mcp");
const FIX = opt("fixtures", "test/fixtures/plugin-discovery");
const OUT = opt("out", "docs/evals");
const LIMIT = Number(opt("limit", "1000"));
const base = (process.env.LLM_BASE_URL ?? "").replace(/\/$/, ""), key = process.env.LLM_API_KEY ?? "";
const model = opt("model", process.env.EVAL_MODEL ?? process.env.LLM_MODEL ?? "");
const maxUsd = Number(process.env.EVAL_MAX_USD ?? 1);
const pIn = Number(process.env.LLM_PRICE_INPUT_PER_MTOK ?? 3), pOut = Number(process.env.LLM_PRICE_OUTPUT_PER_MTOK ?? 15);
if (!base || !key || !model) { console.error("set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL (e.g. source /etc/gbk-composer.env)"); process.exit(2); }

async function liveTools() {
  const h: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const post = async (body: unknown) => {
    const r = await fetch(MCP, { method: "POST", headers: h, body: JSON.stringify(body) });
    const sid = r.headers.get("mcp-session-id"); if (sid) { h["mcp-session-id"] = sid; h["mcp-protocol-version"] = "2025-06-18"; }
    const t = await r.text(); const line = t.split("\n").find((l) => l.startsWith("data:"));
    return line ? JSON.parse(line.slice(5)) : t ? JSON.parse(t) : null;
  };
  await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gbk-discovery-eval", version: "1" } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  return (list.result.tools as { name: string; description: string; inputSchema: object }[]);
}

// Generic tools a ChatGPT-like host also offers, so GBK must win on relevance, not by being the only option.
const DISTRACTORS = [
  { name: "web_search", description: "Search the web for current information, facts, recommendations and news.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "image_generation", description: "Generate an image from a text description.", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
  { name: "python", description: "Run Python code for calculations, data analysis and file processing.", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
];
const SYSTEM = "You are ChatGPT. The user has connected the GBK Composer app (tools prefixed gbk_) and you also have general tools. Call a tool only when it genuinely helps with the user's request; otherwise answer directly. If you call a tool, call the single most appropriate one first.";

async function main() {
  const fixtures: Fixture[] = readdirSync(FIX).filter((f) => f.endsWith(".json")).sort()
    .flatMap((f) => (JSON.parse(readFileSync(join(FIX, f), "utf8")) as { fixtures: Fixture[] }).fixtures).slice(0, LIMIT);
  const mcpTools = await liveTools();
  const tools = [...mcpTools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
    ...DISTRACTORS.map((d) => ({ type: "function", function: d }))];
  const outcomes: Outcome[] = []; let spent = 0, stoppedForBudget = false, inTok = 0, outTok = 0;
  for (const f of fixtures) {
    if (spent >= maxUsd) { stoppedForBudget = true; break; }
    try {
      const r = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, temperature: 0, max_tokens: 400, tool_choice: "auto", tools, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: f.prompt }] }) });
      if (!r.ok) { outcomes.push({ id: f.id, firstTool: null, error: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }); continue; }
      const j = await r.json() as { choices: { message: { tool_calls?: { function: { name: string } }[] } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
      const u = j.usage ?? { prompt_tokens: 0, completion_tokens: 0 }; inTok += u.prompt_tokens; outTok += u.completion_tokens;
      spent += (u.prompt_tokens * pIn + u.completion_tokens * pOut) / 1e6;
      outcomes.push({ id: f.id, firstTool: j.choices[0]?.message?.tool_calls?.[0]?.function?.name ?? null });
    } catch (e) { outcomes.push({ id: f.id, firstTool: null, error: (e as Error).message.slice(0, 120) }); }
    process.stderr.write(".");
  }
  process.stderr.write("\n");
  const s = summarize(fixtures, outcomes);
  const meta = { ranAt: new Date().toISOString(), mcpUrl: MCP, model, liveTools: mcpTools.map((t) => t.name), distractors: DISTRACTORS.map((d) => d.name),
    usage: { inputTokens: inTok, outputTokens: outTok, estimatedUsd: +spent.toFixed(4), budgetUsd: maxUsd, stoppedForBudget } };
  const report = { meta, ...s };
  mkdirSync(OUT, { recursive: true });
  const stamp = meta.ranAt.slice(0, 10);
  writeFileSync(join(OUT, `plugin-discovery-${stamp}.json`), JSON.stringify(report, null, 1) + "\n");
  const pct = (r: { rate: number | null; correct: number; total: number }) => r.rate === null ? "n/a" : `${(r.rate * 100).toFixed(1)}% (${r.correct}/${r.total})`;
  const fx = new Map(fixtures.map((f) => [f.id, f]));
  const md = [`# Plugin discovery eval — ${stamp}`, "", `Model \`${model}\` via tool calling (temperature 0) against the live tool list of \`${MCP}\` (${mcpTools.length} tools) plus distractors (${meta.distractors.join(", ")}). Tool calls are recorded, never executed. This is a proxy for ChatGPT's own app selection, not a ChatGPT measurement.`, "",
    "| Metric | Score |", "| --- | --- |",
    `| Invocation accuracy (A+B+C) | ${pct(s.invocationAccuracy)} |`, `| Recall on positives (A+B) | ${pct(s.recall)} |`,
    `| False-positive rate on negatives (C) | ${s.falsePositiveRate === null ? "n/a" : (s.falsePositiveRate * 100).toFixed(1) + "%"} |`,
    `| First-tool accuracy on positives | ${pct(s.firstToolAccuracy)} |`,
    `| A explicit / B follow-up / C negative | ${pct(s.byCategory.A)} / ${pct(s.byCategory.B)} / ${pct(s.byCategory.C)} |`,
    `| Borderline (D) invoked GBK | ${s.borderline.invokedGbk}/${s.borderline.total} (not scored) |`,
    `| Errors | ${s.totals.errors} |`, `| Usage | ${inTok} in / ${outTok} out tokens, ≈ $${meta.usage.estimatedUsd} (cap $${maxUsd}${stoppedForBudget ? ", STOPPED at cap" : ""}) |`, "",
    "## Misses", "", "| id | prompt | expected | first tool |", "| --- | --- | --- | --- |",
    ...s.scored.filter((x) => x.invocationCorrect === false || x.firstToolCorrect === false).map((x) => `| ${x.id} | ${fx.get(x.id)!.prompt.replace(/\|/g, "/")} | ${x.expect === "tool" ? (fx.get(x.id)!.expectedFirstTool ?? []).join(" or ") : "no GBK tool"} | ${x.firstTool ?? "none"} |`), ""].join("\n");
  writeFileSync(join(OUT, `plugin-discovery-${stamp}.md`), md);
  console.log(md);
}
main().catch((e) => { console.error((e as Error).message); process.exit(1); });
