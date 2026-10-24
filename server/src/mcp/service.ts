// CompositionService: the shared application service behind the remote MCP tools.
//
// It reuses the canonical GBK tool registry (buildAllTools / runTool) against a fresh WorkstationController
// per call — exactly the code the browser workstation and WebMCP run — and persists the resulting canonical
// serialized Project to the durable MCP store with revision compare-and-swap. No second musical state model,
// no server-side LLM: the calling model supplies the reasoning, these are deterministic operations.
import { createHash } from "node:crypto";
import { WorkstationController } from "../../../src/workstation/controller.ts";
import { runTool, type ToolDef, type ToolResult } from "../../../src/webmcp/tools.ts";
import { buildAllTools as buildRegistry } from "../../../src/webmcp/registry.ts";
import { tickToSec, tickToBarBeat, barBeatToTick } from "../../../src/workstation/timing.ts";
import type { Project } from "../../../src/workstation/model.ts";
import { STRATEGIES } from "../../../src/music/arrangement.ts";
import { INSTRUMENTS } from "../../../src/music/compose.ts";
import { parseSoundFont, primeSoundFontCache, defaultSoundFontUrl } from "../../../src/audio/soundfont-loader.ts";
import { readFileSync } from "node:fs";
import type { Config } from "../config.ts";
import type { ShareStore } from "../persistence/shares.ts";
import { McpStore, type CompositionRow } from "./store.ts";
import { McpError, toMcpError } from "./errors.ts";
import { resolveSoundFontPath } from "./browser-render.ts";

export { RENDERER_VERSION } from "./service-meta.ts";
import { RENDERER_VERSION } from "./service-meta.ts";

export interface CreateCompositionArgs {
  title: string; style?: string; mood?: string; key?: string; tempo?: number;
  timeSignature?: [number, number]; bars?: number; durationSeconds?: number;
  instrumentation?: string[]; voices?: 3 | 4; complexity?: number; seed?: number;
  sections?: { name: string; startBar: number; bars: number; energy?: number }[];
}
export interface EditOperation {
  type: "generate_part" | "transform_notes" | "orchestrate" | "cc_curve" | "note_patch" | "cc_patch"
    | "set_mix" | "set_instrument" | "set_tempo" | "set_sections" | "generate_arrangement" | "generate_fugue_section";
  [k: string]: unknown;
}

const sha256Of = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const RANGE = (a: Record<string, unknown>) => ({ unit: "bars", start: a.startBar as number, end: a.endBar as number });

export class CompositionService {
  private tools: ToolDef[] | null = null;
  constructor(private cfg: Config, private store: McpStore, private shares: ShareStore, private log: (o: object) => void = () => {}) {
    // Prime the SoundFont cache so canonical tools resolve instruments instead of warning "not loaded".
    try {
      const path = resolveSoundFontPath(cfg);
      const sf = parseSoundFont(new Uint8Array(readFileSync(path)), defaultSoundFontUrl(), "GeneralUser-GS.sf2");
      primeSoundFontCache(defaultSoundFontUrl(), sf.sf, sf.label);
    } catch (e) { this.log({ evt: "mcp_soundfont_prime_failed", message: (e as Error).message }); }
  }

  // ---- canonical tool plumbing ---------------------------------------------------
  private controllerFor(project?: Project): { c: WorkstationController; tools: Map<string, ToolDef> } {
    const c = new WorkstationController(project ?? undefined);
    if (project) c.load(structuredClone(project));
    const tools = new Map(buildRegistry(c).map((t) => [t.name, t]));
    return { c, tools };
  }
  private async call(tools: Map<string, ToolDef>, c: WorkstationController, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const t = tools.get(name);
    if (!t) throw new McpError("INTERNAL_ERROR", `canonical tool ${name} missing from registry`);
    // Canonical validation treats an explicit undefined as a type error; JSON callers never send one.
    const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
    const r = await runTool(c, t, clean, signal);
    if (!r.ok) throw toMcpError(Object.assign(new Error(r.error?.message ?? `${name} failed`), { code: r.error?.code, details: r.error?.details }));
    return r;
  }
  /** Propose-based canonical tools: commit immediately when a pending proposal comes back (autonomous session).
   *  Canonical shapes differ: compose/music tools report { committed:false, proposalId }, core patch/curve
   *  tools return proposalView { proposalId, status:"pending" } with no committed flag. Handle both. */
  private async callAndCommit(tools: Map<string, ToolDef>, c: WorkstationController, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const r = await this.call(tools, c, name, args, signal);
    const d = r.data as { committed?: boolean; proposalId?: string; status?: string } | undefined;
    if (d?.proposalId && d.committed !== true && (d.status === undefined || d.status === "pending")) {
      return this.call(tools, c, "gbk_commit_proposal", { proposalId: d.proposalId }, signal);
    }
    return r;
  }

  // ---- views -----------------------------------------------------------------------
  summary(row: CompositionRow, project?: Project) {
    const p = project ?? (JSON.parse(row.project_json) as Project);
    const prog0 = (t: string) => p.programs.filter((g) => g.trackId === t).sort((a, b) => a.tick - b.tick)[0];
    return {
      compositionId: row.id, projectId: p.id, title: p.name, revision: row.revision,
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
      visibility: row.visibility, source: row.source,
      key: p.meta?.key ?? null, style: p.meta?.style ?? null, seed: p.meta?.seed ?? null,
      ppq: p.ppq, tempoBpm: p.tempos.length ? Math.round(60e6 / p.tempos[0].microPerQuarter) : null,
      tempos: p.tempos.map((t) => ({ tick: t.tick, bpm: Math.round(60e6 / t.microPerQuarter) })),
      timeSignature: p.timeSigs.length ? [p.timeSigs[0].numerator, p.timeSigs[0].denominator] : null,
      timeSigs: p.timeSigs, bars: tickToBarBeat(p, p.endTick).bar, durationSec: +tickToSec(p, p.endTick).toFixed(3),
      endTick: p.endTick, noteCount: p.notes.length, ccCount: p.ccs.length,
      sections: p.meta?.sections ?? [],
      tracks: p.tracks.map((t) => ({ id: t.id, name: t.name, channel: t.channel, role: t.role ?? null, mix: t.mix,
        program: prog0(t.id)?.program ?? null, bank: prog0(t.id)?.bankMsb ?? null,
        notes: p.notes.filter((n) => n.trackId === t.id).length,
        controllers: [...new Set(p.ccs.filter((e) => e.trackId === t.id).map((e) => e.controller))].sort((a, b) => a - b) })),
      revisions: this.store.listRevisions(row.id, row.owner),
      projectUrl: `${this.cfg.publicOrigin}/studio?mcp=${row.id}`,
    };
  }
  getRow(owner: string, compositionId: string): CompositionRow {
    const row = this.store.getComposition(compositionId, owner);
    if (!row) throw new McpError("NOT_FOUND", "no such composition for this account (ids are owner-scoped)");
    return row;
  }
  getProject(owner: string, compositionId: string): { row: CompositionRow; project: Project } {
    const row = this.getRow(owner, compositionId);
    return { row, project: JSON.parse(row.project_json) as Project };
  }

  capabilities() {
    return {
      server: "GBK Composer MCP", rendererVersion: RENDERER_VERSION,
      styles: Object.keys(STRATEGIES),
      compositionModes: ["generate_arrangement (seeded, deterministic)", "generate_part", "transform_notes", "orchestrate", "cc_curve", "note_patch", "fugue_section (baroque, Bach generator)"],
      instruments: Object.entries(INSTRUMENTS).map(([name, s]) => ({ name, preset: s.name, program: s.program, role: s.role, family: s.family })),
      soundFont: "GeneralUser GS (bundled); pipe organ = GM program 19 (instrument name 'organ')",
      renderFormats: { sampleRates: [44100, 48000], channels: [1, 2], formats: ["pcm16", "float32"], normalize: ["loudness", "peak", "off"], targetLufsRange: [-40, -5], peakCeilingDbTp: -1, maxRenderSeconds: this.cfg.mcp.maxRenderSeconds },
      controllers: { audible: [1, 7, 10, 11, 64, 66, 67, 91, 93], storedOnly: [71, 74], note: "all CC 0-127 are preserved and exported to MIDI" },
      limits: { maxCompositionsPerUser: this.cfg.mcp.maxCompositions, maxRendersPerDay: this.cfg.mcp.maxRendersPerDay, renderExecutor: "browser (connected GBK Studio tab)" },
      deterministic: "same project snapshot + renderer version + SoundFont + seed + render config => byte-identical WAV (SHA-256 recorded per artifact)",
      unsupported: ["arbitrary JavaScript/filesystem/shell access", "per-preset effect types beyond the built-in reverb/chorus", "SMPTE time division"],
    };
  }

  // ---- create ------------------------------------------------------------------------
  async create(owner: string, a: CreateCompositionArgs, signal: AbortSignal): Promise<{ row: CompositionRow; data: Record<string, unknown> }> {
    if (this.store.countCompositions(owner) >= this.cfg.mcp.maxCompositions) throw new McpError("QUOTA_EXCEEDED", `composition limit reached (${this.cfg.mcp.maxCompositions})`);
    const style = a.style ?? "classical";
    if (!STRATEGIES[style]) throw new McpError("INVALID_ARGUMENT", `style must be one of ${Object.keys(STRATEGIES).join(", ")}`);
    const tempo = a.tempo ?? 108;
    const [num] = a.timeSignature ?? [4, 4];
    let bars = a.bars;
    if (!bars && a.durationSeconds) bars = Math.max(4, Math.round((a.durationSeconds * tempo / 60) / num));
    bars = Math.min(512, Math.max(1, bars ?? 32));
    const { c, tools } = this.controllerFor();
    const created = await this.call(tools, c, "gbk_create_project", {
      name: a.title.slice(0, 128), tempo, timeSignature: a.timeSignature ?? [4, 4], key: a.key,
      replaceCurrent: true, descriptors: { ...(a.mood ? { mood: a.mood.slice(0, 120) } : {}), style, via: "mcp" },
    }, signal);
    if (a.sections?.length) await this.call(tools, c, "gbk_set_song_structure", { sections: a.sections }, signal);
    const gen = await this.call(tools, c, "gbk_generate_arrangement", {
      style, key: a.key, tempo, bars, seed: a.seed ?? 1, voices: a.voices ?? 4, complexity: a.complexity ?? 3,
      ...(a.instrumentation?.length ? { instrumentation: a.instrumentation } : {}),
    }, signal);
    const project = c.project;
    const row = this.store.createComposition({ owner, title: project.name, projectJson: JSON.stringify(project), revision: project.revision, source: "mcp" });
    this.log({ evt: "mcp_composition_create", user: owner, compositionId: row.id, revision: row.revision });
    return { row, data: { ...this.summary(row, project), generation: gen.data, createdProjectId: (created.data as { projectId: string }).projectId } };
  }

  /** Import a GBK Studio project the user explicitly saved/shared (private autosave or public share). */
  importFromShare(owner: string, slug: string): { row: CompositionRow; data: Record<string, unknown> } {
    const share = this.shares.bySlug(slug);
    if (!share || (!share.public && share.owner !== owner)) throw new McpError("NOT_FOUND", "no such saved Studio project for this account");
    const project = JSON.parse(share.project_json) as Project;
    project.meta = { ...(project.meta ?? {}), owner: "agent" }; // explicit import => MCP-editable copy; the Studio original is untouched
    const row = this.store.createComposition({ owner, title: project.name || share.title, projectJson: JSON.stringify(project), revision: project.revision ?? 0, source: "studio-import" });
    return { row, data: this.summary(row, project) };
  }

  // ---- read ---------------------------------------------------------------------------
  get(owner: string, compositionId: string, opts: { startBar?: number; endBar?: number; offset?: number; limit?: number; includeNotes?: boolean } = {}) {
    const { row, project: p } = this.getProject(owner, compositionId);
    const out: Record<string, unknown> = { ...this.summary(row, p) };
    if (opts.includeNotes) {
      const startTick = opts.startBar ? barBeatToTick(p, opts.startBar) : 0;
      const endTick = opts.endBar ? barBeatToTick(p, opts.endBar + 1) : Infinity;
      const all = p.notes.filter((n) => n.tick + n.duration > startTick && n.tick < endTick);
      const offset = opts.offset ?? 0, limit = Math.min(1000, Math.max(1, opts.limit ?? 200));
      out.notes = { total: all.length, offset, nextOffset: offset + limit < all.length ? offset + limit : null,
        items: all.slice(offset, offset + limit).map((n) => ({ id: n.id, trackId: n.trackId, tick: n.tick, duration: n.duration, pitch: n.pitch, velocity: n.velocity })) };
    }
    return out;
  }
  list(owner: string, limit = 30, offset = 0) {
    return this.store.listCompositions(owner, Math.min(100, Math.max(1, limit)), Math.max(0, offset)).map((r) => {
      const s = this.summary(r); const { revisions: _r, ...lean } = s; return lean;
    });
  }

  // ---- edit ------------------------------------------------------------------------------
  async edit(owner: string, compositionId: string, expectedRevision: number, operations: EditOperation[], signal: AbortSignal): Promise<{ row: CompositionRow; data: Record<string, unknown> }> {
    const { row, project } = this.getProject(owner, compositionId);
    if (row.revision !== expectedRevision) throw new McpError("STALE_REVISION", `expectedRevision ${expectedRevision} does not match current revision ${row.revision}; re-read the composition and retry`, { currentRevision: row.revision });
    if (!operations.length || operations.length > 32) throw new McpError("INVALID_ARGUMENT", "operations must contain 1..32 typed edit operations");
    const { c, tools } = this.controllerFor(project);
    if (!c.resumeAutonomousSession("remote MCP edit")) throw new McpError("USER_APPROVAL_REQUIRED", "this project is user-owned; import it into MCP (gbk_create_composition with importShareSlug) or edit it in GBK Studio where edits go through Accept");
    const before = structuredClone(project);
    const appliedOps: Record<string, unknown>[] = [];
    for (const op of operations) {
      const label = await this.applyOp(tools, c, op, signal);
      appliedOps.push({ type: op.type, ...label });
    }
    const after = c.project;
    if (after.revision === expectedRevision) {
      // Every operation was a no-op (e.g. removing notes that do not exist): nothing to persist, and a
      // duplicate revision row must not be written.
      return { row, data: { ...this.summary(row, after), appliedOperations: appliedOps, previousRevision: expectedRevision, noChange: true, untouchedSectionsUnchanged: true } };
    }
    const saved = this.store.saveRevision({ id: row.id, owner, title: after.name, projectJson: JSON.stringify(after), expectedRevision, newRevision: after.revision, summary: appliedOps.map((o) => String(o.type)).join(", ").slice(0, 200) || "edit" });
    if (!saved) { const cur = this.store.getComposition(row.id, owner); throw new McpError("PROJECT_CHANGED", "the composition changed while this edit was running; re-read and retry", { currentRevision: cur?.revision }); }
    // Untouched-material proof for the caller: note-level diff counts outside the edited ranges.
    const ranges = operations.filter((o) => typeof o.startBar === "number").map((o) => ({ start: barBeatToTick(after, o.startBar as number), end: barBeatToTick(after, (o.endBar as number) + 1) }));
    const outside = (p: Project) => p.notes.filter((n) => !ranges.some((r) => n.tick >= r.start && n.tick < r.end)).map((n) => `${n.trackId}:${n.tick}:${n.pitch}:${n.duration}:${n.velocity}`).sort().join("|");
    const untouchedUnchanged = ranges.length ? sha256Of(outside(before)) === sha256Of(outside(after)) : null;
    this.log({ evt: "mcp_composition_edit", user: owner, compositionId: row.id, fromRevision: expectedRevision, toRevision: after.revision, ops: operations.length });
    return { row: saved, data: { ...this.summary(saved, after), appliedOperations: appliedOps, previousRevision: expectedRevision, untouchedSectionsUnchanged: untouchedUnchanged } };
  }

  private async applyOp(tools: Map<string, ToolDef>, c: WorkstationController, op: EditOperation, signal: AbortSignal): Promise<Record<string, unknown>> {
    const rev = () => c.project.revision;
    switch (op.type) {
      case "generate_part": {
        const r = await this.call(tools, c, "gbk_generate_part", { trackId: op.track, range: RANGE(op), kind: op.kind, seed: op.seed, key: op.key, progression: op.progression, againstTrackId: op.againstTrack, low: op.low, high: op.high, velocity: op.velocity, baseRevision: rev() }, signal);
        return { notes: (r.data as { notes?: number }).notes };
      }
      case "transform_notes": {
        const r = await this.call(tools, c, "gbk_transform_notes", { trackId: op.track, range: RANGE(op), transform: op.transform, semitones: op.semitones, axis: op.axis, times: op.times, grid: op.grid, strength: op.strength, amount: op.amount, timing: op.timing, articulation: op.articulation, variation: op.variation, phraseBars: op.phraseBars, seed: op.seed, baseRevision: rev() }, signal);
        return r.data as Record<string, unknown>;
      }
      case "orchestrate": {
        const r = await this.call(tools, c, "gbk_orchestrate", { sourceTrackId: op.sourceTrack, targetTrackId: op.targetTrack, range: RANGE(op), semitones: op.semitones, velocityScale: op.velocityScale, baseRevision: rev() }, signal);
        return r.data as Record<string, unknown>;
      }
      case "cc_curve": {
        const r = await this.callAndCommit(tools, c, "gbk_generate_cc_curve", { trackIds: op.trackIds ?? (op.track ? [op.track] : []), controller: op.controller, range: RANGE(op), shape: op.shape, from: op.from, to: op.to, peak: op.peak, exponent: op.exponent, mode: op.mode ?? "replace", summary: op.summary, baseRevision: rev() }, signal);
        return r.data as Record<string, unknown>;
      }
      case "note_patch": {
        const r = await this.callAndCommit(tools, c, "gbk_propose_note_patch", { add: op.add, remove: op.remove, update: op.update, summary: op.summary, baseRevision: rev() }, signal);
        return r.data as Record<string, unknown>;
      }
      case "cc_patch": {
        const r = await this.callAndCommit(tools, c, "gbk_propose_cc_patch", { trackId: op.track, controller: op.controller, range: RANGE(op), mode: op.mode ?? "replace", points: op.points, summary: op.summary, baseRevision: rev() }, signal);
        return r.data as Record<string, unknown>;
      }
      case "set_mix": {
        const r = await this.call(tools, c, "gbk_set_track_mix", { trackId: op.track, mode: "default", volume: op.volume, pan: op.pan, expression: op.expression, mute: op.mute, solo: op.solo, baseRevision: rev() }, signal);
        return r.data as Record<string, unknown>;
      }
      case "set_instrument": {
        const r = await this.call(tools, c, "gbk_set_instrument", { trackId: op.track, program: op.program, bankMsb: op.bankMsb, bankLsb: op.bankLsb, baseRevision: rev() }, signal);
        return r.data as Record<string, unknown>;
      }
      case "set_tempo": {
        const r = await this.call(tools, c, "gbk_set_tempo_map", { events: [{ bar: 1, bpm: op.bpm }], baseRevision: rev() }, signal);
        return r.data as Record<string, unknown>;
      }
      case "set_sections": {
        const r = await this.call(tools, c, "gbk_set_song_structure", { sections: op.sections, baseRevision: rev() }, signal);
        return r.data as Record<string, unknown>;
      }
      case "generate_arrangement": {
        const r = await this.call(tools, c, "gbk_generate_arrangement", { style: op.style, key: op.key, tempo: op.tempo, bars: op.bars, seed: op.seed, voices: op.voices, complexity: op.complexity, instrumentation: op.instrumentation, baseRevision: rev() }, signal);
        return r.data as Record<string, unknown>;
      }
      case "generate_fugue_section": {
        // NB: this canonical tool's schema has no baseRevision (it validates its own placement internally).
        const r = await this.callAndCommit(tools, c, "gbk_generate_fugue_section", { key: op.key, voices: op.voices, length: op.length, complexity: op.complexity, seed: op.seed, atBar: op.atBar, maxBars: op.maxBars, register: op.register }, signal);
        return r.data as Record<string, unknown>;
      }
      default: throw new McpError("INVALID_ARGUMENT", `unknown edit operation type ${JSON.stringify(op.type)}`);
    }
  }

  // ---- studio link / publishing --------------------------------------------------------------
  openWorkstation(owner: string, compositionId: string): { url: string; slug: string; note: string } {
    const { row, project } = this.getProject(owner, compositionId);
    const { row: share } = this.shares.upsertAutosave({ owner, projectId: row.id, title: project.name, projectJson: JSON.stringify(project) });
    return { url: `${this.cfg.publicOrigin}/s/${share.slug}`, slug: share.slug,
      note: "Opens the exact saved revision as a private Studio song (read-only view; Fork in Studio creates an editable copy). The MCP composition stays the canonical copy until re-imported." };
  }
  publish(owner: string, compositionId: string): { url: string; slug: string } {
    const { row } = this.getProject(owner, compositionId);
    const opened = this.openWorkstation(owner, compositionId);
    this.shares.setPublic(opened.slug, true);
    this.store.setVisibility(row.id, owner, "public");
    return { url: opened.url, slug: opened.slug };
  }
}
