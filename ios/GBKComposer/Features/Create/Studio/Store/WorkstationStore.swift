import Foundation
import Combine

/// Native port of src/workstation/controller.ts: the single source of truth shared by the
/// SwiftUI Studio and the agent tool layer. Project is a value type, so assignment is the
/// deep copy the web gets from structuredClone; history stores whole snapshots like the TS.
let proposalTTLms: Double = 10 * 60_000

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

struct Proposal: Identifiable, Sendable {
    var id: String; var projectId: String; var baseRevision: Int; var createdAt: Double
    var source: String // "user" | "agent"
    var rangeStartTick: Int; var rangeEndTick: Int; var trackIds: [String]
    var ops: [ProjectOp]; var summary: String; var warnings: [String]
    var status: String // pending | committed | discarded | stale | expired
    var original: Project; var candidate: Project
}

struct TransportState: Equatable, Sendable {
    var playing: Bool = false; var positionTick: Int = 0; var audioReady: Bool = false
    var starting: Bool = false; var sf2Progress: Double? = nil
}

struct ActivityEntry: Identifiable, Sendable {
    var id: Int; var at: Double; var source: String; var action: String; var ok: Bool; var detail: String?
}

struct AutonomousSession: Equatable, Sendable {
    var id: String; var projectId: String; var createdAt: Double; var expiresAt: Double
    var active: Bool; var purpose: String; var baseRevision: Int
}

struct CreateProjectOptions {
    var name: String; var tempo: Double? = nil; var timeSignature: (Int, Int)? = nil
    var key: String? = nil; var ppq: Int? = nil; var replaceCurrent: Bool = false
    var owner: String = "user"; var descriptors: [String: String]? = nil
    var sessionMinutes: Double? = nil; var purpose: String? = nil
}

/// App-provided capabilities (SoundFont presets, offline render, downloads). All optional.
struct WorkstationHost {
    var listPresets: (() -> [JSONValue])? = nil
    var ensureSoundFont: (() async -> Void)? = nil
    var renderWav: ((Project, String) async throws -> Data)? = nil // (project, normalize: loudness|peak|off)
    var download: ((Data, String) -> Bool)? = nil
    var checkpoint: ((Project) async throws -> Void)? = nil
    var trackRegionsJSON: ((Project, String) -> JSONValue?)? = nil
}

/// Audio engine boundary (Phase 5 implements this with the SF2 player).
protocol StudioTransportDriver: AnyObject {
    func play(fromTick: Int) async throws
    func unlock()
    func pause()
    func stop()
    func seek(tick: Int)
    func isAudioReady() -> Bool
    func prepare() async -> Bool
    func preview(project: Project, startTick: Int, endTick: Int) async throws
}

func summarizeOpsText(_ p: Project, _ ops: [ProjectOp]) -> String { summarizeOps(p, ops).joined(separator: "; ") }

final class WorkstationStore: ObservableObject {
    @Published private(set) var project: Project
    @Published private(set) var proposals: [Proposal] = []
    @Published private(set) var transport = TransportState()
    @Published private(set) var overrides: [String: TrackPatch] = [:]
    @Published private(set) var activity: [ActivityEntry] = []
    @Published var agentToolsEnabled: Bool = false
    @Published private(set) var previewing: String? = nil
    @Published private(set) var automationOff: [String] = []
    @Published private(set) var session: AutonomousSession? = nil

    private var undoStack: [HistoryEntry] = []
    private var redoStack: [HistoryEntry] = []
    private weak var driver: StudioTransportDriver?
    private var seq = 0
    private var activitySeq = 0
    var approvalHandler: ((Proposal) async throws -> Bool)? = nil
    var host = WorkstationHost()
    var maxHistory = 200
    /// Non-null while a shared song is open read-only (Fork to edit). Mutations refuse with READ_ONLY.
    private(set) var readOnlyReason: String? = nil
    var readOnlyHintListeners: [(String) -> Void] = []
    /// Fired after any project mutation (the TS subscribe() equivalent for autosave).
    var projectChangeHook: (() -> Void)? = nil

    var canUndo: Bool { !undoStack.isEmpty }
    var canRedo: Bool { !redoStack.isEmpty }

    private struct HistoryEntry { var label: String; var before: Project; var after: Project; var source: String? }

    init(project: Project = emptyProject()) { self.project = project }

    private func changed() { projectChangeHook?() }

    func log(_ source: String, _ action: String, _ ok: Bool, _ detail: String? = nil) {
        activitySeq += 1
        activity = Array(activity.suffix(49)) + [ActivityEntry(id: activitySeq, at: nowMs(), source: source, action: action, ok: ok, detail: detail)]
    }
    func setAgentToolsEnabled(_ on: Bool) { agentToolsEnabled = on }

    // MARK: - Project lifecycle

    func load(_ p: Project) {
        readOnlyReason = nil
        if let s = session, s.projectId != p.id { endSession("project switched") }
        undoStack = []; redoStack = []
        project = p
        proposals = []
        overrides = [:]
        transport.playing = false
        transport.positionTick = 0
        changed()
    }

    func currentSession() -> AutonomousSession? {
        if let s = session, nowMs() > s.expiresAt { endSession("expired"); return nil }
        return session
    }
    /// True only for the agent-owned project the active session was created for. Never for user projects.
    func autonomousAllowed(_ projectId: String? = nil) -> Bool {
        let pid = projectId ?? project.id
        guard let s = currentSession() else { return false }
        return s.active && s.projectId == pid && project.id == pid && project.meta?.owner == "agent"
    }
    /// Server-side MCP execution only (kept for parity; not called from UI code).
    @discardableResult
    func resumeAutonomousSession(purpose: String = "remote MCP session") -> Bool {
        if project.meta?.owner != "agent" { return false }
        session = AutonomousSession(id: "ses_\(project.id)", projectId: project.id, createdAt: nowMs(),
                                    expiresAt: nowMs() + 120 * 60_000, active: true, purpose: String(purpose.prefix(200)),
                                    baseRevision: project.revision)
        return true
    }
    func endSession(_ reason: String = "ended by user") {
        if session == nil { return }
        session = nil
        log("user", "autonomous session ended (\(reason))", true)
    }
    /// Revert every autonomous change: back to the empty project state created by gbk_create_project.
    @discardableResult
    func discardAutonomousWork() -> Bool {
        guard let s = session, s.projectId == project.id else { return false }
        while project.revision > s.baseRevision && undo() { }
        endSession("work discarded by user")
        return true
    }

    /// Create a fresh project (never silently overwrites: the current one is checkpointed unless replaceCurrent).
    func createProject(_ o: CreateProjectOptions) async throws -> (project: Project, previousProjectId: String, checkpointed: Bool, session: AutonomousSession?) {
        let ppq = o.ppq ?? 480
        if ppq < 24 || ppq > 32767 { throw ToolArgError("INVALID_ARGUMENT", "ppq must be an integer in [24, 32767]") }
        let tempo = o.tempo ?? 120
        if !(tempo >= 10 && tempo <= 400) { throw ToolArgError("INVALID_ARGUMENT", "tempo must be in [10, 400] BPM") }
        let (num, den) = o.timeSignature ?? (4, 4)
        if !(num >= 1 && num <= 32 && [1, 2, 4, 8, 16, 32].contains(den)) { throw ToolArgError("INVALID_ARGUMENT", "timeSignature must be [1..32, power of two]") }
        let prev = project
        var checkpointed = false
        let hasContent = !prev.tracks.isEmpty || !prev.notes.isEmpty
        if hasContent && !o.replaceCurrent {
            guard let checkpoint = host.checkpoint else { throw ToolArgError("UNSUPPORTED", "cannot checkpoint the current project; pass replaceCurrent:true to switch anyway") }
            try await checkpoint(prev)
            checkpointed = true
        }
        var p = emptyProject(name: String((o.name.isEmpty ? "Untitled" : o.name).prefix(128)), ppq: ppq)
        p.tempos = [TempoEvent(tick: 0, microPerQuarter: jsRound(60e6 / tempo))]
        p.timeSigs = [TimeSigEvent(tick: 0, numerator: num, denominator: den)]
        var meta = ProjectMeta()
        meta.owner = o.owner
        meta.createdAt = nowMs()
        if let key = o.key { meta.key = String(key.prefix(32)) }
        if let d = o.descriptors { meta.descriptors = d }
        meta.sections = []
        p.meta = meta
        load(p)
        session = nil
        if o.owner == "agent" {
            session = AutonomousSession(id: "ses_\(p.id)", projectId: p.id, createdAt: nowMs(),
                                        expiresAt: nowMs() + (o.sessionMinutes ?? 120) * 60_000, active: true,
                                        purpose: String((o.purpose ?? "compose a new piece").prefix(200)), baseRevision: p.revision)
        }
        log(o.owner == "agent" ? "agent" : "user", "create project \"\(p.name)\"", true, checkpointed ? "previous project \(prev.id) checkpointed" : nil)
        return (p, prev.id, checkpointed, session)
    }

    enum AgentApplyResult {
        case committed(revision: Int, warnings: [String])
        case proposal(Proposal)
    }
    /// Agent edit: applied immediately inside the autonomous session's own project; anywhere else
    /// it becomes a proposal that needs the user's Accept.
    func agentApply(_ ops: [ProjectOp], label: String, baseRevision: Int? = nil) throws -> AgentApplyResult {
        if Task.isCancelled { throw ToolArgError("OPERATION_CANCELLED", "cancelled") }
        if autonomousAllowed() {
            let r = try edit(ops, baseRevision: baseRevision, label: "agent: \(label)", source: "agent")
            return .committed(revision: r.revision, warnings: r.warnings)
        }
        return .proposal(try propose(ops, baseRevision: baseRevision, source: "agent", summary: label))
    }

    private func checkRev(_ baseRevision: Int?) throws {
        if let baseRevision, baseRevision != project.revision {
            throw ToolArgError("STALE_REVISION", "baseRevision \(baseRevision) != current \(project.revision)", details: .object([("currentRevision", .int(Int64(project.revision)))]))
        }
    }
    private func assertWritable() throws { if let r = readOnlyReason { throw ToolArgError("READ_ONLY", r) } }

    /// Open a shared (untrusted, already validated) song as a NEW local, read-only project.
    func loadShared(_ p: Project, reason: String = "This shared song is read-only. Press Fork to make your own editable copy.") {
        var copy = p
        copy.id = newStudioId("prj")
        copy.revision = 0
        load(copy)
        readOnlyReason = reason
        objectWillChange.send()
    }
    /// Fork: make the open shared song an editable project of this user, remembering its lineage.
    @discardableResult
    func fork() -> Project {
        let src = project
        let slug = src.meta?.sharedFrom?.slug
        var p = src
        p.id = newStudioId("prj")
        p.revision = 0
        p.name = src.name.hasSuffix("(fork)") ? src.name : "\(src.name) (fork)"
        var meta = src.meta ?? ProjectMeta()
        meta.owner = "user"
        meta.sharedFrom = nil
        if let slug { meta.forkOf = slug }
        p.meta = meta
        readOnlyReason = nil
        load(p)
        log("user", "fork\(slug.map { " of \($0)" } ?? "")", true)
        return p
    }

    private func commitProject(_ next0: Project, label: String, source: String = "user") throws {
        try assertWritable()
        let before = project
        var next = next0
        next.revision = before.revision + 1
        undoStack.append(HistoryEntry(label: label, before: before, after: next, source: source))
        if undoStack.count > maxHistory { undoStack.removeFirst() }
        redoStack = []
        project = next
        markStale(next.revision)
        changed()
    }
    private func markStale(_ rev: Int) {
        proposals = proposals.map { p in
            var p = p
            if p.status == "pending" && p.baseRevision != rev { p.status = "stale" }
            return p
        }
    }

    /// Direct (human) edit: one undo transaction.
    @discardableResult
    func edit(_ ops: [ProjectOp], baseRevision: Int? = nil, label: String? = nil, source: String = "user") throws -> (revision: Int, warnings: [String]) {
        try checkRev(baseRevision)
        let warnings = try validateProjectOps(project, ops)
        let summary = label ?? summarizeOpsText(project, ops)
        try commitProject(applyProjectOps(project, ops), label: summary, source: source)
        log(source, summary, true)
        return (project.revision, warnings)
    }

    /// UI-boundary edit: on a read-only share this is a no-op that pings readOnlyHint listeners instead of throwing.
    @discardableResult
    func userEdit(_ ops: [ProjectOp], baseRevision: Int? = nil, label: String? = nil) throws -> (revision: Int, warnings: [String])? {
        if let r = readOnlyReason { readOnlyHintListeners.forEach { $0(r) }; return nil }
        do { return try edit(ops, baseRevision: baseRevision, label: label) }
        catch let e as ToolArgError where e.code == "READ_ONLY" { readOnlyHintListeners.forEach { $0(e.message) }; return nil }
    }

    /// Restore an earlier snapshot of THIS project (a version card's "Restore"): one undoable edit; id and name stay.
    @discardableResult
    func restoreSnapshot(_ snapshot: Project, label: String = "restore version") -> Bool {
        if let r = readOnlyReason { readOnlyHintListeners.forEach { $0(r) }; return false }
        let cur = project
        var next = snapshot
        next.id = cur.id; next.name = cur.name; next.selection = cur.selection; next.loop = cur.loop
        do { try commitProject(next, label: label) } catch { return false }
        log("user", label, true)
        return true
    }
    /// Rename the current project (undoable).
    @discardableResult
    func rename(_ name: String) -> Bool {
        let n = String(name.trimmingCharacters(in: .whitespaces).prefix(120))
        if n.isEmpty || n == project.name { return false }
        if let r = readOnlyReason { readOnlyHintListeners.forEach { $0(r) }; return false }
        var next = project
        next.name = n
        do { try commitProject(next, label: "rename") } catch { return false }
        return true
    }

    @discardableResult
    func undo() -> Bool {
        guard let e = undoStack.popLast() else { return false }
        var restored = e.before
        restored.revision = project.revision + 1
        redoStack.append(HistoryEntry(label: e.label, before: e.before, after: project, source: e.source))
        project = restored
        markStale(restored.revision)
        changed()
        return true
    }
    @discardableResult
    func redo() -> Bool {
        guard let e = redoStack.popLast() else { return false }
        var next = e.after
        next.revision = project.revision + 1
        undoStack.append(HistoryEntry(label: e.label, before: project, after: e.after, source: e.source))
        project = next
        markStale(next.revision)
        changed()
        return true
    }
    func historyLabels() -> (undo: [String], redo: [String]) { (undoStack.map { $0.label }, redoStack.map { $0.label }) }

    /// Agent undo/redo, scoped to the agent's own edits (NOT_AGENT_EDIT when the top entry is the user's).
    @discardableResult
    func agentUndo() throws -> Bool {
        guard let top = undoStack.last else { return false }
        if top.source != "agent" { throw ToolArgError("NOT_AGENT_EDIT", "the last edit (\"\(String(top.label.prefix(80)))\") was made by the user, not the agent; an agent undo would revert the user's work") }
        return undo()
    }
    @discardableResult
    func agentRedo() throws -> Bool {
        guard let top = redoStack.last else { return false }
        if top.source != "agent" { throw ToolArgError("NOT_AGENT_EDIT", "the next redo (\"\(String(top.label.prefix(80)))\") was the user's edit, not the agent's") }
        return redo()
    }

    // MARK: - Selection / loop (non-undoable view state, no revision bump)

    func setSelection(_ patch: (inout Selection) -> Void) {
        var next = project
        patch(&next.selection)
        project = next
        changed()
    }
    func setLoop(_ patch: (inout LoopRange) -> Void) {
        var next = project
        patch(&next.loop)
        project = next
        changed()
    }

    // MARK: - Proposals

    @discardableResult
    func propose(_ ops: [ProjectOp], baseRevision: Int? = nil, source: String = "user", summary: String? = nil) throws -> Proposal {
        _ = expirePendingProposals()
        try assertWritable()
        try checkRev(baseRevision)
        let original = project
        let warnings = try validateProjectOps(original, ops)
        let candidate = applyProjectOps(original, ops)
        var ticks: [Int] = []
        var tracks = Set<String>()
        for op in ops {
            switch op {
            case .setCC(let trackId, _, let points, _):
                if let lo = points.map({ $0.tick }).min(), let hi = points.map({ $0.tick }).max() { ticks += [lo, hi] }
                tracks.insert(trackId)
            case .addNotes(let notes):
                for n in notes { ticks += [n.tick, n.tick + n.duration]; tracks.insert(n.trackId) }
            case .updateTrack(let id, _):
                tracks.insert(id)
            case .setVoicePatch(let trackId, _, _):
                tracks.insert(trackId)
                let ns = original.notes.filter { $0.trackId == trackId }
                let t0 = ns.first?.tick ?? 0
                let endCap = ns.map { $0.tick + $0.duration }.max() ?? (t0 + original.ppq * 8)
                ticks += [t0, max(t0 + 1, min(secToTick(original, tickToSec(original, t0) + 8), endCap))]
            case .setEffects:
                if ticks.isEmpty {
                    let t0 = original.notes.first?.tick ?? 0
                    ticks += [t0, max(t0 + 1, secToTick(original, tickToSec(original, t0) + 8))]
                }
            case .removeNotes(let ids):
                for n in original.notes where ids.contains(n.id) { ticks += [n.tick, n.tick + n.duration]; tracks.insert(n.trackId) }
            case .updateNotes(let patches):
                let ids = Set(patches.map { $0.id })
                for n in original.notes where ids.contains(n.id) { ticks += [n.tick, n.tick + n.duration]; tracks.insert(n.trackId) }
            default: break
            }
        }
        seq += 1
        let summaryText = summary.map { "\(String($0.prefix(300))) — \(summarizeOpsText(original, ops))" } ?? summarizeOpsText(original, ops)
        let p = Proposal(id: "prop_\(seq)_\(original.revision)", projectId: original.id, baseRevision: original.revision,
                         createdAt: nowMs(), source: source,
                         rangeStartTick: ticks.min() ?? 0, rangeEndTick: ticks.max() ?? 0, trackIds: Array(tracks),
                         ops: ops, summary: summaryText, warnings: warnings, status: "pending",
                         original: original, candidate: candidate)
        proposals.append(p)
        log(p.source, "propose \(p.id)", true, p.summary)
        return p
    }

    func getProposal(_ id: String) throws -> Proposal {
        guard let p = proposals.first(where: { $0.id == id }) else { throw ToolArgError("INVALID_ARGUMENT", "unknown proposal \(id)") }
        return p
    }
    private func setProposal(_ id: String, _ patch: (inout Proposal) -> Void) {
        proposals = proposals.map { p in var p = p; if p.id == id { patch(&p) }; return p }
    }

    /// Expire every pending proposal past its TTL. Returns the ids expired by this call.
    @discardableResult
    func expirePendingProposals(now: Double = nowMs()) -> [String] {
        expireWhere({ now - $0.createdAt >= proposalTTLms }, why: "past the proposal TTL")
    }
    /// A new agent run supersedes every still-pending proposal from earlier runs.
    @discardableResult
    func supersedePendingProposals() -> [String] { expireWhere({ _ in true }, why: "superseded by a new run") }
    private func expireWhere(_ pred: (Proposal) -> Bool, why: String) -> [String] {
        let hit = proposals.filter { $0.status == "pending" && pred($0) }
        if hit.isEmpty { return [] }
        let ids = Set(hit.map { $0.id })
        proposals = proposals.map { p in var p = p; if ids.contains(p.id) { p.status = "expired" }; return p }
        for p in hit { log(p.source, "expire \(p.id)", true, "\(why) while still pending") }
        return hit.map { $0.id }
    }

    /// The approval wait is bounded by the proposal's remaining TTL.
    private func awaitApproval(_ p: Proposal) async throws -> Bool {
        guard let handler = approvalHandler else {
            throw ToolArgError("USER_APPROVAL_REQUIRED", "Commit needs the user to press Accept in the GBK proposal panel.")
        }
        let ms = max(0, p.createdAt + proposalTTLms - nowMs())
        return try await withThrowingTaskGroup(of: Bool.self) { group in
            group.addTask { try await handler(p) }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(ms * 1_000_000))
                throw ToolArgError("PROPOSAL_EXPIRED", "proposal \(p.id) expired while waiting for the user to approve it")
            }
            do {
                let first = try await group.next()!
                group.cancelAll()
                return first
            } catch let e as ToolArgError where e.code == "PROPOSAL_EXPIRED" {
                group.cancelAll()
                setProposal(p.id) { $0.status = "expired" }
                log(p.source, "expire \(p.id)", true, "approval wait exceeded the proposal TTL")
                throw e
            }
        }
    }

    /// Commit = one atomic undo transaction. Agent commits require visible user approval via approvalHandler.
    @discardableResult
    func commitProposal(_ id: String, source: String) async throws -> Int {
        _ = expirePendingProposals()
        let p = try getProposal(id)
        if p.status != "pending" {
            throw ToolArgError(p.status == "stale" ? "STALE_REVISION" : p.status == "expired" ? "PROPOSAL_EXPIRED" : "INVALID_ARGUMENT", "proposal is \(p.status)")
        }
        try checkRev(p.baseRevision)
        if source == "agent" && autonomousAllowed(p.projectId) {
            // Authorized autonomous session on the agent's own new project: no per-change dialog (still undoable).
        } else if source == "agent" {
            let ok = try await awaitApproval(p)
            if Task.isCancelled { throw ToolArgError("OPERATION_CANCELLED", "cancelled") }
            if proposals.first(where: { $0.id == id })?.status == "expired" { throw ToolArgError("PROPOSAL_EXPIRED", "proposal \(id) expired before it was approved") }
            if !ok { throw ToolArgError("USER_APPROVAL_REQUIRED", "User declined the proposal.") }
            try checkRev(p.baseRevision)
        }
        let next = applyProjectOps(project, p.ops)
        let label = "\(source == "agent" && autonomousAllowed(p.projectId) ? "agent (session)" : "accept"): \(p.summary)"
        try commitProject(next, label: label, source: p.source)
        setProposal(id) { $0.status = "committed" }
        log(source, "commit \(id)", true)
        return project.revision
    }

    func discardProposal(_ id: String, source: String = "user") throws {
        _ = try getProposal(id)
        setProposal(id) { $0.status = "discarded" }
        log(source, "discard \(id)", true)
    }

    // MARK: - Transport

    func attachDriver(_ d: StudioTransportDriver?) {
        driver = d
        transport.audioReady = d?.isAudioReady() ?? false
    }
    func updateTransport(_ patch: (inout TransportState) -> Void) { patch(&transport) }

    private func readyDriver() async throws -> StudioTransportDriver {
        if let d = driver, !d.isAudioReady() {
            let ok = await d.prepare()
            transport.audioReady = ok
        }
        guard let d = driver, d.isAudioReady() else {
            throw ToolArgError("AUDIO_NOT_READY", "Audio engine not ready; the user must tap in the app to start audio and load a SoundFont.")
        }
        return d
    }
    private var pendingPlay: Task<Void, Never>? = nil
    private var playCancelled = false

    /// One call always ends in playback: unlocks audio synchronously, waits for the SoundFont, then starts.
    func play() {
        if pendingPlay != nil || transport.playing { return }
        playCancelled = false
        driver?.unlock() // must run synchronously in the tap (iOS)
        transport.starting = true
        pendingPlay = Task { [weak self] in
            guard let self else { return }
            defer { self.pendingPlay = nil; self.transport.starting = false }
            do {
                let d = try await self.readyDriver()
                if self.playCancelled { return }
                try await d.play(fromTick: self.transport.positionTick)
                if self.playCancelled { d.pause(); return }
                self.transport.playing = true
            } catch let e as ToolArgError {
                self.log("user", "play", false, e.message)
            } catch { self.log("user", "play", false, String(describing: error)) }
        }
    }
    /// Tool-facing play: same path, but the error reaches the caller.
    func playFromTool() async throws {
        let d = try await readyDriver()
        try await d.play(fromTick: transport.positionTick)
        transport.playing = true
    }
    func pause() {
        if pendingPlay != nil { playCancelled = true }
        driver?.pause()
        transport.playing = false
    }
    func stop() {
        if pendingPlay != nil { playCancelled = true }
        driver?.stop()
        transport.playing = false
        transport.positionTick = 0
    }
    func seek(_ tick: Int) {
        let t = max(0, tick)
        driver?.seek(tick: t)
        transport.positionTick = t
    }

    func previewProposal(_ id: String, variant: String) async throws {
        let p = try getProposal(id)
        let d = try await readyDriver()
        previewing = "\(id):\(variant)"
        defer { previewing = nil }
        try await d.preview(project: variant == "A" ? p.original : p.candidate, startTick: p.rangeStartTick, endTick: p.rangeEndTick)
        if Task.isCancelled { throw ToolArgError("OPERATION_CANCELLED", "preview cancelled") }
    }
    /// Audition any project (e.g. an older version) without changing the committed one.
    func previewProject(_ p: Project) async throws {
        let d = try await readyDriver()
        if transport.playing { pause() }
        previewing = "project:\(p.revision)"
        defer { previewing = nil }
        try await d.preview(project: p, startTick: 0, endTick: max(1, p.endTick, computeEndTick(p)))
    }

    // MARK: - Mixer: defaults (undoable project mix) vs temporary overrides

    @discardableResult
    func setTrackMixDefault(_ trackId: String, patch: TrackPatch, source: String = "user", baseRevision: Int? = nil) throws -> (revision: Int, warnings: [String]) {
        try edit([.updateTrack(id: trackId, patch: patch)], baseRevision: baseRevision, label: "mix \(trackId)", source: source)
    }
    func setOverride(_ trackId: String, mix: TrackPatch?) {
        if let mix {
            var cur = overrides[trackId] ?? TrackPatch()
            if let v = mix.volume { cur.volume = v }
            if let v = mix.pan { cur.pan = v }
            if let v = mix.expression { cur.expression = v }
            if let v = mix.mute { cur.mute = v }
            if let v = mix.solo { cur.solo = v }
            overrides[trackId] = cur
        } else { overrides.removeValue(forKey: trackId) }
    }
    func clearOverrides() { overrides = [:] }

    // MARK: - Automation playback (per-lane Read)

    func automationRead(_ trackId: String, controller: Int) -> Bool { !automationOff.contains("\(trackId):\(controller)") }
    func setAutomationRead(_ trackId: String, controller: Int, on: Bool) {
        let k = "\(trackId):\(controller)"
        let has = automationOff.contains(k)
        if on == !has { return }
        automationOff = on ? automationOff.filter { $0 != k } : automationOff + [k]
    }

    // MARK: - Export

    func prepareMidiExport() -> (bytes: Data, filename: String) {
        let safe = String(project.name.unicodeScalars.map { scalar -> Character in
            let v = scalar.value
            let ok = (v >= 48 && v <= 57) || (v >= 65 && v <= 90) || (v >= 97 && v <= 122) || v == 95 || v == 45 || v == 32 || v == 46
            return ok ? Character(scalar) : "_"
        }.prefix(80))
        return (serializeSmf(project, soundNrpn: true), "\(safe.isEmpty ? "gbk" : safe).mid")
    }
    func durationSec() -> Double { tickToSec(project, project.endTick) }
}
