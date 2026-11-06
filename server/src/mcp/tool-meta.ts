// Per-tool safety hints, review justifications and output schemas for the public MCP surface.
// Single source for server.ts and server/test/mcp-annotations.test.ts.
import { z } from "zod/v3";

export interface ToolHints { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
const h = (readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean): ToolHints =>
  ({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint });

/** Hints + one-line behavior justification. Order: readOnly / destructive / idempotent / openWorld. */
export const TOOL_HINTS: Record<string, { hints: ToolHints; why: string }> = {
  gbk_get_capabilities: { hints: h(true, false, true, false), why: "Returns static feature, limit and SoundFont catalog data; writes nothing (only in-memory call counters and server logs)." },
  gbk_list_soundfonts: { hints: h(true, false, true, false), why: "Reads the pinned local SoundFont catalog and checks which fonts are installed; downloads and writes nothing." },
  gbk_create_composition: { hints: h(false, false, false, true), why: "Creates a new private composition (never overwrites one); importShareSlug can copy any user's public GBK share, so the input set is open-ended public content. Each call without a reused idempotencyKey creates another composition." },
  gbk_get_composition: { hints: h(true, false, true, false), why: "Reads one authorized composition, its revision list and optional notes; changes nothing." },
  gbk_list_compositions: { hints: h(true, false, true, false), why: "Lists the caller's own compositions (or the one a capability unlocks); changes nothing." },
  gbk_edit_composition: { hints: h(false, true, false, false), why: "Writes a new revision; for signed-in accounts it then permanently deletes the oldest revision snapshots beyond the plan's history limit. A repeat with the same expectedRevision fails STALE_REVISION rather than reapplying." },
  gbk_render_composition: { hints: h(false, false, false, false), why: "Starts a new render job and stores new private WAV/MIDI artifacts; never overwrites or publishes. Each call starts another job (and counts against render quota) unless an idempotencyKey is replayed." },
  gbk_get_render_status: { hints: h(true, false, true, false), why: "Reads (optionally waits on) an existing render job; never starts, cancels or changes it." },
  gbk_cancel_render: { hints: h(false, true, true, false), why: "Stops a queued/running render and discards its partial output; repeating it on a terminal job changes nothing." },
  gbk_get_artifacts: { hints: h(true, false, true, false), why: "Returns metadata and short-lived signed download URLs for existing artifacts; creates no files." },
  gbk_open_workstation: { hints: h(false, true, true, true), why: "Creates or overwrites the composition's Studio share snapshot; if that share was already published, its public page content is replaced. Repeating with the same revision rewrites identical content and returns the same link." },
  gbk_publish_composition: { hints: h(false, true, true, true), why: "Overwrites the share snapshot and makes it publicly accessible (no unpublish tool). Repeating it leaves the same public page." },
  gbk_delete_composition: { hints: h(false, true, true, true), why: "Permanently deletes a guest composition, revisions, jobs, files and every share page for it, including a published public one. A repeat returns NOT_FOUND and deletes nothing more." },
  gbk_claim_composition: { hints: h(false, true, true, true), why: "Moves a guest composition and its shares (public ones included, changing their public owner) into the account and revokes the old access tokens. A repeat fails because the guest token no longer resolves." },
  gbk_show_composition_ui: { hints: h(false, true, true, true), why: "Returns the in-chat player, and first creates or overwrites the Studio share snapshot (replacing public content if that share was published). Repeating with the same revision rewrites identical content." },
  gbk_widget_render_start: { hints: h(false, false, false, false), why: "App-only: creates a new render job and empty partial-upload file for a user-pressed Render; each call starts another job." },
  gbk_widget_render_finish: { hints: h(false, true, true, false), why: "App-only: on success stores validated WAV/MIDI artifacts; on failure or stop it irreversibly discards the partial upload. The job token is single-use, so a repeat returns NOT_FOUND with no further effect." },
};

const nul = <T extends z.ZodTypeAny>(t: T) => t.nullable();
const any = z.record(z.string(), z.unknown());
const artifact = z.object({ artifactId: z.string(), kind: z.string(), filename: z.string(), mimeType: z.string(), sizeBytes: z.number(), sha256: z.string(),
  revision: z.number().optional(), downloadUrl: z.string(), downloadUrlExpiresAt: z.string(), meta: any });
const fileRef = z.object({ downloadUrl: z.string(), sizeBytes: z.number(), sha256: z.string() });
const job = {
  jobId: z.string(), compositionId: z.string(), revision: z.number(), status: z.string().describe("queued | running | completed | failed | cancelled"),
  progress: z.number(), config: any, error: nul(z.object({ code: z.string(), message: z.string() })), createdAt: z.string(), finishedAt: nul(z.string()), artifacts: z.array(artifact),
};
const lean = {
  compositionId: z.string(), projectId: z.string(), title: z.string(), revision: z.number(), createdAt: z.string(), updatedAt: z.string(),
  visibility: z.string(), source: nul(z.string()), key: nul(z.string()), style: nul(z.string()), seed: nul(z.number()), ppq: z.number(),
  tempoBpm: nul(z.number()), tempos: z.array(z.object({ tick: z.number(), bpm: z.number() })), timeSignature: nul(z.array(z.number())), timeSigs: z.array(any),
  bars: z.number(), durationSec: z.number(), endTick: z.number(), noteCount: z.number(), ccCount: z.number(), sections: z.array(any),
  tracks: z.array(any), projectUrl: nul(z.string()),
};
const revisions = z.array(z.object({ revision: z.number(), summary: z.string(), created_at: z.number() }));
const summary = { ...lean, revisions };
const browserRender = z.object({ mode: z.literal("browser"), revision: z.number(), widgetTool: z.string(), studioUrl: z.string(), snapshotUrl: z.string(),
  snapshotAuthHeader: z.string(), readAccessToken: z.string() });
const guestCreds = { accessToken: z.string().optional(), readAccessToken: z.string().optional(), projectUrl: nul(z.string()), accessNote: z.string().optional() };
const link = { url: z.string(), slug: z.string() };

/** structuredContent shape per tool (all success variants; errors return isError without structuredContent). */
export const OUTPUT_SCHEMAS = {
  gbk_get_capabilities: { capabilities: any },
  gbk_list_soundfonts: { fonts: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), bytes: z.number(), license: z.string(),
    delivery: z.enum(["bundled", "server"]), file: z.string(), path: z.string(), default: z.boolean(), active: z.boolean(), available: z.boolean(), info: any.optional() })), defaultFontId: z.string() },
  // Generated (generation, createdProjectId) or imported (imported: true); guest calls add the private capabilities.
  gbk_create_composition: { ...summary, ...guestCreds, generation: any.optional(), createdProjectId: z.string().optional(), imported: z.literal(true).optional() },
  gbk_get_composition: { ...summary, notes: z.object({ total: z.number(), offset: z.number(), nextOffset: nul(z.number()),
    items: z.array(z.object({ id: z.string(), trackId: z.string(), tick: z.number(), duration: z.number(), pitch: z.number(), velocity: z.number() })) }).optional() },
  // Account-free sessions without a capability get an empty list plus a note.
  gbk_list_compositions: { items: z.array(z.object(lean)), note: z.string().optional() },
  gbk_edit_composition: { ...summary, appliedOperations: z.array(any), previousRevision: z.number(), untouchedSectionsUnchanged: nul(z.boolean()), noChange: z.boolean().optional() },
  // Job view (server/Studio/MIDI-only browser_render) or status "studio_required" with no job.
  gbk_render_composition: z.object(job).partial().extend({
    status: z.string().describe("queued | running | completed | failed | cancelled | browser_render | studio_required"), compositionId: z.string(), revision: z.number(),
    renderedOn: z.literal("server").optional(), message: z.string().optional(), next: z.string().optional(), audio: z.string().optional(), browserRender: browserRender.optional(),
    studioUrl: z.string().optional(), inChatPlayer: z.object({ tool: z.string(), compositionId: z.string() }).optional(),
  }).shape,
  gbk_get_render_status: job,
  gbk_cancel_render: job,
  gbk_get_artifacts: { compositionId: z.string(), latest: z.object({ wav: artifact.optional(), midi: artifact.optional() }), artifacts: z.array(artifact) },
  gbk_open_workstation: { ...link, note: z.string() },
  gbk_publish_composition: link,
  gbk_delete_composition: { deleted: z.literal(true), compositionId: z.string() },
  gbk_claim_composition: { ...summary, claimed: z.literal(true), note: z.string() },
  gbk_show_composition_ui: {
    compositionId: z.string(), revision: z.number(), title: z.string(), key: nul(z.string()), style: nul(z.string()), tempoBpm: z.number(), timeSignature: z.array(z.number()),
    ppq: z.number(), durationSec: z.number(), bars: z.number(), sections: z.array(any),
    tracks: z.array(z.object({ id: z.string(), name: z.string(), channel: z.number(), program: z.number(), noteCount: z.number(), mix: any.optional() })),
    notes: z.array(z.object({ trackId: z.string(), tick: z.number(), duration: z.number(), pitch: z.number(), velocity: z.number() })), notesTruncated: z.boolean(),
    controllers: z.array(z.object({ trackId: z.string(), controller: z.number(), points: z.array(z.object({ tick: z.number(), value: z.number() })) })),
    artifacts: z.object({ wav: fileRef.extend({ sampleRate: z.number(), channels: z.number(), durationSeconds: z.number() }).optional(), midi: fileRef.optional() }),
    projectUrl: z.string(), browserRender: browserRender.optional(),
  },
  gbk_widget_render_start: { jobId: z.string(), compositionId: z.string(), revision: z.number(), token: z.string(), snapshotUrl: z.string(), uploadUrl: z.string(), chunkBytes: z.number(), options: any },
  gbk_widget_render_finish: { ...job, latest: z.object({ wav: fileRef.optional(), midi: fileRef.optional() }).optional() },
} satisfies Record<keyof typeof TOOL_HINTS, z.ZodRawShape>;
