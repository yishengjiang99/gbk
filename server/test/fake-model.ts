// Deterministic fake OpenAI-compatible Chat Completions server that returns REAL tool_calls (streamed in fragments)
// for the Baroque fugue scenario and a follow-up edit. It reads the ids it needs (track ids, proposal ids,
// artifact ids) from the tool results the real agent loop sends back, so the whole chain is exercised.
import { createServer, type Server } from "node:http";

type Msg = { role: string; content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string };
type Call = { name: string; args: unknown };
export interface FakeModel { url: string; requests: { messages: Msg[]; tools: { function: { name: string } }[] }[]; close(): Promise<void> }

const lastToolResults = (msgs: Msg[]) => { const out: Record<string, any> = {}; for (const m of msgs) if (m.role === "tool") { try { out[m.tool_call_id!] = JSON.parse(m.content ?? "{}"); } catch { /* */ } } return out; };
function resultFor(msgs: Msg[], tool: string): any {
  const res = lastToolResults(msgs);
  for (let i = msgs.length - 1; i >= 0; i--) for (const tc of msgs[i].tool_calls ?? []) if (tc.function.name === tool && res[tc.id]) return res[tc.id];
  return null;
}
const resultsFor = (msgs: Msg[], tool: string): any[] => { const res = lastToolResults(msgs); const o: any[] = []; for (const m of msgs) for (const tc of m.tool_calls ?? []) if (tc.function.name === tool && res[tc.id]) o.push(res[tc.id]); return o; };

/** Decide the next step from the conversation so far (only the CURRENT turn counts). */
export function nextStep(msgs: Msg[]): { calls: Call[] } | { text: string } {
  let u = msgs.length - 1; while (u >= 0 && msgs[u].role !== "user") u--;
  const userText = (msgs[u]?.content ?? "").toLowerCase();
  const turn = msgs.slice(u + 1);
  const steps = turn.filter((m) => m.role === "assistant" && m.tool_calls?.length).length;
  const r = (t: string) => resultFor(turn, t);
  if (userText.includes("resume check")) { // e2e: the run's 2nd model reply is held at the gate (POST /gate) while the tab is away
    if (steps === 0) return { calls: [{ name: "gbk_list_tracks", args: {} }] };
    if (steps === 1) return { calls: [{ name: "gbk_get_project_summary", args: {} }], gated: true } as never;
    return { text: `Resumed OK after ${resultsFor(turn, "gbk_get_project_summary").filter((x) => x.ok).length} summary read.` };
  }
  if (userText.includes("darker")) {
    switch (steps) {
      case 0: return { calls: [{ name: "gbk_list_tracks", args: {} }, { name: "gbk_get_project_summary", args: {} }] };
      case 1: { const cello = (r("gbk_list_tracks")?.data ?? []).find((t: any) => /cello/i.test(t.name)); return { calls: [{ name: "gbk_propose_voice_patch", args: { trackId: cello?.id ?? "Cello", edits: [{ param: "filterCutoff", mode: "set", value: 1800 }], summary: "darker cello" } }] }; }
      case 2: return { calls: [{ name: "gbk_commit_proposal", args: { proposalId: r("gbk_propose_voice_patch")?.data?.proposalId } }, { name: "gbk_set_effects", args: { reverbLevel: 0.3, summary: "less reverb" } }] };
      case 3: return { calls: [{ name: "gbk_commit_proposal", args: { proposalId: r("gbk_set_effects")?.data?.proposalId } }] };
      default: { const ok = resultsFor(turn, "gbk_commit_proposal").filter((x) => x.ok).length; return { text: `Done: the cello is darker (filter cutoff 1800 Hz) and the reverb level is down to 0.3; ${ok} change(s) committed. I did not regenerate the piece.` }; }
    }
  }
  switch (steps) {
    case 0: return { calls: [{ name: "gbk_get_capabilities", args: {} }] };
    case 1: return { calls: [{ name: "gbk_create_project", args: { name: "Fugue in D minor", tempo: 76, timeSignature: [4, 4], key: "D minor", descriptors: { form: "fugue", mood: "dramatic" } } }] };
    case 2: return { calls: [{ name: "gbk_generate_arrangement", args: { style: "baroque", key: "D minor", bars: 32, voices: 4, complexity: 4, seed: 261023, instrumentation: ["violin", "viola", "cello", "harpsichord"] } }] };
    case 3: return { calls: [{ name: "gbk_list_tracks", args: {} }] };
    case 4: {
      const tracks = r("gbk_list_tracks")?.data ?? [];
      const prog: Record<string, number> = { violin: 40, viola: 41, cello: 42, harpsichord: 6 };
      return { calls: tracks.map((t: any) => ({ name: "gbk_set_instrument", args: { trackId: t.id, program: prog[Object.keys(prog).find((k) => t.name.toLowerCase().includes(k)) ?? "violin"] } })) };
    }
    case 5: {
      const tracks = (resultFor(turn, "gbk_list_tracks")?.data ?? []).filter((t: any) => !/harpsichord/i.test(t.name)).map((t: any) => t.id);
      return { calls: [{ name: "gbk_generate_cc_curve", args: { trackIds: tracks, controller: 11, range: { unit: "bars", start: 25, end: 32 }, shape: "swell", from: 70, peak: 124, to: 90, summary: "CC11 climax swell" } }] };
    }
    case 6: return { calls: [{ name: "gbk_commit_proposal", args: { proposalId: r("gbk_generate_cc_curve")?.data?.proposalId } }, { name: "gbk_set_effects", args: { enabled: true, roomSize: 0.82, damping: 0.4, reverbLevel: 0.55, summary: "concert hall" } }] };
    case 7: return { calls: [{ name: "gbk_commit_proposal", args: { proposalId: r("gbk_set_effects")?.data?.proposalId } }] };
    case 8: return { calls: [{ name: "gbk_render_wav", args: { sampleRate: 44100, channels: 2, format: "pcm16", output: "artifact", download: false, includeMidi: true } }] };
    case 9: return { calls: [{ name: "gbk_get_render_artifact", args: { artifactId: r("gbk_render_wav")?.data?.artifactId ?? "missing" } }] };
    default: {
      const w = resultFor(turn, "gbk_render_wav"); const a = resultFor(turn, "gbk_get_render_artifact");
      if (!w?.ok || !a?.ok) return { text: `The render did not complete: ${JSON.stringify(w?.error ?? a?.error)}` };
      return { text: `Composed "Fugue in D minor": 4 voices (violin, viola, cello, harpsichord), 32 bars, CC11 swell into the final stretto and concert-hall reverb. Rendered WAV artifact ${a.data.artifactId} (${w.data.durationSeconds} s, ${w.data.bytes} bytes, sha256 ${String(w.data.sha256).slice(0, 12)}).` };
    }
  }
}

export function startFakeModel(port = 0, opts: { failFirst?: number; usage?: boolean } = {}): Promise<FakeModel> {
  const requests: FakeModel["requests"] = []; let gate: (() => void)[] = []; let fails = opts.failFirst ?? 0; let seq = 0;
  const server: Server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/healthz") { res.writeHead(200).end("ok"); return; }
      if (req.url === "/gate" && req.method === "POST") { const w = gate; gate = []; w.forEach((f) => f()); res.writeHead(200).end(String(w.length)); return; }
      if (req.url !== "/v1/chat/completions" || req.headers.authorization !== "Bearer fake-key") { res.writeHead(401).end('{"error":{"message":"bad key"}}'); return; }
      if (fails > 0) { fails--; res.writeHead(429, { "retry-after": "0" }).end('{"error":{"message":"slow down"}}'); return; }
      const j = JSON.parse(body); requests.push({ messages: j.messages, tools: j.tools ?? [] });
      // Title suggestions come without tools; answer deterministically.
      const step = !(j.tools ?? []).length && /name short musical compositions/.test(JSON.stringify(j.messages[0] ?? "")) ? { text: "Midnight Fugue in D Minor" } : nextStep(j.messages);
      const chunks: unknown[] = [];
      const base = { id: `chatcmpl_${++seq}`, object: "chat.completion.chunk", model: j.model };
      if ("text" in step) { for (const part of step.text.match(/.{1,40}/gs) ?? []) chunks.push({ ...base, choices: [{ index: 0, delta: { content: part } }] }); chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }); }
      else {
        step.calls.forEach((c, i) => {
          const id = `call_${seq}_${i}`; const args = JSON.stringify(c.args);
          chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id, type: "function", function: { name: c.name, arguments: "" } }] } }] });
          for (const frag of args.match(/.{1,17}/gs) ?? []) chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: frag } }] } }] });
        });
        chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      }
      if (opts.usage !== false) chunks.push({ ...base, choices: [], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 } });
      const send = () => { res.writeHead(200, { "content-type": "text/event-stream" });
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.end("data: [DONE]\n\n"); };
      if ((step as { gated?: boolean }).gated) { const t = setTimeout(send, 120_000); gate.push(() => { clearTimeout(t); send(); }); } else send();
    });
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => { const a = server.address() as { port: number }; ok({ url: `http://127.0.0.1:${a.port}/v1`, requests, close: () => new Promise((d) => server.close(() => d())) }); }));
}

if (process.argv[1]?.endsWith("fake-model.ts")) {
  const port = Number(process.env.FAKE_MODEL_PORT ?? 8799);
  void startFakeModel(port).then((m) => console.log(`fake model at ${m.url}`));
}
