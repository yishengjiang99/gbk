// MCP acceptance harness (#72 Phase 2): runs scenarios A (first use), B (revision continuity),
// C (capability/session recovery) and E (failures) against any GBK MCP base URL, with the
// same assertions locally (server/test/launch-acceptance.test.ts) and in production
// (scripts/acceptance/prod-smoke.ts). Every composition it creates is private and is deleted at
// the end with its own edit key. It never prints access tokens: it records ids, revisions, sizes,
// and hashes only.
import { createHash } from "node:crypto";

export interface Check { scenario: string; name: string; ok: boolean; detail: string }
type Rpc = { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text?: string }[] }; error?: { code: number; message: string } };

export class Mcp {
  sid: string | null = null; private n = 0;
  constructor(readonly base: string) {}
  async send(method: string, params: unknown, notify = false): Promise<{ status: number; rpc?: Rpc }> {
    const id = notify ? undefined : ++this.n;
    const r = await fetch(`${this.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(this.sid ? { "mcp-session-id": this.sid } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params }) });
    const s = r.headers.get("mcp-session-id"); if (s) this.sid = s;
    const t = await r.text(); let rpc: Rpc | undefined;
    const data = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
    if (data.length) rpc = data.find((m) => m.id === id) ?? data.at(-1); else if (t) { try { rpc = JSON.parse(t); } catch { /* not JSON */ } }
    return { status: r.status, rpc };
  }
  async init() { await this.send("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "gbk-acceptance", version: "1" } }); await this.send("notifications/initialized", {}, true); return this; }
  async tools() { return ((await this.send("tools/list", {})).rpc?.result as unknown as { tools: { name: string; inputSchema: unknown; annotations?: Record<string, boolean> }[] }).tools; }
  /** Returns { ok, data, code } and never throws for tool errors. */
  async call(name: string, args: Record<string, unknown>) {
    const r = await this.send("tools/call", { name, arguments: args });
    if (r.rpc?.error) return { ok: false, data: {} as Record<string, any>, code: `RPC_${r.rpc.error.code}` };
    const res = r.rpc?.result;
    if (!res) return { ok: false, data: {} as Record<string, any>, code: `HTTP_${r.status}` };
    if (res.isError) { const txt = res.content?.[0]?.text ?? ""; const m = txt.match(/"code"\s*:\s*"([A-Z_]+)"/) ?? txt.match(/\b([A-Z]{3,}_[A-Z_]+)\b/); return { ok: false, data: {} as Record<string, any>, code: m?.[1] ?? "TOOL_ERROR" }; }
    return { ok: true, data: (res.structuredContent ?? {}) as Record<string, any>, code: "" };
  }
}

export function wavInfo(b: Buffer) {
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error("not RIFF/WAVE");
  let p = 12, fmt: { format: number; channels: number; rate: number; bits: number } | null = null, data = -1, peak = 0;
  while (p + 8 <= b.length) { const id = b.toString("ascii", p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === "fmt ") fmt = { format: b.readUInt16LE(p + 8), channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === "data") { data = size; if (fmt?.bits === 16) for (let i = p + 8; i + 1 < Math.min(b.length, p + 8 + size); i += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(i))); break; }
    p += 8 + size + (size & 1); }
  if (!fmt || data <= 0) throw new Error("missing fmt/data");
  return { ...fmt, seconds: data / (fmt.rate * fmt.channels * fmt.bits / 8), silent: fmt.bits === 16 && peak === 0 };
}
export function midiInfo(b: Buffer) {
  if (b.toString("ascii", 0, 4) !== "MThd" || b.readUInt32BE(4) !== 6) throw new Error("not SMF");
  let p = 14, tracks = 0; while (p + 8 <= b.length) { if (b.toString("ascii", p, p + 4) !== "MTrk") throw new Error("bad chunk"); p += 8 + b.readUInt32BE(p + 4); tracks++; }
  if (p !== b.length) throw new Error("trailing bytes");
  return { format: b.readUInt16BE(8), tracks, division: b.readUInt16BE(12) };
}

export async function runAcceptance(base: string, opts: { log?: (s: string) => void; renderWaitSeconds?: number } = {}): Promise<Check[]> {
  const checks: Check[] = []; const log = opts.log ?? (() => {});
  const wait = opts.renderWaitSeconds ?? 110;
  const created: { id: string; token: string }[] = [];
  const check = (scenario: string, name: string, ok: boolean, detail = "") => { checks.push({ scenario, name, ok, detail }); log(`${ok ? "PASS" : "FAIL"} [${scenario}] ${name}${detail ? ` (${detail})` : ""}`); return ok; };
  const fetchArt = async (url: string) => { const u = new URL(url, base); const r = await fetch(new URL(u.pathname + u.search, base)); return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) }; };
  const verifyArtifacts = async (sc: string, job: Record<string, any>, rev: number) => {
    const arts = (job.artifacts ?? []) as { kind: string; downloadUrl: string; sha256: string; sizeBytes: number; revision?: number }[];
    check(sc, "render publishes WAV + MIDI", arts.map((a) => a.kind).sort().join() === "midi,wav", arts.map((a) => a.kind).join());
    check(sc, "job is tied to the rendered revision", job.revision === rev, `job.revision=${job.revision} expected=${rev}`);
    for (const a of arts) {
      const { status, bytes } = await fetchArt(a.downloadUrl);
      const sha = createHash("sha256").update(bytes).digest("hex");
      check(sc, `${a.kind} download 200 + sha256/size match`, status === 200 && sha === a.sha256 && bytes.length === a.sizeBytes, `${bytes.length} B`);
      try { if (a.kind === "wav") { const w = wavInfo(bytes); check(sc, "WAV is 44.1k stereo PCM16, non-silent", w.rate === 44100 && w.channels === 2 && w.bits === 16 && !w.silent, `${w.seconds.toFixed(1)} s`); }
        else { const m = midiInfo(bytes); check(sc, "MIDI is a valid SMF", m.tracks >= 2, `format ${m.format}, ${m.tracks} tracks`); } }
      catch (e) { check(sc, `${a.kind} parses`, false, String(e)); }
      if (a.kind === "midi") { const bad = new URL(a.downloadUrl, base); bad.searchParams.set("sig", "0".repeat(16)); const t = await fetchArt(bad.toString()); check("E", "tampered/expired download link is refused", t.status >= 400 && t.status < 500, `HTTP ${t.status}`); }
    }
    return arts;
  };

  try {
    const c = await new Mcp(base).init();
    const tools = (await c.tools()).map((t) => t.name);
    check("A", "tools/list works without sign-in", tools.includes("gbk_create_composition") && tools.includes("gbk_render_composition"), `${tools.length} tools`);

    // ---- A: anonymous first use ----------------------------------------------------------------------
    const a = await c.call("gbk_create_composition", { title: "Acceptance fugue", style: "baroque", key: "D minor", bars: 16, instrumentation: ["organ", "organ", "organ", "organ"], voices: 4, seed: 7201 });
    if (!check("A", "anonymous create (baroque, D minor, 16 bars, organ)", a.ok && !!a.data.accessToken && !!a.data.readAccessToken, a.code)) return checks;
    created.push({ id: a.data.compositionId, token: a.data.accessToken });
    const A = { compositionId: a.data.compositionId as string, accessToken: a.data.accessToken as string };
    const ga = await c.call("gbk_get_composition", { ...A, includeNotes: true, limit: 50 });
    check("A", "composition is private by default", ga.ok && ga.data.visibility === "private", String(ga.data.visibility));
    const tracks = (ga.data.tracks ?? []) as { id: string; name?: string; program?: number }[];
    check("A", "multi-track structure (>= 4 voices)", tracks.length >= 4, `${tracks.length} tracks`);
    const ui = await c.call("gbk_show_composition_ui", { ...A, accessToken: a.data.readAccessToken });
    check("A", "player (piano roll + tracks) opens with the read key and never echoes the edit key", ui.ok && !JSON.stringify(ui.data).includes(A.accessToken), ui.code);
    const ra = await c.call("gbk_render_composition", { ...A, waitSeconds: wait });
    if (check("A", "headless render completes", ra.ok && ra.data.status === "completed", `${ra.code}${ra.data.status ?? ""}`)) {
      check("A", "render result has no audio bytes or edit key", !JSON.stringify(ra.data).includes("UklGR") && !JSON.stringify(ra.data).includes(A.accessToken));
      await verifyArtifacts("A", ra.data, a.data.revision);
    }

    // ---- B: revision continuity ----------------------------------------------------------------------
    const b = await c.call("gbk_create_composition", { title: "Acceptance jazz", style: "jazz", key: "F major", tempo: 140, bars: 24, seed: 7202 });
    if (check("B", "create 24-bar jazz in F at 140", b.ok, b.code)) {
      created.push({ id: b.data.compositionId, token: b.data.accessToken });
      const B = { compositionId: b.data.compositionId as string, accessToken: b.data.accessToken as string };
      const g0 = await c.call("gbk_get_composition", B);
      const bassTrack = ((g0.data.tracks ?? []) as { id: string; name?: string }[]).find((t) => /bass/i.test(`${t.name} ${t.id}`));
      check("B", "jazz arrangement has a bass track", !!bassTrack, bassTrack?.id ?? "none");
      const bass = bassTrack?.id ?? "bass";
      const e1 = await c.call("gbk_edit_composition", { ...B, expectedRevision: b.data.revision, operations: [{ type: "generate_part", track: bass, startBar: 1, endBar: 24, kind: "walking_bass", seed: 3 }] });
      check("B", "walking bass generated as a new revision", e1.ok && e1.data.revision > b.data.revision, e1.code);
      // Compare notes that START in the untouched bars (a note held over from bar 16 legitimately shows in a 17-24 query).
      const barTicks = (g0.data.ppq ?? 480) * 4;
      const notesOf = async (startBar: number, endBar: number) => { const r = await c.call("gbk_get_composition", { ...B, includeNotes: true, startBar, endBar, limit: 1000 });
        const items = ((r.data.notes?.items ?? []) as { tick: number }[]).filter((n) => n.tick >= (startBar - 1) * barTicks && n.tick < endBar * barTicks);
        return JSON.stringify(items.sort((x, y) => JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)); };
      const before = [await notesOf(1, 8), await notesOf(17, 24)];
      const e2 = await c.call("gbk_edit_composition", { ...B, expectedRevision: e1.data.revision, operations: [
        { type: "orchestrate", sourceTrack: bass, targetTrack: bass, startBar: 9, endBar: 16, semitones: -12 },
        { type: "cc_curve", track: bass, controller: 11, startBar: 9, endBar: 16, shape: "crescendo" } ] });
      check("B", "double bass -12 in bars 9-16 + CC11 crescendo", e2.ok && e2.data.revision > e1.data.revision, e2.code);
      check("B", "server reports untouched sections unchanged", e2.data.untouchedSectionsUnchanged === true, String(e2.data.untouchedSectionsUnchanged));
      const after = [await notesOf(1, 8), await notesOf(17, 24)];
      check("B", "notes starting in bars 1-8 and 17-24 are identical", before[0] === after[0] && before[1] === after[1] && before[0].length > 2, `${before[0].length + before[1].length} B compared`);
      const stale = await c.call("gbk_edit_composition", { ...B, expectedRevision: b.data.revision, operations: [{ type: "set_tempo", bpm: 100 }] });
      check("E", "stale expectedRevision is rejected (no lost update)", !stale.ok && stale.code === "STALE_REVISION", stale.code);
      const rb = await c.call("gbk_render_composition", { ...B, waitSeconds: wait });
      if (check("B", "re-render completes", rb.ok && rb.data.status === "completed", rb.code)) await verifyArtifacts("B", rb.data, e2.data.revision);
      const arts = await c.call("gbk_get_artifacts", { ...B });
      check("B", "gbk_get_artifacts returns the latest revision's files", arts.ok && JSON.stringify(arts.data).includes("wav"), arts.code);

      // ---- C: session recovery --------------------------------------------------------------------
      const fresh = await new Mcp(base).init();
      const g1 = await fresh.call("gbk_get_composition", B);
      check("C", "new session (new conversation) + retained token: opens the project", g1.ok && g1.data.revision === e2.data.revision, g1.code);
      const noTok = await fresh.call("gbk_get_composition", { compositionId: B.compositionId });
      check("C", "lost token: the id alone grants nothing", !noTok.ok, noTok.code);
      const ro = { compositionId: B.compositionId, accessToken: b.data.readAccessToken as string };
      const roGet = await fresh.call("gbk_get_composition", ro);
      const roEdit = await fresh.call("gbk_edit_composition", { ...ro, expectedRevision: e2.data.revision, operations: [{ type: "set_tempo", bpm: 90 }] });
      const roPub = await fresh.call("gbk_publish_composition", ro);
      const roDel = await fresh.call("gbk_delete_composition", ro);
      check("C", "read-only key can read but cannot edit, publish or delete", roGet.ok && !roEdit.ok && !roPub.ok && !roDel.ok, [roEdit.code, roPub.code, roDel.code].join("/"));
      const cross = await fresh.call("gbk_get_composition", { compositionId: B.compositionId, accessToken: A.accessToken });
      check("C", "another project's token is denied (cross-project)", !cross.ok, cross.code);
      const vis = await fresh.call("gbk_get_composition", B);
      check("C", "nothing was published", vis.data.visibility === "private", String(vis.data.visibility));
    }

    // ---- E: failures ---------------------------------------------------------------------------------
    const bad = await c.call("gbk_create_composition", { title: "x", bars: 99999 });
    check("E", "malformed args are rejected with a clear error", !bad.ok, bad.code);
    const unk = await c.call("gbk_render_composition", { ...A, soundFont: "no-such-font" });
    check("E", "unknown SoundFont is rejected before a job starts", !unk.ok && unk.code === "INVALID_ARGUMENT", unk.code);
    const q = await c.call("gbk_render_composition", { ...A, waitSeconds: 0, idempotencyKey: `cancel-${Date.now()}` });
    if (q.ok && q.data.jobId) {
      const x = await c.call("gbk_cancel_render", { jobId: q.data.jobId, accessToken: A.accessToken });
      const st = await c.call("gbk_get_render_status", { jobId: q.data.jobId, accessToken: A.accessToken });
      const s = String(st.data.status);
      check("E", "cancel: cancelled jobs publish no partial artifacts", (s === "cancelled" && (st.data.artifacts ?? []).length === 0) || s === "completed", `cancel=${x.ok ? "ok" : x.code} status=${s}`);
    } else check("E", "cancel: render could be queued", false, q.code);
  } finally {
    const c = await new Mcp(base).init();
    for (const p of created) { const d = await c.call("gbk_delete_composition", { compositionId: p.id, accessToken: p.token }); check("cleanup", "delete test composition with its edit key", d.ok, d.code); }
    if (created[0]) { const gone = await c.call("gbk_get_composition", { compositionId: created[0].id, accessToken: created[0].token }); check("cleanup", "deleted composition is gone", !gone.ok, gone.code); }
  }
  return checks;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.argv[2] ?? process.env.GBK_BASE ?? "http://127.0.0.1:8787";
  const checks = await runAcceptance(base, { log: (s) => console.log(s) });
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed against ${new URL(base).host}`);
  process.exit(failed.length ? 1 : 0);
}
