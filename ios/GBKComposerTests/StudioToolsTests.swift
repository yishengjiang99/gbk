import XCTest
@testable import GBKComposer

/// Phase 3: the gbk_* tool layer (webmcp port) — registry, manifest parity, validation,
/// runTool envelope, and end-to-end tool behavior against WorkstationStore.
final class StudioToolsTests: XCTestCase {

    private func tool(_ store: WorkstationStore, _ name: String) -> GBKTool {
        buildAllTools(store).first { $0.name == name }!
    }

    func testRegistryAndManifestParity() {
        let store = WorkstationStore()
        let tools = buildAllTools(store)
        XCTAssertEqual(tools.count, 48, "all WebMCP tools registered")
        XCTAssertEqual(Set(tools.map { $0.name }).count, 48, "tool names unique")
        let manifest = composerManifest(tools)
        XCTAssertEqual(manifest.tools.count, 41, "41 tools exposed to the Composer agent by policy")
        XCTAssertEqual(manifest.hash, "876c98b0", "manifest hash must match the web build (server rejects mismatches)")
    }

    func testCreateProjectTrackAndPartFlow() async throws {
        let store = WorkstationStore()
        let create = await runTool(store, tool(store, "gbk_create_project"),
                                   .object([("name", .string("Tool Song")), ("key", .string("G major")), ("tempo", .number(96))]))
        XCTAssertEqual(create["ok"]?.boolValue, true, String(describing: create["error"]))
        XCTAssertEqual(create["data"]?["session"]?["projectId"]?.stringValue, store.project.id)
        XCTAssertTrue(store.autonomousAllowed(), "agent-owned project in an autonomous session")

        let track = await runTool(store, tool(store, "gbk_create_track"),
                                  .object([("name", .string("Violin")), ("program", .int(40)), ("role", .string("melody"))]))
        XCTAssertEqual(track["ok"]?.boolValue, true, String(describing: track["error"]))
        XCTAssertEqual(track["data"]?["committed"]?.boolValue, true, "autonomous session commits directly")
        let trackId = try XCTUnwrap(track["data"]?["trackIds"]?[0].stringValue)
        XCTAssertEqual(store.project.tracks.count, 1)
        XCTAssertEqual(store.project.programs.first { $0.trackId == trackId }?.program, 40)

        let part = await runTool(store, tool(store, "gbk_generate_part"), .object([
            ("trackId", .string(trackId)),
            ("range", .object([("unit", .string("bars")), ("start", .number(1)), ("end", .number(4))])),
            ("kind", .string("melody")), ("seed", .int(3)),
        ]))
        XCTAssertEqual(part["ok"]?.boolValue, true, String(describing: part["error"]))
        XCTAssertGreaterThan(store.project.notes.count, 0, "melody generated real notes")

        let digest = await runTool(store, tool(store, "gbk_get_score_digest"), .object([]))
        XCTAssertEqual(digest["ok"]?.boolValue, true)
        XCTAssertFalse((digest["data"]?["chords"]?.objectValue ?? []).isEmpty, "digest estimates per-bar chords")
    }
}

private extension JSONValue {
    subscript(index: Int) -> JSONValue {
        guard case .array(let a) = self, a.indices.contains(index) else { return .null }
        return a[index]
    }
}
