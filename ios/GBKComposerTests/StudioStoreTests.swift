import XCTest
@testable import GBKComposer

/// Phase 2: WorkstationStore (controller.ts port) + persistence (persistence.ts / studio-api.ts).
final class StudioStoreTests: XCTestCase {

    private func storeWithTrack() -> WorkstationStore {
        let s = WorkstationStore()
        var p = emptyProject(name: "Song")
        p.tracks = [GTrack(id: "t1", name: "Piano", channel: 0, color: "#fff", mix: .default, visible: true, role: nil)]
        s.load(p)
        return s
    }
    private func note(_ id: String, tick: Int = 0, pitch: Int = 60) -> GNote {
        GNote(id: id, trackId: "t1", channel: 0, tick: tick, duration: 480, pitch: pitch, velocity: 90)
    }

    func testEditUndoRedo() throws {
        let s = storeWithTrack()
        let r = try s.edit([.addNotes([note("n1")])], label: "add")
        XCTAssertEqual(r.revision, 1)
        XCTAssertEqual(s.project.notes.count, 1)
        XCTAssertTrue(s.canUndo)
        XCTAssertTrue(s.undo())
        XCTAssertEqual(s.project.notes.count, 0)
        XCTAssertEqual(s.project.revision, 2) // undo bumps revision, like the TS
        XCTAssertTrue(s.redo())
        XCTAssertEqual(s.project.notes.count, 1)
    }

    func testStaleRevisionRejected() {
        let s = storeWithTrack()
        XCTAssertThrowsError(try s.edit([.addNotes([note("n1")])], baseRevision: 99)) { e in
            XCTAssertEqual((e as? ToolArgError)?.code, "STALE_REVISION")
        }
    }

    func testProposalLifecycleUserCommit() async throws {
        let s = storeWithTrack()
        let p = try s.propose([.addNotes([note("n1")])], source: "agent", summary: "add a note")
        XCTAssertEqual(p.status, "pending")
        XCTAssertEqual(s.project.notes.count, 0) // not applied until commit
        let rev = try await s.commitProposal(p.id, source: "user")
        XCTAssertEqual(rev, 1)
        XCTAssertEqual(s.project.notes.count, 1)
        XCTAssertEqual(s.proposals.first { $0.id == p.id }?.status, "committed")
    }

    func testAgentCommitNeedsApproval() async throws {
        let s = storeWithTrack()
        let p = try s.propose([.addNotes([note("n1")])], source: "agent")
        do {
            _ = try await s.commitProposal(p.id, source: "agent")
            XCTFail("expected USER_APPROVAL_REQUIRED")
        } catch let e as ToolArgError {
            XCTAssertEqual(e.code, "USER_APPROVAL_REQUIRED")
        }
        s.approvalHandler = { _ in false }
        do {
            _ = try await s.commitProposal(p.id, source: "agent")
            XCTFail("expected decline")
        } catch let e as ToolArgError {
            XCTAssertEqual(e.code, "USER_APPROVAL_REQUIRED")
        }
        s.approvalHandler = { _ in true }
        _ = try await s.commitProposal(p.id, source: "agent")
        XCTAssertEqual(s.project.notes.count, 1)
    }

    func testProposalGoesStaleOnEdit() throws {
        let s = storeWithTrack()
        let p = try s.propose([.addNotes([note("n1")])], source: "agent")
        _ = try s.edit([.addNotes([note("n2", tick: 480)])])
        XCTAssertEqual(s.proposals.first { $0.id == p.id }?.status, "stale")
    }

    func testProposalExpiry() async throws {
        let s = storeWithTrack()
        let p = try s.propose([.addNotes([note("n1")])], source: "agent")
        let expired = s.expirePendingProposals(now: p.createdAt + proposalTTLms + 1)
        XCTAssertEqual(expired, [p.id])
        do {
            _ = try await s.commitProposal(p.id, source: "user")
            XCTFail("expected PROPOSAL_EXPIRED")
        } catch let e as ToolArgError {
            XCTAssertEqual(e.code, "PROPOSAL_EXPIRED")
        }
    }

    func testSupersedeExpiresAllPending() throws {
        let s = storeWithTrack()
        _ = try s.propose([.addNotes([note("n1")])], source: "agent")
        _ = try s.propose([.addNotes([note("n2", tick: 480)])], source: "agent")
        XCTAssertEqual(s.supersedePendingProposals().count, 2)
        XCTAssertTrue(s.proposals.allSatisfy { $0.status == "expired" })
    }

    func testAutonomousSessionAgentApplyAndScopedUndo() async throws {
        let s = WorkstationStore()
        let created = try await s.createProject(CreateProjectOptions(name: "Agent Piece", owner: "agent", purpose: "test"))
        XCTAssertEqual(created.project.meta?.owner, "agent")
        XCTAssertTrue(s.autonomousAllowed())
        let a1 = try s.agentApply([.addTrack(GTrack(id: "t1", name: "Piano", channel: 0, color: "#fff", mix: .default, visible: true, role: nil)], label: "track")
        guard case .committed(_, _) = a1 else { XCTFail("expected direct commit in session"); return }
        let a2 = try s.agentApply([.addNotes([note("n1")])], label: "notes")
        guard case .committed(_, _) = a2 else { XCTFail("expected direct commit in session"); return }
        XCTAssertEqual(s.project.notes.count, 1)
        XCTAssertTrue(try s.agentUndo()) // agent may undo its own edit
        XCTAssertEqual(s.project.notes.count, 0)
        // A user edit on top: agent undo must now refuse.
        _ = try s.edit([.addNotes([note("u1")])], source: "user")
        XCTAssertThrowsError(try s.agentUndo()) { e in
            XCTAssertEqual((e as? ToolArgError)?.code, "NOT_AGENT_EDIT")
        }
    }

    func testCreateProjectCheckpointRule() async throws {
        let s = storeWithTrack()
        do {
            _ = try await s.createProject(CreateProjectOptions(name: "New"))
            XCTFail("expected UNSUPPORTED without a checkpoint host")
        } catch let e as ToolArgError {
            XCTAssertEqual(e.code, "UNSUPPORTED")
        }
        var saved: Project? = nil
        s.host.checkpoint = { p in saved = p }
        let r = try await s.createProject(CreateProjectOptions(name: "New"))
        XCTAssertTrue(r.checkpointed)
        XCTAssertEqual(saved?.name, "Song")
        XCTAssertEqual(s.project.name, "New")
        // replaceCurrent skips the checkpoint entirely.
        let s2 = storeWithTrack()
        let r2 = try await s2.createProject(CreateProjectOptions(name: "New2", replaceCurrent: true))
        XCTAssertFalse(r2.checkpointed)
    }

    func testReadOnlyShareAndFork() throws {
        let s = WorkstationStore()
        var shared = emptyProject(name: "Shared Song")
        shared.tracks = [GTrack(id: "t1", name: "Piano", channel: 0, color: "#fff", mix: .default, visible: true, role: nil)]
        shared.meta = ProjectMeta(sharedFrom: SharedFrom(slug: "some-song-abc", title: "Shared Song", owner: "other", parentSlug: nil))
        s.loadShared(shared)
        XCTAssertNotNil(s.readOnlyReason)
        XCTAssertThrowsError(try s.edit([.addNotes([note("n1")])])) { e in
            XCTAssertEqual((e as? ToolArgError)?.code, "READ_ONLY")
        }
        var hinted: String? = nil
        s.readOnlyHintListeners = [{ hinted = $0 }]
        XCTAssertNil(try s.userEdit([.addNotes([note("n1")])]))
        XCTAssertNotNil(hinted)
        let forked = s.fork()
        XCTAssertNil(s.readOnlyReason)
        XCTAssertEqual(forked.meta?.forkOf, "some-song-abc")
        XCTAssertNil(forked.meta?.sharedFrom)
        XCTAssertTrue(forked.name.hasSuffix("(fork)"))
        _ = try s.edit([.addNotes([note("n1")])]) // editable now
        XCTAssertEqual(s.project.notes.count, 1)
    }

    // MARK: Persistence

    private func tempStore() -> ProjectFileStore {
        ProjectFileStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("gbk-test-\(UUID().uuidString)", isDirectory: true))
    }

    func testProjectFileStoreRoundTripAndRestore() {
        let files = tempStore()
        var p = emptyProject(name: "Saved Song")
        p.tracks = [GTrack(id: "t1", name: "Piano", channel: 0, color: "#fff", mix: .default, visible: true, role: nil)]
        p.notes = [note("n1")]
        p.revision = 3
        files.putProject(StoredProjectRecord(id: p.id, schemaVersion: 1, savedAt: 1000, project: p))
        let listed = files.listProjects()
        XCTAssertEqual(listed.count, 1)
        XCTAssertEqual(listed.first?.project.name, "Saved Song")
        XCTAssertEqual(listed.first?.project.notes.count, 1)
        // Restore into an empty store works...
        let s = WorkstationStore()
        XCTAssertTrue(restoreLatestProject(into: s, files: files))
        XCTAssertEqual(s.project.name, "Saved Song")
        // ...but never clobbers an edited current project.
        let s2 = storeWithTrack()
        _ = try? s2.edit([.addNotes([note("x")])])
        XCTAssertFalse(restoreLatestProject(into: s2, files: files))
        XCTAssertEqual(s2.project.name, "Song")
    }

    func testMigrateProject() {
        // v0 shape: missing the newer arrays entirely.
        let v0: JSONValue = .object([
            ("id", .string("p0")), ("name", .string("Old")), ("ppq", .int(480)), ("schemaVersion", .int(0)),
            ("tracks", .array([])), ("notes", .array([])), ("ccs", .array([])),
            ("programs", .array([])), ("tempos", .array([])), ("timeSigs", .array([])),
        ])
        let migrated = migrateProject(v0)
        XCTAssertNotNil(migrated)
        XCTAssertEqual(migrated?.schemaVersion, 1)
        // From a newer build: refuse.
        var newer = v0
        if case .object(var pairs) = newer {
            pairs = pairs.map { $0.0 == "schemaVersion" ? ($0.0, .int(2)) : $0 }
            newer = .object(pairs)
        }
        XCTAssertNil(migrateProject(newer))
        // Missing a required array: refuse.
        let broken: JSONValue = .object([("id", .string("p1")), ("ppq", .int(480)), ("tracks", .array([]))])
        XCTAssertNil(migrateProject(broken))
    }

    func testPublishedMarksAndResumeRule() {
        let suite = "gbk-test-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let marks = PublishedMarks(defaults: defaults)
        let files = tempStore()
        let s = storeWithTrack()
        _ = try? s.edit([.addNotes([note("n1")])])
        var state = currentProjectState(s, marks: marks, files: files)
        XCTAssertTrue(state.hasContent)
        XCTAssertFalse(state.published)
        XCTAssertTrue(shouldResume(state))
        marks.markPublished(projectId: s.project.id, revision: s.project.revision)
        state = currentProjectState(s, marks: marks, files: files)
        XCTAssertTrue(state.published)
        XCTAssertFalse(state.dirtySincePublish)
        XCTAssertFalse(shouldResume(state)) // published and clean: Create starts fresh
        _ = try? s.edit([.addNotes([note("n2", tick: 480)])])
        state = currentProjectState(s, marks: marks, files: files)
        XCTAssertTrue(state.dirtySincePublish)
        XCTAssertTrue(shouldResume(state)) // edits since publish: resume the draft
    }
}
