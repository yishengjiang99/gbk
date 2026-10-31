import XCTest
@testable import GBKComposer

/// Phase 4: the agent bridge — ToolExecutor (dedupe / policy / consent / project binding /
/// deadline floor), friendlyError, and the AgentSession conversation state machine.
final class StudioBridgeTests: XCTestCase {

    private func exec(_ ex: ToolExecutor, runId: String = "run_1", callId: String = "call_1",
                      tool: String, args: JSONValue = .object([]), session: String = "sess_1",
                      current: String = "sess_1", expect: String? = nil, consent: Bool = false,
                      deadlineMs: Int = 0) async -> JSONValue {
        await ex.execute(sessionId: session, currentSessionId: current, runId: runId, callId: callId,
                         tool: tool, arguments: args, expectProjectId: expect,
                         consentNewProject: consent, deadlineMs: deadlineMs, onProgress: nil).value
    }

    // MARK: - ToolExecutor

    func testExecutorDedupesByRunAndCall() async {
        let store = WorkstationStore()
        let ex = ToolExecutor(store: store)
        let args: JSONValue = .object([("name", .string("Violin")), ("program", .int(40)), ("role", .string("melody"))])
        // An agent-owned project opens an autonomous session, so the track commits directly.
        let created = await exec(ex, runId: "run_0", callId: "call_0", tool: "gbk_create_project", args: .object([("name", .string("Dedupe"))]), consent: true)
        XCTAssertEqual(created["ok"]?.boolValue, true, String(describing: created["error"]))
        let first = await exec(ex, tool: "gbk_create_track", args: args)
        XCTAssertEqual(first["ok"]?.boolValue, true, String(describing: first["error"]))
        XCTAssertEqual(store.project.tracks.count, 1)
        // A replayed tool_call (same runId:callId) returns the stored result, never re-executes.
        let replay = await exec(ex, tool: "gbk_create_track", args: args)
        XCTAssertEqual(replay.serialized, first.serialized)
        XCTAssertEqual(store.project.tracks.count, 1, "duplicate call must not add a second track")
        let seen = await ex.seenResult("run_1:call_1")
        XCTAssertEqual(seen?.serialized, first.serialized)
    }

    func testExecutorSessionMismatchAndPolicy() async {
        let store = WorkstationStore()
        let ex = ToolExecutor(store: store)
        let mismatch = await exec(ex, tool: "gbk_get_project_summary", session: "sess_other")
        XCTAssertEqual(mismatch["error"]?["code"]?.stringValue, "SESSION_MISMATCH")
        // In the registry but deliberately not exposed by the composer policy.
        let notAllowed = await exec(ex, callId: "call_2", tool: "gbk_read_wav_bytes")
        XCTAssertEqual(notAllowed["error"]?["code"]?.stringValue, "TOOL_NOT_ALLOWED")
        let unknown = await exec(ex, callId: "call_3", tool: "gbk_nope")
        XCTAssertEqual(unknown["error"]?["code"]?.stringValue, "TOOL_NOT_ALLOWED")
    }

    // MARK: - AgentSession

    private func frame(_ pairs: [(String, JSONValue)]) -> JSONValue { .object(pairs) }

    func testSessionHistoryAdoptionAndPendingReset() {
        let session = AgentSession(store: WorkstationStore())
        XCTAssertFalse(session.send("hello"), "no socket: send fails and appends nothing")
        XCTAssertTrue(session.items.isEmpty)
        session.reset() // no socket either: the reset is owed (pendingReset)
        let ready = frame([("type", .string("session_ready")), ("model", .string("m1")),
                           ("models", .array([.string("m1")])), ("provider", .string("p")),
                           ("llmConfigured", .bool(true)), ("rejectedTools", .array([])),
                           ("history", .array([.object([("role", .string("user")), ("text", .string("old"))])]))])
        session.handleEvent(ready)
        XCTAssertTrue(session.items.isEmpty, "history predating an owed reset is not adopted")
        XCTAssertEqual(session.info?.model, "m1")
        XCTAssertEqual(session.model, "m1")
        session.handleEvent(ready) // reset delivered with the previous frame; now history adopts
        XCTAssertEqual(session.items.count, 1)
        XCTAssertEqual(session.items.first?.id, "h0")
        XCTAssertEqual(session.items.first?.text, "old")
    }
}
