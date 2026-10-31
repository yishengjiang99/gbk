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

    func testExecutorConsentAndProjectBinding() async {
        let store = WorkstationStore()
        let ex = ToolExecutor(store: store)
        let noConsent = await exec(ex, tool: "gbk_create_project", args: .object([("name", .string("Nope"))]))
        XCTAssertEqual(noConsent["error"]?["code"]?.stringValue, "CONSENT_REQUIRED")
        let created = await exec(ex, callId: "call_2", tool: "gbk_create_project",
                                 args: .object([("name", .string("Consented"))]), consent: true)
        XCTAssertEqual(created["ok"]?.boolValue, true, String(describing: created["error"]))
        XCTAssertEqual(ex.boundProjectId, created["projectId"]?.stringValue, "a successful create binds the project")
        let changed = await exec(ex, callId: "call_3", tool: "gbk_get_project_summary", expect: "prj_someone_else")
        XCTAssertEqual(changed["error"]?["code"]?.stringValue, "PROJECT_CHANGED")
    }

    func testExecutorDeadlineFloor() async {
        let store = WorkstationStore()
        let ex = ToolExecutor(store: store)
        // deadlineMs below the 1000 ms floor is clamped, so a fast read still succeeds.
        let r = await exec(ex, tool: "gbk_get_project_summary", deadlineMs: 1)
        XCTAssertEqual(r["ok"]?.boolValue, true, String(describing: r["error"]))
    }

    // MARK: - friendlyError

    func testFriendlyError() {
        XCTAssertEqual(friendlyError("TOOL_TIMEOUT", "whatever"), "That step took too long and was stopped.")
        XCTAssertEqual(friendlyError("OPERATION_CANCELLED", nil), "Stopped.")
        XCTAssertEqual(friendlyError("DAILY_BUDGET_EXHAUSTED", "You've hit today's AI limit — 12k tokens."),
                       "You've hit today's AI limit — 12k tokens.")
        XCTAssertEqual(friendlyError("BUDGET_EXHAUSTED", "spent"), "You've hit today's AI limit. It resets at 5 PM PT.")
        XCTAssertEqual(friendlyError(nil, "STALE_REVISION: the song prj_abc123def changed (expected revision 3)"),
                       "The song this song changed")
        XCTAssertEqual(friendlyError("SOME_CODE", ""), "Something went wrong. Try again.")
        XCTAssertEqual(friendlyError(nil, nil), "Something went wrong. Try again.")
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

    func testSessionRunLifecycle() {
        let session = AgentSession(store: WorkstationStore())
        session.handleEvent(frame([("type", .string("session_ready")), ("model", .string("m1")),
                                   ("models", .array([])), ("provider", .string("p")),
                                   ("llmConfigured", .bool(true)), ("rejectedTools", .array([])),
                                   ("history", .array([.object([("role", .string("user")), ("text", .string("make it brighter"))])]))]))
        session.handleEvent(frame([("type", .string("run_started")), ("runId", .string("run_1"))]))
        XCTAssertEqual(session.run?.runId, "run_1")
        XCTAssertEqual(session.items.last?.id, "a_run_1")
        session.handleEvent(frame([("type", .string("assistant_delta")), ("runId", .string("run_1")), ("text", .string("Hel"))]))
        session.handleEvent(frame([("type", .string("assistant_delta")), ("runId", .string("run_1")), ("text", .string("lo"))]))
        XCTAssertEqual(session.items.last?.text, "Hello")
        session.handleEvent(frame([("type", .string("tool_intent")), ("runId", .string("run_1")), ("callId", .string("c1")),
                                   ("tool", .string("gbk_get_project_summary")), ("task", .string("Reading the song"))]))
        XCTAssertEqual(session.items.last?.steps?.first?.status, "pending")
        XCTAssertEqual(session.run?.task, "Reading the song")
        session.handleEvent(frame([("type", .string("tool_started")), ("runId", .string("run_1")), ("callId", .string("c1"))]))
        XCTAssertEqual(session.items.last?.steps?.first?.status, "running")
        session.handleEvent(frame([("type", .string("tool_progress")), ("runId", .string("run_1")), ("callId", .string("c1")), ("detail", .string("half"))]))
        XCTAssertEqual(session.items.last?.steps?.first?.progress, "half")
        session.handleEvent(frame([("type", .string("tool_completed")), ("runId", .string("run_1")), ("callId", .string("c1")),
                                   ("ok", .bool(true)), ("summary", .string("read ok"))]))
        XCTAssertEqual(session.items.last?.steps?.first?.status, "done")
        XCTAssertEqual(session.items.last?.steps?.first?.summary, "read ok")
        session.handleEvent(frame([("type", .string("progress")), ("runId", .string("run_1")), ("step", .int(2)), ("maxSteps", .int(5)), ("task", .string("Working"))]))
        XCTAssertEqual(session.run?.step, 2)
        XCTAssertEqual(session.run?.maxSteps, 5)
        session.handleEvent(frame([("type", .string("usage")), ("runId", .string("run_1")),
                                   ("usage", .object([("totalTokens", .int(42)), ("costUsd", .number(0.01))]))]))
        XCTAssertEqual(session.usage?.totalTokens, 42)
        let artifact: JSONValue = .object([("artifactId", .string("art_1")), ("kind", .string("wav"))])
        session.handleEvent(frame([("type", .string("run_completed")), ("runId", .string("run_1")),
                                   ("text", .string("Done!")), ("artifacts", .array([artifact])), ("steps", .int(3))]))
        XCTAssertNil(session.run)
        XCTAssertEqual(session.items.last?.text, "Done!")
        XCTAssertEqual(session.items.last?.artifacts?.map { $0.artifactId }, ["art_1"])
    }

    func testSessionRunFailedRetryAndReconnect() {
        let session = AgentSession(store: WorkstationStore())
        session.handleEvent(frame([("type", .string("session_ready")), ("model", .string("m1")),
                                   ("models", .array([])), ("provider", .string("p")),
                                   ("llmConfigured", .bool(true)), ("rejectedTools", .array([])),
                                   ("history", .array([.object([("role", .string("user")), ("text", .string("add drums"))])]))]))
        session.handleEvent(frame([("type", .string("run_started")), ("runId", .string("run_2"))]))
        session.handleEvent(frame([("type", .string("run_failed")), ("runId", .string("run_2")),
                                   ("code", .string("PROVIDER_ERROR")), ("message", .string("boom")), ("retryable", .bool(true))]))
        XCTAssertNil(session.run)
        let err = session.items.last
        XCTAssertEqual(err?.role, "error")
        XCTAssertEqual(err?.text, "The AI service had a problem. Try again in a moment.")
        XCTAssertEqual(err?.retryText, "add drums", "a retryable failure offers the last user message")
        session.handleEvent(frame([("type", .string("run_started")), ("runId", .string("run_3"))]))
        XCTAssertNotNil(session.run)
        session.handleEvent(frame([("type", .string("session_reconnected")), ("resumed", .bool(false)), ("runId", .string("run_3"))]))
        XCTAssertNil(session.run, "a non-resumed reconnect clears the dangling run")
        session.handleEvent(frame([("type", .string("error")), ("code", .string("RATE_LIMITED")), ("message", .string("slow down"))]))
        XCTAssertEqual(session.items.last?.text, "Too many requests. Try again in a moment.")
    }
}
