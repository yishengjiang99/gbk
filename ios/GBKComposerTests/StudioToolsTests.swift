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

    func testValidationRejectsBadArgs() async {
        let store = WorkstationStore()
        let t = tool(store, "gbk_get_notes")
        let unknown = await runTool(store, t, .object([("bogus", .int(1))]))
        XCTAssertEqual(unknown["ok"]?.boolValue, false)
        XCTAssertEqual(unknown["error"]?["code"]?.stringValue, "INVALID_ARGUMENT")
        XCTAssertTrue((unknown["error"]?["message"]?.stringValue ?? "").contains("unexpected property bogus"))

        let mix = tool(store, "gbk_set_track_mix")
        let missing = await runTool(store, mix, .object([:]))
        XCTAssertEqual(missing["error"]?["code"]?.stringValue, "INVALID_ARGUMENT")
        XCTAssertTrue((missing["error"]?["message"]?.stringValue ?? "").contains("missing trackId"))

        let notes = await runTool(store, t, .object([("limit", .int(9999))]))
        XCTAssertEqual(notes["error"]?["code"]?.stringValue, "INVALID_ARGUMENT", "limit above the schema maximum is rejected")
    }

    func testSummaryAndTracksOnEmptyProject() async {
        let store = WorkstationStore()
        let r = await runTool(store, tool(store, "gbk_get_project_summary"), .object([:]))
        XCTAssertEqual(r["ok"]?.boolValue, true)
        XCTAssertEqual(r["projectId"]?.stringValue, store.project.id)
        XCTAssertEqual(r["data"]?["noteCount"]?.intValue, 0)
        XCTAssertEqual(r["data"]?["trackCount"]?.intValue, 0)
        let caps = await runTool(store, tool(store, "gbk_get_capabilities"), .object([:]))
        XCTAssertEqual(caps["data"]?["controllers"]?["91"]?["audible"]?.boolValue, true)
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

        let digest = await runTool(store, tool(store, "gbk_get_score_digest"), .object([:]))
        XCTAssertEqual(digest["ok"]?.boolValue, true)
        XCTAssertFalse((digest["data"]?["chords"]?.objectValue ?? []).isEmpty, "digest estimates per-bar chords")
    }

    func testProposalLifecycleThroughTools() async throws {
        let store = WorkstationStore()
        var p = emptyProject(name: "User Song")
        p.tracks = [GTrack(id: "t1", name: "Piano", channel: 0, color: "#fff", mix: .default, visible: true, role: nil)]
        store.load(p)
        let patch = await runTool(store, tool(store, "gbk_propose_note_patch"), .object([
            ("add", .array([.object([
                ("trackId", .string("t1")), ("tick", .int(0)), ("duration", .int(480)),
                ("pitch", .int(60)), ("velocity", .int(100)),
            ])])),
            ("summary", .string("add middle C")),
        ]))
        XCTAssertEqual(patch["ok"]?.boolValue, true, String(describing: patch["error"]))
        XCTAssertEqual(store.project.notes.count, 0, "proposal does not mutate")
        let proposalId = try XCTUnwrap(patch["data"]?["proposalId"]?.stringValue)

        store.approvalHandler = { _ in true }
        let commit = await runTool(store, tool(store, "gbk_commit_proposal"), .object([("proposalId", .string(proposalId))]))
        XCTAssertEqual(commit["ok"]?.boolValue, true, String(describing: commit["error"]))
        XCTAssertEqual(store.project.notes.count, 1, "commit applied the note after approval")

        let undo = await runTool(store, tool(store, "gbk_undo"), .object([:]))
        XCTAssertEqual(undo["ok"]?.boolValue, true)
        XCTAssertEqual(store.project.notes.count, 0, "agent undo reverts its own committed proposal")
    }

    func testSetInstrumentAndMix() async throws {
        let store = WorkstationStore()
        var p = emptyProject(name: "Mix Song")
        p.tracks = [GTrack(id: "t1", name: "Piano", channel: 0, color: "#fff", mix: .default, visible: true, role: nil)]
        store.load(p)
        let inst = await runTool(store, tool(store, "gbk_set_instrument"),
                                 .object([("trackId", .string("Piano")), ("program", .int(73))]))
        XCTAssertEqual(inst["ok"]?.boolValue, true, String(describing: inst["error"]))
        XCTAssertEqual(store.project.programs.first { $0.trackId == "t1" }?.program, 73, "track resolved by name")

        let mix = await runTool(store, tool(store, "gbk_set_track_mix"),
                                .object([("trackId", .string("t1")), ("volume", .int(90))]))
        XCTAssertEqual(mix["ok"]?.boolValue, true)
        XCTAssertEqual(store.project.tracks[0].mix.volume, 90)
    }

    func testPercussionPitchGuard() async {
        let store = WorkstationStore()
        var p = emptyProject(name: "Drums")
        p.tracks = [GTrack(id: "d1", name: "Kit", channel: 9, color: "#fff", mix: .default, visible: true, role: "percussion")]
        p.notes = [GNote(id: "n1", trackId: "d1", channel: 9, tick: 0, duration: 120, pitch: 36, velocity: 100, offVelocity: nil)]
        store.load(p)
        let r = await runTool(store, tool(store, "gbk_transform_notes"), .object([
            ("trackId", .string("d1")),
            ("range", .object([("unit", .string("bars")), ("start", .number(1)), ("end", .number(1))])),
            ("transform", .string("transpose")), ("semitones", .int(2)),
        ]))
        XCTAssertEqual(r["ok"]?.boolValue, false)
        XCTAssertEqual(r["error"]?["code"]?.stringValue, "PERCUSSION_PITCH_GUARD")
    }

    func testCurveGeneration() throws {
        let pts = try generateCurve(CurveSpec(shape: "crescendo", startTick: 0, endTick: 1920), ppq: 480)
        XCTAssertEqual(pts.first?.tick, 0)
        XCTAssertEqual(pts.first?.value, 40)
        XCTAssertEqual(pts.last?.tick, 1920)
        XCTAssertEqual(pts.last?.value, 110)
        XCTAssertTrue(zip(pts, pts.dropFirst()).allSatisfy { $0.1.value >= $0.0.value }, "crescendo is monotonic")
    }

    func testWavAnalysisAndArtifactRoundTrip() throws {
        // Synthetic PCM16 WAV: 0.5 s of a 0.5-amplitude sine at 44.1 kHz stereo.
        let frames = 22050
        var fmtBody = Data()
        var v16: UInt16 = 1; fmtBody.append(Data(bytes: &v16, count: 2)) // PCM
        v16 = 2; fmtBody.append(Data(bytes: &v16, count: 2)) // channels
        var v32: UInt32 = 44100; fmtBody.append(Data(bytes: &v32, count: 4))
        v32 = 44100 * 4; fmtBody.append(Data(bytes: &v32, count: 4))
        v16 = 4; fmtBody.append(Data(bytes: &v16, count: 2))
        v16 = 16; fmtBody.append(Data(bytes: &v16, count: 2))
        var samples = Data()
        for i in 0..<frames {
            let x = Int16(0.5 * 32767 * sin(2 * Double.pi * 440 * Double(i) / 44100))
            var le = x.littleEndian
            samples.append(Data(bytes: &le, count: 2)); samples.append(Data(bytes: &le, count: 2))
        }
        var riff = Data("WAVE".utf8)
        var f = Data("fmt ".utf8); var fs = UInt32(fmtBody.count).littleEndian; f.append(Data(bytes: &fs, count: 4)); f.append(fmtBody); riff.append(f)
        var d = Data("data".utf8); var ds = UInt32(samples.count).littleEndian; d.append(Data(bytes: &ds, count: 4)); d.append(samples); riff.append(d)
        var out = Data("RIFF".utf8); var rs = UInt32(riff.count).littleEndian; out.append(Data(bytes: &rs, count: 4)); out.append(riff)
        let a = try XCTUnwrap(analyzeWav(out))
        XCTAssertEqual(a.frames, frames)
        XCTAssertEqual(a.sampleRate, 44100)
        XCTAssertEqual(a.channels, 2)
        XCTAssertEqual(a.format, "pcm16")
        XCTAssertEqual(a.peak, 0.5, accuracy: 0.01)
        XCTAssertEqual(sha256Hex(out).count, 64)

        let store = ArtifactStore()
        let meta = try store.save(kind: "wav", filename: "t.wav", mimeType: "audio/wav", sha256: sha256Hex(out),
                                  projectId: "p1", projectName: "T", revision: 0, jobId: nil, wav: nil, data: out)
        let range = try store.readRange(meta.id, offset: 10, length: 100)
        XCTAssertEqual(range.bytes.count, 100)
        XCTAssertEqual(range.eof, false)
        let tail = try store.readRange(meta.id, offset: out.count - 10, length: 100)
        XCTAssertEqual(tail.eof, true)
        XCTAssertEqual(tail.bytes.count, 10)
        try store.delete(meta.id)
        XCTAssertThrowsError(try store.meta(meta.id))
    }
}

private extension JSONValue {
    subscript(index: Int) -> JSONValue {
        guard case .array(let a) = self, a.indices.contains(index) else { return .null }
        return a[index]
    }
}
