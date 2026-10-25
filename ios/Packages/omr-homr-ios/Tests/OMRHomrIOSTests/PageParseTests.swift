// SPDX-License-Identifier: AGPL-3.0-or-later
//
// omr-sheet-cam — page parse (milestone 3): homr voice assembly + cleanup, SMF rendering, input handling.
// Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e (AGPL-3.0): checks parse_staffs /
// remove_duplicated_symbols / predict_best against homr outputs in fixtures/oracle.pages/<id>/stages.json.
import Foundation
import XCTest
@testable import OMRHomrIOS

final class PageParseTests: XCTestCase {
    private struct Sym: Decodable {
        var rhythm, pitch, lift, articulation, slur, position: String
        var encoded: EncodedSymbol {
            EncodedSymbol(rhythm: rhythm, pitch: pitch, lift: lift, articulation: articulation, slur: slur, position: position)
        }
    }
    private struct Stages: Decodable {
        struct Input: Decodable {
            var is_grandstaff: Bool
            var symbols: [Sym]
            var symbols_after_position_filter: [Sym]
        }
        var staff_inputs: [Input]
        var voices: [[Sym]]
    }

    private func stages(_ fid: String) throws -> Stages {
        let url = try WriterOnlyFixtureTests.fixturesRoot().appendingPathComponent("oracle.pages/\(fid)/stages.json")
        return try JSONDecoder().decode(Stages.self, from: Data(contentsOf: url))
    }

    private let fixtures = ["camera.deskew", "clefs.bass", "mono.c_major_scale", "mono.rests", "mono.rhythms",
                            "mono.sharps_flats", "piano.grand", "poly.chord", "synthetic.page_on_table"]

    /// homr decoder output -> position filter -> newline + remove_duplicated_symbols == homr voices, all pages.
    func testVoiceAssemblyMatchesHomr() throws {
        for fid in fixtures {
            let st = try stages(fid)
            var stream: [EncodedSymbol] = []
            for inp in st.staff_inputs {
                let filtered = SymbolCleanup.positionFilter(inp.symbols.map(\.encoded), isGrandstaff: inp.is_grandstaff)
                XCTAssertEqual(filtered, inp.symbols_after_position_filter.map(\.encoded), fid)
                if filtered.isEmpty { continue }
                stream += filtered + [EncodedSymbol(rhythm: "newline")]
            }
            XCTAssertEqual(st.voices.count, 1, fid)
            XCTAssertEqual(SymbolCleanup.removeDuplicatedSymbols(stream), st.voices[0].map(\.encoded), fid)
        }
    }

    func testRemoveDuplicatedSymbolsRules() {
        func n(_ r: String, _ p: String, _ pos: String = "upper") -> EncodedSymbol {
            EncodedSymbol(rhythm: r, pitch: p, lift: "_", articulation: "_", slur: "_", position: pos)
        }
        let clefG = EncodedSymbol(rhythm: "clef_G2", pitch: "_", lift: "_", articulation: "_", slur: "_", position: "upper")
        let chord = EncodedSymbol(rhythm: "chord")
        let bar = EncodedSymbol(rhythm: "barline")
        let nl = EncodedSymbol(rhythm: "newline")
        // Repeated clef on the next row is dropped; duplicate pitch in a chord keeps the first.
        let input = [clefG, n("note_4", "C4"), chord, n("note_2", "C4"), bar, nl, clefG, n("note_4", "D4"), bar, nl]
        let want = [clefG, n("note_4", "C4"), bar, nl, n("note_4", "D4"), bar, nl]
        XCTAssertEqual(SymbolCleanup.removeDuplicatedSymbols(input), want)
        // No lower clef anywhere -> lower symbols move to upper.
        XCTAssertEqual(SymbolCleanup.removeDuplicatedSymbols([n("note_4", "C3", "lower")]), [n("note_4", "C3", "upper")])
        // Tuplets are removed from measures shorter than the typical measure.
        let triplets = [n("note_4", "C4"), n("note_4", "D4"), bar, n("note_4", "C4"), n("note_4", "D4"), bar,
                        n("note_12", "E4"), n("note_12", "F4"), bar]
        let fixed = SymbolCleanup.removeDuplicatedSymbols(triplets)
        XCTAssertEqual(fixed[6].rhythm, "note_8")
        XCTAssertEqual(fixed[7].rhythm, "note_8")
        XCTAssertEqual(SymbolCleanup.kernFraction("12"), HFraction(1, 12))
        XCTAssertEqual(SymbolCleanup.kernFraction("4."), HFraction(3, 8))
        XCTAssertEqual(SymbolCleanup.kernFraction("8G"), HFraction(0))
    }

    /// Block-order grand staff (treble block, then bass block — rhythmically independent
    /// hands): a bass clef mid-stream still marks a grand staff, so lower positions survive
    /// cleanup instead of being converted to upper…
    func testBlockOrderGrandStaffKeepsLowerPositions() {
        let cleaned = SymbolCleanup.removeDuplicatedSymbols(Self.blockOrderVoice())
        XCTAssertEqual(cleaned.map(\.position), ["upper", "upper", "upper", "lower", "lower", "lower"])
    }

    /// …and the two hands sound simultaneously (same onsets), on staff tracks 0 and 1.
    func testBlockOrderGrandStaffSimultaneous() {
        let r = PagePipeline.render(voices: [SymbolCleanup.removeDuplicatedSymbols(Self.blockOrderVoice())],
                                    grandstaffVoices: [0])
        XCTAssertEqual(r.staffCount, 2)
        XCTAssertEqual(r.noteLayout.filter { $0.staffIndex == 0 }.map(\.onsetTicks), [0, 480])
        XCTAssertEqual(r.noteLayout.filter { $0.staffIndex == 1 }.map(\.onsetTicks), [0, 480])
        // symbolIndex still addresses the pre-split voice stream (box-attach seam).
        XCTAssertEqual(r.noteLayout.map(\.symbolIndex).sorted(), [1, 2, 4, 5])
    }

    /// Two treble quarters, then bass clef + two bass quarters (no `chord` markers).
    private static func blockOrderVoice() -> [EncodedSymbol] {
        func n(_ r: String, _ p: String, _ pos: String = "upper") -> EncodedSymbol {
            EncodedSymbol(rhythm: r, pitch: p, lift: "_", articulation: "_", slur: "_", position: pos)
        }
        return [
            EncodedSymbol(rhythm: "clef_G2", pitch: "_", lift: "_", articulation: "_", slur: "_", position: "upper"),
            n("note_4", "C5"), n("note_4", "D5"),
            EncodedSymbol(rhythm: "clef_F4", pitch: "_", lift: "_", articulation: "_", slur: "_", position: "lower"),
            n("note_4", "C3", "lower"), n("note_4", "D3", "lower"),
        ]
    }

    /// Grand staff voice -> 2 staff tracks; a second voice goes below it; time runs across rows (no clef reset).
    func testRenderVoicesTracksAndTiming() throws {
        let st = try stages("piano.grand")
        let grand = st.voices[0].map(\.encoded)
        let single = [EncodedSymbol(rhythm: "clef_G2", pitch: "_", lift: "_", articulation: "_", slur: "_", position: "upper"),
                      EncodedSymbol(rhythm: "note_4", pitch: "C4", lift: "_", articulation: "_", slur: "_", position: "upper"),
                      EncodedSymbol(rhythm: "newline"),
                      EncodedSymbol(rhythm: "clef_F4", pitch: "_", lift: "_", articulation: "_", slur: "_", position: "upper"),
                      EncodedSymbol(rhythm: "note_4", pitch: "C3", lift: "_", articulation: "_", slur: "_", position: "upper")]
        let r = PagePipeline.render(voices: [grand, single], grandstaffVoices: [0])
        XCTAssertEqual(r.staffCount, 3)
        let smf = try SMFNoteReader.read(from: r.midi)
        XCTAssertEqual(smf.parsedTrackCount, 4)
        XCTAssertEqual(smf.notes.count, r.noteLayout.count)
        XCTAssertEqual(Set(r.noteLayout.map(\.staffIndex)), [0, 1, 2])
        let v1 = r.noteLayout.filter { $0.staffIndex == 2 }
        XCTAssertEqual(v1.map(\.onsetTicks), [0, 480])  // clef change does not rewind time
        XCTAssertEqual(v1.map(\.symbolIndex), [grand.count + 1, grand.count + 4])
        for (k, e) in r.noteLayout.enumerated() { XCTAssertEqual(e.noteIndex, k) }
    }

    /// Two-system piano score as one merged grandstaff voice: each row carries treble
    /// (upper) then bass (lower) symbols. System 2 must start after system 1 ends;
    /// the two hands of one system sound simultaneously. Regression test for
    /// "all staffs at once".
    func testMultiSystemPianoSequentialSystems() {
        func n(_ r: String, _ p: String, _ pos: String = "upper") -> EncodedSymbol {
            EncodedSymbol(rhythm: r, pitch: p, lift: "_", articulation: "_", slur: "_", position: pos)
        }
        let nl = EncodedSymbol(rhythm: "newline", pitch: "_", lift: "_", articulation: "_", slur: "_", position: "upper")
        // System 1: treble C5 D5 (quarters), bass C3 D3 (quarters).
        // System 2: treble E5 F5, bass E3 F3.
        let voice: [EncodedSymbol] = [
            n("note_4", "C5"), n("note_4", "D5"),
            n("note_4", "C3", "lower"), n("note_4", "D3", "lower"), nl,
            n("note_4", "E5"), n("note_4", "F5"),
            n("note_4", "E3", "lower"), n("note_4", "F3", "lower"), nl,
        ]
        let r = PagePipeline.render(voices: [voice], grandstaffVoices: [0])
        XCTAssertEqual(r.staffCount, 2)
        let treble = r.noteLayout.filter { $0.staffIndex == 0 }
        let bass = r.noteLayout.filter { $0.staffIndex == 1 }
        XCTAssertEqual(treble.count, 4)
        XCTAssertEqual(bass.count, 4)
        // Sequential systems per hand (quarter = 480 ticks).
        XCTAssertEqual(treble.map(\.onsetTicks), [0, 480, 960, 1440])
        XCTAssertEqual(bass.map(\.onsetTicks), [0, 480, 960, 1440])
        // Hands of the same system are simultaneous.
        XCTAssertEqual(treble[0].onsetTicks, bass[0].onsetTicks)
        XCTAssertEqual(treble[2].onsetTicks, bass[2].onsetTicks)
    }

    func testInputHandling() {        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46])
        XCTAssertThrowsError(try OMRHomrIOS.parseSheetMusicWithLayout(input: ParseSheetMusicInput(imageData: jpeg, staffOnly: false))) {
            guard case OMRError.unsupportedImageFormat = $0 else { return XCTFail("got \($0)") }
        }
        XCTAssertThrowsError(try OMRHomrIOS.parseSheetMusicWithLayout(gray8: Data(count: 10), width: 4, height: 4)) {
            guard case OMRError.invalidPixelBuffer = $0 else { return XCTFail("got \($0)") }
        }
        XCTAssertEqual(PagePipeline.maskedPage([10, 20, 30], noiseMask: [255, 0, 255]), [10, 0, 30])
        XCTAssertEqual(PagePipeline.maskedPage([10, 20, 30], noiseMask: nil), [10, 20, 30])
    }

    func testModelFilePicking() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("omr-models-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        for n in ["segnet_1_fp16.onnx", "encoder_2_fp16.onnx", "decoder_2.onnx", "decoder_2_fp16.onnx"] {
            _ = FileManager.default.createFile(atPath: dir.appendingPathComponent(n).path, contents: Data())
        }
        let f = try PageModels.files(in: dir)
        XCTAssertEqual(f.segnet.lastPathComponent, "segnet_1_fp16.onnx")
        XCTAssertEqual(f.encoder.lastPathComponent, "encoder_2_fp16.onnx")
        XCTAssertEqual(f.decoder.lastPathComponent, "decoder_2.onnx")
        XCTAssertThrowsError(try PageModels.files(in: dir.appendingPathComponent("missing")))
    }

    /// End to end on the C-scale page (real models, ~40 s in debug): identical to homr (12 tokens, 8 notes).
    func testCScalePageEndToEnd() throws {
        #if canImport(CONNXRuntime)
        guard ProcessInfo.processInfo.environment["OMR_SLOW_TESTS"] == "1" else {
            throw XCTSkip("set OMR_SLOW_TESTS=1 (release check: omr-test parse-page --compare)")
        }
        let fixtures = try WriterOnlyFixtureTests.fixturesRoot()
        let models = fixtures.deletingLastPathComponent().appendingPathComponent("models")
        let session: PageInferenceSession
        do { session = try PageInferenceSession.load(modelsDirectory: models) } catch {
            throw XCTSkip("pinned models missing; run scripts/fetch-models (\(error))")
        }
        let png = try Data(contentsOf: fixtures.appendingPathComponent("mono.c_major_scale/input.png"))
        let r = try session.parsePage(png: png)
        let st = try stages("mono.c_major_scale")
        // Compare the six decoder fields (decoded symbols also carry an attention payload).
        XCTAssertEqual((r.staffSymbols.first ?? []).map(\.oracleFields), st.staff_inputs[0].symbols.map(\.encoded.oracleFields))
        XCTAssertEqual((r.voices.first ?? []).map(\.oracleFields), st.voices[0].map(\.encoded.oracleFields))
        XCTAssertEqual(r.result.noteLayout.map(\.midiNote), [60, 62, 64, 65, 67, 69, 71, 72])
        #else
        throw XCTSkip("CONNXRuntime not linked")
        #endif
    }
}
