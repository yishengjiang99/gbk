// Remote MCP server for GBK Composer, built on the official @modelcontextprotocol/sdk (Streamable HTTP).
//
// Public surface = a small, user-goal-focused tool layer over CompositionService / RenderService. The
// canonical gbk_* registry stays the musical engine underneath (via the service); it is NOT mirrored 1:1
// here, so ChatGPT/Codex get deterministic operations, durable revisions and artifacts — not browser state.
//
// Every tool returns structuredContent plus a JSON text fallback, uses typed domain errors, and enforces
// project capabilities or per-tool OAuth scopes. Mutating tools accept idempotencyKey: a replay with the same key + same request
// returns the original result; the same key with a different request is IDEMPOTENCY_CONFLICT.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { createHash, randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import type { McpStore, ArtifactRow } from "./store.ts";
import type { CompositionService, EditOperation } from "./service.ts";
import { RenderService, DEFAULT_RENDER_CONFIG, type RenderConfig } from "./render.ts";
import { requireScope, type Principal, type Scope } from "./auth.ts";
import { McpError, toMcpError } from "./errors.ts";
import { signArtifactUrl } from "./urls.ts";
import { COMPOSER_UI_HTML, COMPOSER_UI_URI } from "./ui.ts";
import { guestCapability, guestOwner, resolveGuestCapability } from "./guest.ts";
import { MCP_SERVER_VERSION } from "./service-meta.ts";

export interface McpMetrics { calls: number; errors: number; authFailures: number; byTool: Record<string, number> }
/**
 * Mutable per-session authorization holder. Tool handlers read `current` at call time, so the routes
 * layer can rebind a session to the credentials presented on EACH request: a refreshed token with
 * narrower scopes takes effect immediately, and an anonymous session can upgrade to authenticated.
 * The session stays bound to one user — the holder is never switched to a different user.
 */
export interface SessionAuth { current: Principal | null }
export interface McpContext {
  cfg: Config; store: McpStore; service: CompositionService; renders: RenderService;
  auth: SessionAuth; signal: AbortSignal; metrics: McpMetrics;
  log: (o: object) => void;
}

const ok = (data: Record<string, unknown>) => ({
  structuredContent: data,
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }],
});
const fail = (e: McpError) => ({
  isError: true,
  content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } }) }],
});

const COMPOSITION_ID = z.string().min(1).max(128).describe("Durable composition id returned by gbk_create_composition");
const ACCESS_TOKEN = z.string().min(1).max(256).optional().describe("Private project capability returned at creation. Required for guest read/edit/render/status/artifact calls. Keep the edit token secret; never put it in a public link.");
const IDEMPOTENCY = z.string().min(8).max(128).optional().describe("Retry key: replays with the same key and same arguments return the original result instead of applying twice");

export function artifactView(cfg: Config, a: ArtifactRow) {
  const meta = JSON.parse(a.meta_json) as Record<string, unknown>;
  const signed = signArtifactUrl(cfg, a.id);
  return { artifactId: a.id, kind: a.kind, filename: a.filename, mimeType: a.mime_type, sizeBytes: a.size_bytes, sha256: a.sha256,
    revision: a.revision, downloadUrl: signed.url, downloadUrlExpiresAt: signed.expiresAt, meta };
}

export function createGbkMcpServer(ctx: McpContext): McpServer {
  const { cfg, store, service, renders, metrics } = ctx;
  const server = new McpServer({ name: "gbk-composer", version: MCP_SERVER_VERSION }, { capabilities: { tools: {}, resources: {} } });

  const guestSession = randomUUID();
  // Serialize retries of the same key, but allow cancellation/status during a waiting render.
  const pending = new Map<string, Promise<unknown>>();
  let activeCalls = 0;
  function run<T extends Record<string, unknown>>(tool: string, scope: Scope | null, args: Record<string, unknown>, fn: (p: Principal | null) => Promise<T>) {
    if (activeCalls >= 16) return Promise.resolve(fail(new McpError("RATE_LIMITED", "too many concurrent calls in this MCP session")));
    activeCalls++;
    const current = ctx.auth.current;
    const key = typeof args.idempotencyKey === "string" ? args.idempotencyKey : randomUUID();
    const result = (pending.get(key) ?? Promise.resolve()).then(() => execute(tool, scope, args, fn, current));
    pending.set(key, result);
    void result.finally(() => { activeCalls--; if (pending.get(key) === result) pending.delete(key); });
    return result;
  }
  async function execute<T extends Record<string, unknown>>(tool: string, scope: Scope | null, args: Record<string, unknown>, fn: (p: Principal | null) => Promise<T>, current: Principal | null): Promise<ReturnType<typeof ok> | ReturnType<typeof fail>> {
    metrics.calls++; metrics.byTool[tool] = (metrics.byTool[tool] ?? 0) + 1;
    try {
      let principal = current;
      if (typeof args.accessToken === "string") {
        const guest = resolveGuestCapability(cfg, store, args.accessToken);
        if (args.compositionId !== undefined && args.compositionId !== guest.compositionId)
          throw new McpError("NOT_FOUND", "accessToken does not authorize this composition");
        if (typeof args.jobId === "string" && !store.getJob(args.jobId, guest.user))
          throw new McpError("NOT_FOUND", "no such render job for this project");
        principal = guest;
      } else if (!principal && scope) {
        if (tool === "gbk_create_composition") principal = { user: guestOwner(cfg, guestSession, args.idempotencyKey as string | undefined), via: "guest", scopes: ["gbk:compositions.write"] };
        else if (tool === "gbk_list_compositions") return ok({ items: [], note: "Supply a project's accessToken to list it. Guest projects have no account-wide directory." });
        else throw new McpError("NOT_FOUND", "private project: supply the accessToken returned when it was created");
      }
      const p = scope ? requireScope(principal, scope) : principal;
      const present = (out: Record<string, unknown>) => {
        if (tool === "gbk_create_composition" && p?.via === "guest") {
          const row = service.getRow(p.user, String(out.compositionId));
          return { ...out, accessToken: guestCapability(cfg, row, "edit"), readAccessToken: guestCapability(cfg, row, "read"),
            projectUrl: service.openWorkstation(p.user, row.id).url,
            accessNote: "Save compositionId and accessToken for future editing, including in new sessions. The readAccessToken and Studio link grant read access only. Losing the edit token loses editing access." };
        }
        return out;
      };
      const invoke = async () => {
        if (p?.via === "guest" && scope && !["gbk:compositions.read", "gbk:artifacts.read"].includes(scope)) {
          if (!store.takeGuestBudget("mutations", cfg.mcp.guestMutationsPerDay)) throw new McpError("QUOTA_EXCEEDED", "global guest daily mutation budget reached; retry tomorrow");
          if (tool === "gbk_create_composition" && (!store.takeGuestBudget("creates", cfg.mcp.guestCreatesPerDay) || store.guestCompositionCount() >= cfg.mcp.guestMaxCompositions))
            throw new McpError("QUOTA_EXCEEDED", "global guest composition capacity reached");
        }
        return fn(p);
      };
      const key = typeof args.idempotencyKey === "string" ? args.idempotencyKey : null;
      if (key && p) {
        const reqHash = createHash("sha256").update(JSON.stringify({ tool, args })).digest("hex");
        const prev = store.getIdempotent(p.user, key);
        if (prev) {
          if (prev.tool !== tool || prev.request_hash !== reqHash) throw new McpError("IDEMPOTENCY_CONFLICT", "idempotencyKey was already used with different arguments");
          return ok(present(JSON.parse(prev.result_json) as Record<string, unknown>));
        }
        const out = await invoke();
        store.putIdempotent(p.user, key, tool, reqHash, out);
        return ok(present(out));
      }
      return ok(present(await invoke()));
    } catch (e) {
      metrics.errors++;
      const me = toMcpError(e);
      if (me.code === "UNAUTHENTICATED" || me.code === "INSUFFICIENT_SCOPE") metrics.authFailures++;
      ctx.log({ evt: "mcp_tool_error", tool, code: me.code, message: me.message, user: ctx.auth.current?.user });
      return fail(me);
    }
  }
  const annotations = (readOnly: boolean, idempotent = false) => ({
    readOnlyHint: readOnly, destructiveHint: false, idempotentHint: idempotent, openWorldHint: false,
  });

  // ---- discovery (public, read-only) ----------------------------------------------------------------
  server.registerTool("gbk_get_capabilities", {
    title: "GBK capabilities", description: "Discover GBK Composer styles, composition modes, instruments (SoundFont presets), render formats and limits. Call this before composing instead of guessing supported features.",
    inputSchema: {}, annotations: annotations(true, true),
  }, async () => run("gbk_get_capabilities", null, {}, async () => ({ capabilities: service.capabilities() })));

  // ---- compositions ----------------------------------------------------------------------------------
  server.registerTool("gbk_create_composition", {
    title: "Create a composition", description: "Create a durable, server-side GBK composition with the deterministic arrangement engine (seeded). No sign-in required. Returns compositionId, revision, private accessToken for ALL follow-up calls, readAccessToken, structure summary and Studio URL. No browser tab is required. Rendering is a separate step (gbk_render_composition).",
    inputSchema: {
      title: z.string().min(1).max(128),
      style: z.enum(["baroque", "classical", "pop", "jazz", "ambient"]).optional().describe("baroque uses the Bach fugue generator + continuo"),
      mood: z.string().max(120).optional(), key: z.string().max(32).optional().describe("e.g. \"D minor\""),
      tempo: z.number().min(20).max(400).optional().describe("BPM"),
      timeSignature: z.tuple([z.number().int().min(1).max(32), z.number().int().min(1).max(32)]).optional(),
      bars: z.number().int().min(1).max(512).optional(), durationSeconds: z.number().min(5).max(3600).optional().describe("Alternative to bars; converted using tempo and meter"),
      instrumentation: z.array(z.string().max(32)).max(12).optional().describe("Instrument names from gbk_get_capabilities (violin, viola, cello, harpsichord, organ, piano, ...). Repeat a name for multiple voices, e.g. four organs."),
      voices: z.union([z.literal(3), z.literal(4)]).optional(), complexity: z.number().int().min(1).max(5).optional(),
      seed: z.number().int().min(0).max(2 ** 31).optional(),
      sections: z.array(z.object({ name: z.string().max(64), startBar: z.number().int().min(1), bars: z.number().int().min(1), energy: z.number().min(0).max(1).optional() })).max(64).optional(),
      importShareSlug: z.string().max(128).optional().describe("Import one of your saved GBK Studio projects by its share slug instead of generating a new arrangement"),
      idempotencyKey: IDEMPOTENCY,
    }, annotations: annotations(false),
  }, async (a) => run("gbk_create_composition", "gbk:compositions.write", a as Record<string, unknown>, async (p) => {
    if (a.importShareSlug) { const { data } = service.importFromShare(p!.user, a.importShareSlug); return { ...data, imported: true }; }
    const { data } = await service.create(p!.user, {
      title: a.title, style: a.style, mood: a.mood, key: a.key, tempo: a.tempo, timeSignature: a.timeSignature as [number, number] | undefined,
      bars: a.bars, durationSeconds: a.durationSeconds, instrumentation: a.instrumentation, voices: a.voices, complexity: a.complexity, seed: a.seed,
      sections: a.sections,
    }, ctx.signal);
    return data;
  }));

  server.registerTool("gbk_get_composition", {
    title: "Get a composition", description: "Structured summary of one of your compositions: sections, tracks, instrumentation, controllers, revision history. Optionally include paginated notes for a bar range.",
    inputSchema: { compositionId: COMPOSITION_ID, accessToken: ACCESS_TOKEN, startBar: z.number().int().min(1).optional(), endBar: z.number().int().min(1).optional(),
      includeNotes: z.boolean().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(1000).optional() },
    annotations: annotations(true, true),
  }, async (a) => run("gbk_get_composition", "gbk:compositions.read", a as Record<string, unknown>, async (p) => service.get(p!.user, a.compositionId, a)));

  server.registerTool("gbk_list_compositions", {
    title: "List your compositions", description: "Account compositions, or the single guest project authorized by accessToken. Anonymous calls without a capability return an empty list.",
    inputSchema: { accessToken: ACCESS_TOKEN, limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() },
    annotations: annotations(true, true),
  }, async (a) => run("gbk_list_compositions", "gbk:compositions.read", a as Record<string, unknown>, async (p) => ({ items: service.list(p!.user, a.limit, a.offset) })));

  server.registerTool("gbk_edit_composition", {
    title: "Edit a composition", description: "Apply typed, deterministic edit operations to one passage or aspect of an existing composition. Requires expectedRevision (optimistic concurrency): on STALE_REVISION, re-read with gbk_get_composition and retry. Operations: generate_part {track, startBar, endBar, kind: melody|bass|walking_bass|chords|arpeggio|alberti|drums|counterpoint, seed?}, transform_notes {track, startBar, endBar, transform: transpose|invert|retrograde|repeat|sequence|quantize|humanize|articulation|phrase_dynamics|variation, ...}, orchestrate {sourceTrack, targetTrack, startBar, endBar, semitones?, velocityScale?} (e.g. octave doubling), cc_curve {track|trackIds, controller, startBar, endBar, shape: crescendo|decrescendo|swell|linear|smoothstep|exponential, from?, to?, peak?}, note_patch {add?, remove?, update?}, cc_patch {track, controller, startBar, endBar, points:[{tick,value}]}, set_mix {track, volume?, pan?, expression?, mute?, solo?}, set_instrument {track, program, bankMsb?, bankLsb?}, set_tempo {bpm}, set_sections {sections}, generate_arrangement {style, ...}, generate_fugue_section {key, voices, atBar, ...}. Unrelated sections are left untouched; the result reports untouchedSectionsUnchanged.",
    inputSchema: { compositionId: COMPOSITION_ID, accessToken: ACCESS_TOKEN, expectedRevision: z.number().int().min(0),
      operations: z.array(z.record(z.string(), z.unknown())).min(1).max(32), idempotencyKey: IDEMPOTENCY },
    annotations: annotations(false),
  }, async (a) => run("gbk_edit_composition", "gbk:compositions.write", a as Record<string, unknown>, async (p) => {
    const { data } = await service.edit(p!.user, a.compositionId, a.expectedRevision, a.operations as EditOperation[], ctx.signal);
    return data;
  }));

  // ---- rendering --------------------------------------------------------------------------------------
  server.registerTool("gbk_render_composition", {
    title: "Render a composition", description: "Render a saved composition revision to a validated WAV (canonical SF2 offline renderer, server-side, no browser needed) plus a Standard MIDI File. Returns a durable job; with waitSeconds it waits up to that long and returns the completed result with authorized artifact URLs when the render finishes in time.",
    inputSchema: { compositionId: COMPOSITION_ID, accessToken: ACCESS_TOKEN, revision: z.number().int().min(0).optional().describe("Render this exact stored revision instead of the latest"),
      sampleRate: z.union([z.literal(44100), z.literal(48000)]).optional(), channels: z.union([z.literal(1), z.literal(2)]).optional(),
      format: z.enum(["pcm16", "float32"]).optional(), normalize: z.enum(["loudness", "peak", "off"]).optional(),
      targetLufs: z.number().min(-40).max(-5).optional().describe("Loudness target (default -16 LUFS, peak ceiling -1 dBTP)"),
      tailSeconds: z.number().min(0).max(30).optional(), includeMidi: z.boolean().optional(),
      waitSeconds: z.number().min(0).max(120).optional(), idempotencyKey: IDEMPOTENCY },
    annotations: annotations(false),
  }, async (a) => run("gbk_render_composition", "gbk:renders.create", a as Record<string, unknown>, async (p) => {
    const user = p!.user;
    let snapshot: import("../../../src/workstation/model.ts").Project; let rowRev: number;
    if (a.revision !== undefined) {
      const rev = store.getRevision(a.compositionId, user, a.revision);
      const row = service.getRow(user, a.compositionId);
      if (!rev) throw new McpError("NOT_FOUND", `revision ${a.revision} not found for this composition`);
      snapshot = JSON.parse(rev.project_json); rowRev = a.revision;
      void row;
    } else { const got = service.getProject(user, a.compositionId); snapshot = got.project; rowRev = got.row.revision; }
    const row = service.getRow(user, a.compositionId);
    const config: RenderConfig = { ...DEFAULT_RENDER_CONFIG, sampleRate: a.sampleRate ?? 44100, channels: a.channels ?? 2, format: a.format ?? "pcm16",
      normalize: a.normalize ?? "loudness", targetLufs: a.targetLufs, tailSeconds: a.tailSeconds ?? 3, includeMidi: a.includeMidi ?? true };
    const job = renders.submit(user, { ...row, revision: rowRev }, snapshot, config);
    let final = job;
    if (a.waitSeconds) final = await renders.waitFor(user, job.id, a.waitSeconds * 1000);
    return { ...renders.jobView(user, final), ...(final.status !== "completed" ? { next: "Poll gbk_get_render_status with this jobId until status is completed/failed/cancelled." } : {}) };
  }));

  server.registerTool("gbk_get_render_status", {
    title: "Render status", description: "Progress, completion state, validation data and artifact references for a render job.",
    inputSchema: { accessToken: ACCESS_TOKEN, jobId: z.string().min(1).max(128), waitSeconds: z.number().min(0).max(120).optional() },
    annotations: annotations(true, true),
  }, async (a) => run("gbk_get_render_status", "gbk:artifacts.read", a as Record<string, unknown>, async (p) => {
    let job = renders.status(p!.user, a.jobId);
    if (a.waitSeconds) job = await renders.waitFor(p!.user, a.jobId, a.waitSeconds * 1000);
    return renders.jobView(p!.user, job);
  }));

  server.registerTool("gbk_cancel_render", {
    title: "Cancel a render", description: "Cancel a queued or running render job. No partial artifact is published for a cancelled job.",
    inputSchema: { accessToken: ACCESS_TOKEN, jobId: z.string().min(1).max(128) }, annotations: annotations(false, true),
  }, async (a) => run("gbk_cancel_render", "gbk:renders.create", a as Record<string, unknown>, async (p) => renders.jobView(p!.user, renders.cancel(p!.user, a.jobId))));

  server.registerTool("gbk_get_artifacts", {
    title: "Get artifacts", description: "Authorized download references (short-lived signed URLs, re-checked at access) and metadata for a composition's WAV and MIDI artifacts.",
    inputSchema: { compositionId: COMPOSITION_ID, accessToken: ACCESS_TOKEN }, annotations: annotations(true, true),
  }, async (a) => run("gbk_get_artifacts", "gbk:artifacts.read", a as Record<string, unknown>, async (p) => {
    service.getRow(p!.user, a.compositionId);
    const all = store.listArtifacts(a.compositionId, p!.user);
    const latest = store.latestArtifacts(a.compositionId, p!.user);
    return { compositionId: a.compositionId,
      latest: { ...(latest.wav ? { wav: artifactView(cfg, latest.wav) } : {}), ...(latest.midi ? { midi: artifactView(cfg, latest.midi) } : {}) },
      artifacts: all.map((x) => artifactView(cfg, x)) };
  }));

  // ---- studio / publishing -------------------------------------------------------------------------------
  server.registerTool("gbk_open_workstation", {
    title: "Open in GBK Studio", description: "Return a private read-only deep link that opens this exact composition revision in GBK Studio (private by default; Fork inside Studio to edit a copy there).",
    inputSchema: { compositionId: COMPOSITION_ID, accessToken: ACCESS_TOKEN }, annotations: annotations(true, true),
  }, async (a) => run("gbk_open_workstation", "gbk:compositions.read", a as Record<string, unknown>, async (p) => service.openWorkstation(p!.user, a.compositionId)));

  server.registerTool("gbk_publish_composition", {
    title: "Publish a composition", description: "Publish a composition as a public GBK share page. This is the ONLY tool that makes a composition public, and it must be called only when the user explicitly asks to publish/share publicly.",
    inputSchema: { compositionId: COMPOSITION_ID, accessToken: ACCESS_TOKEN }, annotations: annotations(false, true),
  }, async (a) => run("gbk_publish_composition", "gbk:shares.publish", a as Record<string, unknown>, async (p) => service.publish(p!.user, a.compositionId)));

  // ---- MCP Apps UI -----------------------------------------------------------------------------------------
  server.registerResource("gbk-composer-player", COMPOSER_UI_URI, {
    title: "GBK Composer player", description: "Interactive player and piano roll for a GBK composition.",
    mimeType: "text/html;profile=mcp-app",
  }, async () => ({ contents: [{ uri: COMPOSER_UI_URI, mimeType: "text/html;profile=mcp-app", text: COMPOSER_UI_HTML, _meta: { ui: { prefersBorder: true } } }] }));

  server.registerTool("gbk_show_composition_ui", {
    title: "Show the composition player", description: "Render the interactive GBK player (playback, seekable piano roll, track list, CC lanes, WAV/MIDI downloads, Studio link) for a composition inside the host. Call after creating/rendering when the user wants to listen or see the piano roll. Tools remain fully usable without this UI.",
    inputSchema: { compositionId: COMPOSITION_ID, accessToken: ACCESS_TOKEN },
    annotations: annotations(true, true),
    _meta: { ui: { resourceUri: COMPOSER_UI_URI }, "openai/outputTemplate": COMPOSER_UI_URI },
  }, async (a) => run("gbk_show_composition_ui", "gbk:compositions.read", a as Record<string, unknown>, async (p) => {
    const user = p!.user;
    const { row, project } = service.getProject(user, a.compositionId);
    const s = service.summary(row, project);
    const MAX_NOTES = 4000;
    const notes = project.notes.slice(0, MAX_NOTES).map((n) => ({ trackId: n.trackId, tick: n.tick, duration: n.duration, pitch: n.pitch, velocity: n.velocity }));
    const cc11 = new Map<string, { tick: number; value: number }[]>();
    for (const e of project.ccs) if (e.controller === 11) { const arr = cc11.get(e.trackId) ?? []; if (arr.length < 200) arr.push({ tick: e.tick, value: e.value }); cc11.set(e.trackId, arr); }
    const latest = store.latestArtifacts(a.compositionId, user);
    const opened = service.openWorkstation(user, a.compositionId);
    return {
      compositionId: row.id, revision: row.revision, title: s.title, key: s.key, style: s.style,
      tempoBpm: s.tempoBpm ?? 120, timeSignature: (s.timeSignature as [number, number]) ?? [4, 4], ppq: project.ppq,
      durationSec: s.durationSec, bars: s.bars, sections: s.sections,
      tracks: s.tracks.map((t) => ({ id: t.id, name: t.name, channel: t.channel, program: t.program ?? 0, noteCount: t.notes, mix: t.mix })),
      notes, notesTruncated: project.notes.length > MAX_NOTES,
      controllers: [...cc11.entries()].map(([trackId, points]) => ({ trackId, controller: 11, points })),
      artifacts: { ...(latest.wav ? { wav: { downloadUrl: artifactView(cfg, latest.wav).downloadUrl, sizeBytes: latest.wav.size_bytes, sha256: latest.wav.sha256,
          sampleRate: (JSON.parse(latest.wav.meta_json) as { sampleRate?: number }).sampleRate ?? 44100, channels: (JSON.parse(latest.wav.meta_json) as { channels?: number }).channels ?? 2,
          durationSeconds: (JSON.parse(latest.wav.meta_json) as { durationSeconds?: number }).durationSeconds ?? s.durationSec } } : {}),
        ...(latest.midi ? { midi: { downloadUrl: artifactView(cfg, latest.midi).downloadUrl, sizeBytes: latest.midi.size_bytes, sha256: latest.midi.sha256 } } : {}) },
      projectUrl: opened.url,
    };
  }));

  return server;
}
