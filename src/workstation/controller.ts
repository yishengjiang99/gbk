// Headless WorkstationController: the single source of truth shared by React UI and WebMCP.
import { cloneProject, emptyProject, type Project, type Selection, type Loop, type TrackMix } from "./model.ts";
import { applyOps, summarizeOps, validateOps, WorkstationError, type Op } from "./ops.ts";
import { serializeSmf } from "./smf.ts";
import { tickToSec } from "./timing.ts";

export { WorkstationError };
export type ProposalStatus = "pending" | "committed" | "discarded" | "stale";
export interface Proposal {
  id: string; projectId: string; baseRevision: number; createdAt: number; source: "user" | "agent";
  range: { startTick: number; endTick: number }; trackIds: string[]; ops: Op[]; summary: string;
  validation: { ok: boolean; warnings: string[] }; status: ProposalStatus;
  original: Project; candidate: Project; // refs: original = snapshot at baseRevision
}
export interface TransportState { playing: boolean; positionTick: number; audioReady: boolean }
export interface TransportDriver {
  play(fromTick: number): Promise<void> | void; pause(): void; stop(): void; seek(tick: number): void;
  isAudioReady(): boolean;
  /** Audition a candidate project over a tick range without mutating state. Returns cleanup. */
  preview?(project: Project, startTick: number, endTick: number, signal?: AbortSignal): Promise<void>;
}
export interface ActivityEntry { at: number; source: "user" | "agent"; action: string; ok: boolean; detail?: string }
export interface WorkstationState {
  project: Project; proposals: Proposal[]; transport: TransportState;
  /** Temporary live overrides (mixer knobs while playing). Not persisted; never rewrite authored CCs. */
  overrides: Record<string, Partial<TrackMix>>;
  canUndo: boolean; canRedo: boolean; activity: ActivityEntry[]; agentToolsEnabled: boolean;
  previewing: string | null;
}
/** App-provided capabilities (SoundFont presets, offline render, downloads). All optional. */
export interface WorkstationHost {
  listPresets?(): { index: number; bank: number; program: number; name: string }[];
  renderWav?(project: Project, signal?: AbortSignal): Promise<Blob>;
  download?(data: Blob | Uint8Array, filename: string): void;
}
export type ApprovalHandler = (p: Proposal) => Promise<boolean>;

interface HistoryEntry { label: string; before: Project; after: Project }

export class WorkstationController {
  private state: WorkstationState;
  private listeners = new Set<(s: WorkstationState) => void>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private driver: TransportDriver | null = null;
  private seq = 0;
  approvalHandler: ApprovalHandler | null = null;
  host: WorkstationHost = {};
  maxHistory = 200;

  constructor(project: Project = emptyProject()) {
    this.state = { project, proposals: [], transport: { playing: false, positionTick: 0, audioReady: false }, overrides: {}, canUndo: false, canRedo: false, activity: [], agentToolsEnabled: false, previewing: null };
  }

  // ---- subscriptions -------------------------------------------------------
  getState(): WorkstationState { return this.state; }
  get project(): Project { return this.state.project; }
  subscribe(fn: (s: WorkstationState) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private set(patch: Partial<WorkstationState>) {
    this.state = { ...this.state, ...patch, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 };
    for (const l of this.listeners) l(this.state);
  }
  log(source: "user" | "agent", action: string, ok: boolean, detail?: string) {
    this.set({ activity: [...this.state.activity.slice(-49), { at: Date.now(), source, action, ok, detail }] });
  }
  setAgentToolsEnabled(on: boolean) { this.set({ agentToolsEnabled: on }); }

  // ---- project lifecycle ---------------------------------------------------
  load(project: Project) {
    this.undoStack = []; this.redoStack = [];
    this.set({ project, proposals: [], overrides: {}, transport: { ...this.state.transport, playing: false, positionTick: 0 } });
  }
  private checkRev(baseRevision: number | undefined) {
    if (baseRevision !== undefined && baseRevision !== this.state.project.revision)
      throw new WorkstationError("STALE_REVISION", `baseRevision ${baseRevision} != current ${this.state.project.revision}`, { currentRevision: this.state.project.revision });
  }
  private commitProject(next: Project, label: string) {
    const before = this.state.project;
    next.revision = before.revision + 1;
    this.undoStack.push({ label, before, after: next });
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack = [];
    this.set({ project: next, proposals: this.markStale(next.revision) });
  }
  private markStale(rev: number) { return this.state.proposals.map((p) => p.status === "pending" && p.baseRevision !== rev ? { ...p, status: "stale" as const } : p); }

  /** Direct (human) edit: one undo transaction. */
  edit(ops: Op[], opts: { baseRevision?: number; label?: string; source?: "user" | "agent" } = {}): { revision: number; warnings: string[] } {
    this.checkRev(opts.baseRevision);
    const warnings = validateOps(this.project, ops);
    this.commitProject(applyOps(this.project, ops), opts.label ?? summarizeOps(ops));
    this.log(opts.source ?? "user", opts.label ?? summarizeOps(ops), true);
    return { revision: this.project.revision, warnings };
  }

  undo(): boolean {
    const e = this.undoStack.pop(); if (!e) return false;
    const restored = { ...e.before, revision: this.project.revision + 1 };
    this.redoStack.push({ ...e, after: this.project });
    this.set({ project: restored, proposals: this.markStale(restored.revision) });
    return true;
  }
  redo(): boolean {
    const e = this.redoStack.pop(); if (!e) return false;
    const next = { ...e.after, revision: this.project.revision + 1 };
    this.undoStack.push({ ...e, before: this.project });
    this.set({ project: next, proposals: this.markStale(next.revision) });
    return true;
  }
  historyLabels() { return { undo: this.undoStack.map((e) => e.label), redo: this.redoStack.map((e) => e.label) }; }

  // ---- selection / loop (non-undoable view state, no revision bump) --------
  setSelection(sel: Partial<Selection>) { this.set({ project: { ...this.project, selection: { ...this.project.selection, ...sel } } }); }
  setLoop(loop: Partial<Loop>) { this.set({ project: { ...this.project, loop: { ...this.project.loop, ...loop } } }); }

  // ---- proposals -----------------------------------------------------------
  propose(ops: Op[], opts: { baseRevision?: number; source?: "user" | "agent"; summary?: string } = {}): Proposal {
    this.checkRev(opts.baseRevision);
    const original = this.project;
    const warnings = validateOps(original, ops);
    const candidate = applyOps(original, ops);
    const ticks: number[] = []; const tracks = new Set<string>();
    for (const o of ops) {
      if (o.op === "setCC") { ticks.push(o.startTick, o.endTick); tracks.add(o.trackId); }
      if (o.op === "addNotes") for (const n of o.notes) { ticks.push(n.tick, n.tick + n.duration); tracks.add(n.trackId); }
      if (o.op === "updateTrack") tracks.add(o.trackId);
      if (o.op === "removeNotes" || o.op === "updateNotes") {
        const ids = new Set(o.op === "removeNotes" ? o.ids : o.updates.map((u) => u.id));
        for (const n of original.notes) if (ids.has(n.id)) { ticks.push(n.tick, n.tick + n.duration); tracks.add(n.trackId); }
      }
    }
    const p: Proposal = {
      id: `prop_${++this.seq}_${original.revision}`, projectId: original.id, baseRevision: original.revision, createdAt: Date.now(), source: opts.source ?? "user",
      range: { startTick: ticks.length ? Math.min(...ticks) : 0, endTick: ticks.length ? Math.max(...ticks) : 0 }, trackIds: [...tracks], ops,
      summary: opts.summary ? `${opts.summary.slice(0, 300)} — ${summarizeOps(ops)}` : summarizeOps(ops), validation: { ok: true, warnings }, status: "pending", original, candidate,
    };
    this.set({ proposals: [...this.state.proposals, p] });
    this.log(p.source, `propose ${p.id}`, true, p.summary);
    return p;
  }
  getProposal(id: string): Proposal {
    const p = this.state.proposals.find((x) => x.id === id);
    if (!p) throw new WorkstationError("INVALID_ARGUMENT", `unknown proposal ${id}`);
    return p;
  }
  private setProposal(id: string, patch: Partial<Proposal>) { this.set({ proposals: this.state.proposals.map((p) => p.id === id ? { ...p, ...patch } : p) }); }

  /** Commit = one atomic undo transaction. Agent commits require visible user approval via approvalHandler. */
  async commitProposal(id: string, opts: { source: "user" | "agent"; signal?: AbortSignal }): Promise<{ revision: number }> {
    const p = this.getProposal(id);
    if (p.status !== "pending") throw new WorkstationError(p.status === "stale" ? "STALE_REVISION" : "INVALID_ARGUMENT", `proposal is ${p.status}`);
    this.checkRev(p.baseRevision);
    if (opts.source === "agent") {
      if (!this.approvalHandler) throw new WorkstationError("USER_APPROVAL_REQUIRED", "Commit needs the user to press Accept in the GBK proposal panel.");
      const ok = await this.approvalHandler(p);
      if (opts.signal?.aborted) throw new WorkstationError("OPERATION_CANCELLED", "cancelled");
      if (!ok) throw new WorkstationError("USER_APPROVAL_REQUIRED", "User declined the proposal.");
      this.checkRev(p.baseRevision);
    }
    const next = applyOps(this.project, p.ops);
    this.commitProject(next, `accept: ${p.summary}`);
    this.setProposal(id, { status: "committed" });
    this.log(opts.source, `commit ${id}`, true);
    return { revision: this.project.revision };
  }
  discardProposal(id: string, source: "user" | "agent" = "user") {
    this.getProposal(id);
    this.setProposal(id, { status: "discarded" });
    this.log(source, `discard ${id}`, true);
  }

  // ---- transport -----------------------------------------------------------
  attachDriver(d: TransportDriver | null) { this.driver = d; this.updateTransport({ audioReady: !!d?.isAudioReady() }); }
  updateTransport(t: Partial<TransportState>) { this.set({ transport: { ...this.state.transport, ...t } }); }
  private needDriver(): TransportDriver {
    if (!this.driver || !this.driver.isAudioReady()) throw new WorkstationError("AUDIO_NOT_READY", "Audio engine not ready; the user must click in the page to start audio (autoplay policy) and load a SoundFont.");
    return this.driver;
  }
  async play() { const d = this.needDriver(); await d.play(this.state.transport.positionTick); this.updateTransport({ playing: true }); }
  pause() { this.driver?.pause(); this.updateTransport({ playing: false }); }
  stop() { this.driver?.stop(); this.updateTransport({ playing: false, positionTick: 0 }); }
  seek(tick: number) { const t = Math.max(0, Math.round(tick)); this.driver?.seek(t); this.updateTransport({ positionTick: t }); }

  async previewProposal(id: string, variant: "A" | "B", signal?: AbortSignal) {
    const p = this.getProposal(id);
    const d = this.needDriver();
    if (!d.preview) throw new WorkstationError("UNSUPPORTED", "preview not supported by this driver");
    this.set({ previewing: `${id}:${variant}` });
    try { await d.preview(variant === "A" ? p.original : p.candidate, p.range.startTick, p.range.endTick, signal); }
    finally { this.set({ previewing: null }); }
    if (signal?.aborted) throw new WorkstationError("OPERATION_CANCELLED", "preview cancelled");
  }

  // ---- mixer: defaults (undoable project mix) vs temporary overrides -------
  setTrackMixDefault(trackId: string, mix: Partial<TrackMix>, source: "user" | "agent" = "user", baseRevision?: number) {
    return this.edit([{ op: "updateTrack", trackId, mix }], { baseRevision, source, label: `mix ${trackId}` });
  }
  setOverride(trackId: string, mix: Partial<TrackMix> | null) {
    const o = { ...this.state.overrides };
    if (mix === null) delete o[trackId]; else o[trackId] = { ...(o[trackId] ?? {}), ...mix };
    this.set({ overrides: o });
  }
  clearOverrides() { this.set({ overrides: {} }); }

  // ---- export --------------------------------------------------------------
  prepareMidiExport(): { bytes: Uint8Array; filename: string } {
    const safe = this.project.name.replace(/[^\w\- .]/g, "_").slice(0, 80) || "gbk";
    return { bytes: serializeSmf(this.project), filename: `${safe}.mid` };
  }
  durationSec() { return tickToSec(this.project, this.project.endTick); }
}

export { cloneProject };
