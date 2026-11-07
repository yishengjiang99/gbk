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

    func testAutonomousSessionAgentApplyAndScopedUndo() async throws {
        let s = WorkstationStore()
        let created = try await s.createProject(CreateProjectOptions(name: "Agent Piece", owner: "agent", purpose: "test"))
        XCTAssertEqual(created.project.meta?.owner, "agent")
        XCTAssertTrue(s.autonomousAllowed())
        let a1 = try s.agentApply([.addTrack(GTrack(id: "t1", name: "Piano", channel: 0, color: "#fff", mix: .default, visible: true, role: nil), index: nil)], label: "track")
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

    func testDiscardProposalOnlyMovesPending() async throws {
        let s = storeWithTrack()
        let pending = try s.propose([.addNotes([note("n1")])], source: "agent", summary: "add a note")
        XCTAssertEqual(pending.status, "pending")
        try s.discardProposal(pending.id)
        XCTAssertEqual(s.proposals.first { $0.id == pending.id }?.status, "discarded")
        try s.discardProposal(pending.id)
        XCTAssertEqual(s.proposals.first { $0.id == pending.id }?.status, "discarded")

        let committed = try s.propose([.addNotes([note("n2")])], source: "agent", summary: "add another")
        _ = try await s.commitProposal(committed.id, source: "user")
        XCTAssertEqual(s.proposals.first { $0.id == committed.id }?.status, "committed")
        let rev = s.project.revision
        let notes = s.project.notes.count
        try s.discardProposal(committed.id)
        XCTAssertEqual(s.proposals.first { $0.id == committed.id }?.status, "committed")
        XCTAssertEqual(s.project.revision, rev)
        XCTAssertEqual(s.project.notes.count, notes)

        let stale = try s.propose([.addNotes([note("n3", tick: 1920)])], source: "agent", summary: "will stale")
        _ = try s.edit([.addNotes([note("u1", tick: 2400)])], source: "user")
        XCTAssertEqual(s.proposals.first { $0.id == stale.id }?.status, "stale")
        try s.discardProposal(stale.id)
        XCTAssertEqual(s.proposals.first { $0.id == stale.id }?.status, "stale")

        let expiring = try s.propose([.addNotes([note("n4", tick: 2880)])], source: "agent", summary: "will expire")
        XCTAssertTrue(s.expirePendingProposals(now: 1e15).contains(expiring.id))
        XCTAssertEqual(s.proposals.first { $0.id == expiring.id }?.status, "expired")
        try s.discardProposal(expiring.id)
        XCTAssertEqual(s.proposals.first { $0.id == expiring.id }?.status, "expired")
    }
}
