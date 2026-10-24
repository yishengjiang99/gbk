// Remote MCP server for GBK Composer, built on the official @modelcontextprotocol/sdk (Streamable HTTP).
//
// Public surface = a small, user-goal-focused tool layer over CompositionService / RenderService. The
// canonical gbk_* registry stays the musical engine underneath (via the service); it is NOT mirrored 1:1
// here, so ChatGPT/Codex get deterministic operations, durable revisions and artifacts. Rendering runs in the in-chat player
// (gbk_widget_render_*, ui.ts) or is delegated to the user's
// connected Studio tab over the browser bridge (browser-render.ts); the server never synthesizes audio.
//
// Every tool returns structuredContent plus a JSON text fallback, uses typed domain errors, and enforces
// per-tool OAuth scopes. Mutating tools accept idempotencyKey: a replay with the same key + same request
// returns the original result; the same key with a different request is IDEMPOTENCY_CONFLICT.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { createHash, randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import type { McpStore, ArtifactRow } from "./store.ts";
import type { CompositionService, EditOperation } from "./service.ts";
import { RenderService, DEFAULT_RENDER_CONFIG, type RenderConfig } from "./browser-render.ts";
import { requireScope, type Principal, type Scope } from "./auth.ts";
import { McpError, toMcpError } from "./errors.ts";
import { signArtifactUrl } from "./urls.ts";
import { composerUiHtml, COMPOSER_UI_URI } from "./ui.ts";
import { MCP_SERVER_VERSION } from "./service-meta.ts";
import { guestCapability, guestOwner, resolveGuestCapability, GUEST_EDIT_SCOPES } from "./guest.ts";

export interface McpMetrics { calls: number; errors: number; authFailures: number; byTool: Record<string, number> }
/**
 * Mutable per-session authorization holder. Tool handlers read `current` at call time, so the routes
 * layer can rebind a session to the credentials presented on EACH request: a refreshed token with
 * narrower scopes takes effect immediately, and an anonymous session can upgrade to authenticated.
 * The session stays bound to one user — the holder is never switched to a different user.
 */
/** `client` = salted hash of the caller's IP for the current request (per-client guest caps; never stored raw). */
export interface SessionAuth { current: Principal | null; client?: string }
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
const ACCESS_TOKEN = z.string().min(1).max(256).optional().describe("Private project capability returned by gbk_create_composition when used without sign-in. Required on every follow-up call for that project (accessToken = edit; readAccessToken = read-only). The composition id alone grants nothing. Never show the edit token publicly or put it in a URL.");
const IDEMPOTENCY = z.string().min(8).max(128).optional().describe("Retry key: replays with the same key and same arguments return the original result instead of applying twice");

export function artifactView(cfg: Config, a: ArtifactRow) {
  const meta = JSON.parse(a.meta_json) as Record<string, unknown>;
  const signed = signArtifactUrl(cfg, a.id);
  return { artifactId: a.id, kind: a.kind, filename: a.filename, mimeType: a.mime_type, sizeBytes: a.size_bytes, sha256: a.sha256,
    revision: a.revision, downloadUrl: signed.url, downloadUrlExpiresAt: signed.expiresAt, meta };
}

export function createGbkMcpServer(ctx: McpContext): McpServer {
  const { cfg, store, service, renders, metrics } = ctx;
  // The MCP Apps player loads audio + downloads from the public origin (signed artifact URLs).
  // Sandboxed hosts enforce the resource CSP below — without these domains the player stays silent.
  const publicOrigin = new URL(cfg.publicOrigin).origin;
  const server = new McpServer({ name: "gbk-composer", version: MCP_SERVER_VERSION }, { capabilities: { tools: {}, resources: {} } });

  // Per-transport-session salt: guest create retries (same idempotencyKey) map to the same guest owner only
  // within this session; a key replayed from another session is never a credential.
  const guestSession = randomUUID();
  /** Resolve who is calling: an explicit project capability wins; else the account principal; else a new guest (create only). */
  function principalFor(tool: string, scope: Scope | null, args: Record<string, unknown>): Principal | null | { empty: true } {
    if (typeof args.accessToken === "string") {
      const g = resolveGuestCapability(cfg, store, args.accessToken);
      if (args.compositionId !== undefined && args.compositionId !== g.compositionId) throw new McpError("NOT_FOUND", "accessToken does not authorize this composition");
      return g;
    }
    const current = ctx.auth.current;
    if (current || !scope || !cfg.mcp.guestEnabled) return current;
    if (tool === "gbk_create_composition") return { user: guestOwner(cfg, guestSession, args.idempotencyKey as string | undefined), via: "guest", scopes: [...GUEST_EDIT_SCOPES] };
    if (tool === "gbk_list_compositions") return { empty: true };
    throw new McpError("NOT_FOUND", "private project: pass the accessToken returned by gbk_create_composition (the composition id alone grants no access), or sign in");
  }
  async function guestAdmission(tool: string, scope: Scope | null, p: Principal | null) {
    if (p?.via !== "guest" || !scope || scope === "gbk:compositions.read" || scope === "gbk:artifacts.read") return;
    // Per-client cap first, so one anonymous client cannot drain the shared global budget.
    if (tool === "gbk_create_composition" && !store.takeGuestBudget(`creates:${ctx.auth.client ?? "unknown"}`, cfg.mcp.guestCreatesPerClientPerDay)) throw new McpError("QUOTA_EXCEEDED", `account-free creation limit for this network reached (${cfg.mcp.guestCreatesPerClientPerDay} per day); retry tomorrow or sign in`);
    if (tool === "gbk_create_composition" && !store.takeGuestBudget("creates", cfg.mcp.guestCreatesPerDay)) throw new McpError("QUOTA_EXCEEDED", "the daily budget for account-free compositions is used up; retry tomorrow or sign in");
    if (!store.takeGuestBudget("mutations", cfg.mcp.guestMutationsPerDay)) throw new McpError("QUOTA_EXCEEDED", "the daily budget for account-free edits is used up; retry tomorrow or sign in");
  }
  /** Creation is the only response that ever carries the edit capability. */
  function present(tool: string, p: Principal | null, out: Record<string, unknown>): Record<string, unknown> {
    if (tool !== "gbk_create_composition" || p?.via !== "guest" || typeof out.compositionId !== "string") return out;
    const row = service.getRow(p.user, out.compositionId);
    return { ...out, accessToken: guestCapability(cfg, row, "edit"), readAccessToken: guestCapability(cfg, row, "read"),
      projectUrl: service.openWorkstation(p.user, row.id).url,
      accessNote: "No GBK account was used. Keep compositionId + accessToken private and pass accessToken on every follow-up call (it works in new sessions). readAccessToken and the Studio link are read-only. A lost accessToken cannot be recovered." };
  }

  async function run<T extends Record<string, unknown>>(tool: string, scope: Scope | null, args: Record<string, unknown>, fn: (p: Principal | null) => Promise<T>): Promise<ReturnType<typeof ok> | ReturnType<typeof fail>> {
    metrics.calls++; metrics.byTool[tool] = (metrics.byTool[tool] ?? 0) + 1;
    try {
      const who = principalFor(tool, scope, args);
      if (who && "empty" in who) return ok({ items: [], note: "Account-free projects have no directory: pass a project's accessToken to list it, or sign in to list account compositions." });
      const p = scope ? requireScope(who, scope) : who;
      const key = typeof args.idempotencyKey === "string" ? args.idempotencyKey : null;
      if (key && p) {
        const reqHash = createHash("sha256").update(JSON.stringify({ tool, args })).digest("hex");
        const prev = store.getIdempotent(p.user, key);
        if (prev) {
          if (prev.tool !== tool || prev.request_hash !== reqHash) throw new McpError("IDEMPOTENCY_CONFLICT", "idempotencyKey was already used with different arguments");
          return ok(present(tool, p, JSON.parse(prev.result_json) as Record<string, unknown>));
        }
        await guestAdmission(tool, scope, p);
        const out = await fn(p);
        store.putIdempotent(p.user, key, tool, reqHash, out);
        return ok(present(tool, p, out));
      }
      await guestAdmission(tool, scope, p);
      return ok(present(tool, p, await fn(p)));
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

  /** Everything a browser (in-chat player widget or Studio tab) needs to render audio locally. Read capability only. */
  function browserRenderFor(owner: string, compositionId: string, revision: number) {
    const row = service.getRow(owner, compositionId);
    return { mode: "browser", revision, widgetTool: "gbk_show_composition_ui", studioUrl: service.openWorkstation(owner, compositionId).url,
      snapshotUrl: `${publicOrigin}/api/mcp/guest/snapshot`, snapshotAuthHeader: "x-gbk-project-token", readAccessToken: guestCapability(cfg, row, "read") };
  }

  // ---- discovery (public, read-only) ----------------------------------------------------------------
  server.registerTool("gbk_get_capabilities", {
    title: "GBK capabilities", description: "Use this when you need to know what GBK Composer supports: the five styles (baroque, classical, pop, jazz, ambient), edit operations, instrument names and their SoundFont presets, audible MIDI controllers, render formats and per-account limits. Call it before composing instead of guessing. Read-only; no sign-in required.",
    inputSchema: {}, annotations: annotations(true, true),
  }, async () => run("gbk_get_capabilities", null, {}, async () => ({ capabilities: service.capabilities() })));

  // ---- compositions ----------------------------------------------------------------------------------
  server.registerTool("gbk_create_composition", {
    title: "Create a composition", description: "Use this when the user asks for a new piece of music. Creates a private, durable GBK composition with the deterministic, seeded arrangement engine (style, key, tempo, meter, bars or duration, instrumentation, voices, sections). Returns the composition id, revision, structure summary and Studio URL. Works without sign-in: then it also returns a private accessToken (edit) and readAccessToken that every follow-up call for this project must pass. No browser tab is required to compose. Rendering is a separate step: the in-chat player (gbk_show_composition_ui, Render button) renders audio in the user's browser with no Studio tab or sign-in, or gbk_render_composition uses a connected Studio tab.",
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
    title: "Get a composition", description: "Use this to inspect an existing composition before editing or describing it. Structured summary: sections, tracks, instrumentation, controllers, revision history. Optionally include paginated notes for a bar range.",
    inputSchema: { compositionId: COMPOSITION_ID, accessToken: ACCESS_TOKEN, startBar: z.number().int().min(1).optional(), endBar: z.number().int().min(1).optional(),
      includeNotes: z.boolean().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(1000).optional() },
    annotations: annotations(true, true),
  }, async (a) => run("gbk_get_composition", "gbk:compositions.read", a as Record<string, unknown>, async (p) => service.get(p!.user, a.compositionId, a)));

  server.registerTool("gbk_list_compositions", {
    title: "List your compositions", description: "Use this to find the user's existing GBK compositions (for example \"my last piece\"), most recently updated first. Returns ids, titles and revisions.",
    inputSchema: { accessToken: ACCESS_TOKEN, limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() },
    annotations: annotations(true, true),
  }, async (a) => run("gbk_list_compositions", "gbk:compositions.read", a as Record<string, unknown>, async (p) => ({ items: service.list(p!.user, a.limit, a.offset) })));

  server.registerTool("gbk_edit_composition", {
    title: "Edit a composition", description: "Use this when the user wants to change an existing composition. Applies typed, deterministic edit operations to one passage or aspect of an existing composition. Requires expectedRevision (optimistic concurrency): on STALE_REVISION, re-read with gbk_get_composition and retry. Operations: generate_part {track, startBar, endBar, kind: melody|bass|walking_bass|chords|arpeggio|alberti|drums|counterpoint, seed?}, transform_notes {track, startBar, endBar, transform: transpose|invert|retrograde|repeat|sequence|quantize|humanize|articulation|phrase_dynamics|variation, ...}, orchestrate {sourceTrack, targetTrack, startBar, endBar, semitones?, velocityScale?} (e.g. octave doubling), cc_curve {track|trackIds, controller, startBar, endBar, shape: crescendo|decrescendo|swell|linear|smoothstep|exponential, from?, to?, peak?}, note_patch {add?, remove?, update?}, cc_patch {track, controller, startBar, endBar, points:[{tick,value}]}, set_mix {track, volume?, pan?, expression?, mute?, solo?}, set_instrument {track, program, bankMsb?, bankLsb?}, set_tempo {bpm}, set_sections {sections}, generate_arrangement {style, ...}, generate_fugue_section {key, voices, atBar, ...}. Unrelated sections are left untouched; the result reports untouchedSectionsUnchanged.",
    inputSchema: { compositionId: COMPOSITION_ID, accessToken: ACCESS_TOKEN, expectedRevision: z.number().int().min(0),
      operations: z.array(z.record(z.string(), z.unknown())).min(1).max(32), idempotencyKey: IDEMPOTENCY },
    annotations: annotations(false),
  }, async (a) => run("gbk_edit_composition", "gbk:compositions.write", a as Record<string, unknown>, async (p) => {
    const { data } = await service.edit(p!.user, a.compositionId, a.expectedRevision, a.operations as EditOperation[], ctx.signal);
    return data;
  }));

  // ---- rendering --------------------------------------------------------------------------------------
  server.registerTool("gbk_render_composition", {
    title: "Render a composition", description: "Use this when the user wants audio or a MIDI file. Renders a saved composition revision to a validated WAV plus a Standard MIDI File. The server never synthesizes audio. Without sign-in (accessToken): MIDI is exported immediately and status is browser_render with a browserRender handoff (in-chat player via gbk_show_composition_ui, or a read-only Studio link) where audio renders in the user's browser. Signed-in: synthesis runs in the user's connected GBK Studio browser tab (canonical SF2 offline renderer); if no tab is connected, returns status studio_required. Then prefer the in-chat player: call gbk_show_composition_ui and tell the user to press Render in the player (it renders, plays and saves the WAV in their browser, no Studio tab or sign-in needed); opening studioUrl and calling again also works. Returns a durable job; with waitSeconds it waits up to that long and returns the completed result with authorized artifact URLs when the render finishes in time.",
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
    if (p!.via === "guest") {
      // Account-free: the server never synthesizes. Export MIDI now; audio renders in the user's browser.
      const job = renders.midiOnlyJob(user, { ...row, revision: rowRev }, snapshot, config, service.exportMidi(snapshot), cfg.mcp.guestRendersPerDay);
      return { ...renders.jobView(user, job), status: "browser_render", audio: "not rendered on the server",
        browserRender: browserRenderFor(user, row.id, rowRev),
        message: "MIDI is ready (signed download URL in artifacts). Audio renders only in a browser: call gbk_show_composition_ui to play/render it in the in-chat player, or give the user browserRender.studioUrl (read-only private link) to open GBK Studio and play or export WAV there. Never claim a WAV exists until one is listed." };
    }
    const sub = renders.submit(user, { ...row, revision: rowRev }, snapshot, config);
    if ("studioRequired" in sub) return { status: "studio_required", compositionId: a.compositionId, revision: rowRev, studioUrl: sub.studioUrl,
      inChatPlayer: { tool: "gbk_show_composition_ui", compositionId: a.compositionId },
      message: `Rendering runs in your browser and no GBK Studio tab is connected. Easiest: show the in-chat player (gbk_show_composition_ui) and press Render there - it renders, plays and saves the WAV right in this chat. Alternatively open the studio (${sub.studioUrl}), keep it open signed in, and call gbk_render_composition again.` };
    const job = sub.job;
    let final = job;
    if (a.waitSeconds) final = await renders.waitFor(user, job.id, a.waitSeconds * 1000);
    return { ...renders.jobView(user, final), ...(final.status !== "completed" ? { next: "Poll gbk_get_render_status with this jobId until status is completed/failed/cancelled." } : {}) };
  }));

  server.registerTool("gbk_get_render_status", {
    title: "Render status", description: "Use this to poll a render job started by gbk_render_composition: progress, completion state, validation data and artifact references.",
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
    title: "Get artifacts", description: "Use this when the user wants to download a composition's files. Authorized download references (short-lived signed URLs, re-checked at access) and metadata for a composition's WAV and MIDI artifacts.",
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
    title: "Open in GBK Studio", description: "Use this when the user wants to open or keep editing a composition in GBK Studio. (For audio, the in-chat player from gbk_show_composition_ui renders without a Studio tab.) Returns an authenticated deep link that opens this exact composition revision in GBK Studio (private by default; Fork inside Studio to edit a copy there).",
    inputSchema: { compositionId: COMPOSITION_ID, accessToken: ACCESS_TOKEN }, annotations: annotations(true, true),
  }, async (a) => run("gbk_open_workstation", "gbk:compositions.read", a as Record<string, unknown>, async (p) => service.openWorkstation(p!.user, a.compositionId)));

  server.registerTool("gbk_publish_composition", {
    title: "Publish a composition", description: "Publish a composition as a public GBK share page. This is the ONLY tool that makes a composition public, and it must be called only when the user explicitly asks to publish/share publicly.",
    inputSchema: { compositionId: COMPOSITION_ID, accessToken: ACCESS_TOKEN }, annotations: { ...annotations(false, true), openWorldHint: true },
  }, async (a) => run("gbk_publish_composition", "gbk:shares.publish", a as Record<string, unknown>, async (p) => service.publish(p!.user, a.compositionId)));

  server.registerTool("gbk_delete_composition", {
    title: "Delete a composition", description: "Use this only when the user explicitly asks to permanently delete an account-free (guest) composition. Requires that project's edit accessToken (the read token cannot delete). Removes the composition, its revisions, render jobs, MIDI/WAV files and private Studio link. Cannot be undone. Account compositions are deleted from GBK Studio instead.",
    inputSchema: { compositionId: COMPOSITION_ID, accessToken: ACCESS_TOKEN },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (a) => run("gbk_delete_composition", "gbk:compositions.write", a as Record<string, unknown>, async (p) => service.deleteGuest(p!.user, a.compositionId)));

  server.registerTool("gbk_claim_composition", {
    title: "Claim into your account", description: "Use this when a signed-in user wants to keep an account-free composition in their GBK account (recovery, library). Requires the session to be signed in (OAuth) AND the project's edit accessToken. Moves the project, its revisions and files to the account; the old access keys stop working.",
    inputSchema: { compositionId: COMPOSITION_ID, accessToken: z.string().min(1).max(256).describe("The project's edit accessToken") },
    annotations: annotations(false, true),
  }, async (a) => run("gbk_claim_composition", "gbk:compositions.write", a as Record<string, unknown>, async (p) => {
    const account = ctx.auth.current;
    if (!account || account.via === "guest") throw new McpError("UNAUTHENTICATED", "sign in to GBK (connect your account) to claim this project");
    requireScope(account, "gbk:compositions.write");
    return service.claim(p!.user, account.user, a.compositionId);
  }));

  // ---- MCP Apps UI -----------------------------------------------------------------------------------------
  server.registerResource("gbk-composer-player", COMPOSER_UI_URI, {
    title: "GBK Composer player", description: "Interactive player and piano roll for a GBK composition.",
    mimeType: "text/html;profile=mcp-app",
  }, async () => ({ contents: [{ uri: COMPOSER_UI_URI, mimeType: "text/html;profile=mcp-app", text: composerUiHtml(publicOrigin),
    // resourceDomains: renderer script, SF2 AudioWorklet module, signed WAV playback; connectDomains: SoundFont, snapshot
    // and WAV upload (CORS, capability token). The widget renders audio in the user's browser, never on the server.
    _meta: { ui: { prefersBorder: true, csp: { resourceDomains: [publicOrigin], connectDomains: [publicOrigin] } },
      "openai/widgetCSP": { resource_domains: [publicOrigin], connect_domains: [publicOrigin] }, "openai/widgetPrefersBorder": true,
      "openai/widgetDescription": "GBK player: piano roll, tracks, and a Render button that synthesizes the WAV in the user's browser, plays it and offers downloads." } }] }));

  server.registerTool("gbk_show_composition_ui", {
    title: "Show the composition player", description: "Use this when the user wants to listen to, see, or download a composition, especially when no GBK Studio tab is connected. Shows the interactive in-chat GBK player (piano roll, track list, CC lanes, Studio link) with a Render button that synthesizes the WAV in the user's own browser (SoundFont engine; no Studio tab or sign-in), then plays it and offers WAV/MIDI downloads; the WAV is also saved as an artifact. Tell the user to press Render in the player if no WAV exists yet. Tools remain fully usable without this UI.",
    inputSchema: { compositionId: COMPOSITION_ID, accessToken: ACCESS_TOKEN },
    annotations: annotations(true, true),
    _meta: { ui: { resourceUri: COMPOSER_UI_URI }, "openai/outputTemplate": COMPOSER_UI_URI, "openai/widgetAccessible": true },
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
      ...(p!.via === "guest" || user.startsWith("guest:") ? { browserRender: browserRenderFor(user, row.id, row.revision) } : {}),
    };
  }));

  // ---- in-chat player rendering (called by the widget, not the model) -----------------------------------------
  const appOnly = { ui: { visibility: ["app"] }, "openai/widgetAccessible": true, "openai/visibility": "private" };
  server.registerTool("gbk_widget_render_start", {
    title: "Start an in-chat player render", description: "Called by the GBK in-chat player when the user presses Render: creates a render job whose audio is synthesized in the user's browser, and returns the snapshot and upload endpoints. Not for the model.",
    inputSchema: { compositionId: COMPOSITION_ID, accessToken: ACCESS_TOKEN, revision: z.number().int().min(0).optional() },
    annotations: annotations(false), _meta: appOnly,
  }, async (a) => {
    const r = await run("gbk_widget_render_start", "gbk:renders.create", a as Record<string, unknown>, async (p) => {
      const user = p!.user;
      const got = service.getProject(user, a.compositionId);
      let snapshot = got.project; let rev = got.row.revision;
      if (a.revision !== undefined && a.revision !== rev) {
        const old = store.getRevision(a.compositionId, user, a.revision);
        if (!old) throw new McpError("NOT_FOUND", `revision ${a.revision} not found for this composition`);
        snapshot = JSON.parse(old.project_json); rev = a.revision;
      }
      const s = renders.submitWidget(user, { ...got.row, revision: rev }, snapshot, { ...DEFAULT_RENDER_CONFIG }, p!.via === "guest" ? cfg.mcp.guestRendersPerDay : undefined);
      return { jobId: s.job.id, compositionId: a.compositionId, revision: rev, token: s.token, snapshotUrl: s.snapshotUrl, uploadUrl: s.uploadUrl, chunkBytes: s.chunkBytes, options: s.options };
    });
    return r;
  });

  server.registerTool("gbk_widget_render_finish", {
    title: "Finish an in-chat player render", description: "Called by the GBK in-chat player after it uploaded the browser-rendered WAV (or failed/stopped): the server verifies SHA-256, WAV header and validation, then publishes WAV + MIDI artifacts. Not for the model.",
    inputSchema: { accessToken: ACCESS_TOKEN, jobId: z.string().min(1).max(128), token: z.string().min(16).max(128), ok: z.boolean(),
      meta: z.record(z.string(), z.unknown()).optional(), errorCode: z.string().max(64).optional(), errorMessage: z.string().max(2000).optional() },
    annotations: annotations(false, true), _meta: appOnly,
  }, async (a) => run("gbk_widget_render_finish", "gbk:renders.create", { jobId: a.jobId, ok: a.ok, ...(a.accessToken ? { accessToken: a.accessToken } : {}) } as Record<string, unknown>, async (p) => {
    const job = renders.finishWidget(p!.user, a.jobId, a.token, a.ok ? { ok: true, meta: a.meta ?? {} } : { ok: false, code: a.errorCode ?? "RENDER_FAILED", message: a.errorMessage ?? "the in-chat player reported a failure" });
    const view = renders.jobView(p!.user, job);
    const wav = view.artifacts.find((x) => x.kind === "wav"); const midi = view.artifacts.find((x) => x.kind === "midi");
    return { ...view, ...(wav || midi ? { latest: { ...(wav ? { wav: { downloadUrl: wav.downloadUrl, sizeBytes: wav.sizeBytes, sha256: wav.sha256 } } : {}), ...(midi ? { midi: { downloadUrl: midi.downloadUrl, sizeBytes: midi.sizeBytes, sha256: midi.sha256 } } : {}) } } : {}) };
  }));

  return server;
}
