import XCTest
@testable import OMRHomrIOS

/// Layer B writer-only: hand-authored `expected.tokens.json` → note events == `expected.notes.csv`.
///
/// Fixtures live at repo-root `fixtures/` (platform-agnostic). No images; no UI.
final class WriterOnlyFixtureTests: XCTestCase {

    /// Fixture IDs with complete hand-authored tokens + notes for writer coverage.
    static let writerReadyIDs = [
        "mono.c_major_scale",
        "mono.sharps_flats",
        "mono.rhythms",
        "mono.rests",
        "poly.chord",
        "clefs.bass",
        "piano.grand",
    ]

    func testWriterOnlyFixturesMatchExpectedNotesCSV() throws {
        let vocab = try TokenizerLoader.loadVocabulary()
        let root = try Self.fixturesRoot()

        for id in Self.writerReadyIDs {
            let dir = root.appendingPathComponent(id)
            let tokensURL = dir.appendingPathComponent("expected.tokens.json")
            let notesURL = dir.appendingPathComponent("expected.notes.csv")
            XCTAssertTrue(
                FileManager.default.fileExists(atPath: tokensURL.path),
                "missing \(id)/expected.tokens.json"
            )
            XCTAssertTrue(
                FileManager.default.fileExists(atPath: notesURL.path),
                "missing \(id)/expected.notes.csv"
            )

            let fixture = try Self.loadTokenFixture(from: tokensURL)
            XCTAssertEqual(fixture.status, "complete", "\(id) should be writer-complete")
            XCTAssertFalse(fixture.symbols.isEmpty, "\(id) symbols empty")

            // Vocab gate — do not invent token strings.
            for (i, sym) in fixture.symbols.enumerated() {
                XCTAssertNotNil(vocab.rhythm[sym.rhythm], "\(id) rhythm[\(i)] \(sym.rhythm) not in vocab")
                XCTAssertNotNil(vocab.pitch[sym.pitch], "\(id) pitch[\(i)] \(sym.pitch) not in vocab")
                XCTAssertNotNil(vocab.lift[sym.lift], "\(id) lift[\(i)] \(sym.lift) not in vocab")
                XCTAssertNotNil(vocab.articulation[sym.articulation], "\(id) artic[\(i)] not in vocab")
                XCTAssertNotNil(vocab.slur[sym.slur], "\(id) slur[\(i)] not in vocab")
                XCTAssertNotNil(vocab.position[sym.position], "\(id) position[\(i)] not in vocab")
            }

            let encoded = fixture.symbols.map {
                EncodedSymbol(
                    rhythm: $0.rhythm,
                    pitch: $0.pitch,
                    lift: $0.lift,
                    articulation: $0.articulation,
                    slur: $0.slur,
                    position: $0.position
                )
            }
            let actual = SymbolMIDIMapping.noteEvents(from: encoded)
                .map { CanonicalNote(tick: $0.onsetTicks, pitch: Int($0.midiNote), duration: $0.durationTicks, staff: $0.staff) }
                .sorted()
            let expected = try Self.loadNotesCSV(from: notesURL).sorted()

            XCTAssertEqual(
                actual,
                expected,
                "writer mismatch for \(id)\nactual=\(actual)\nexpected=\(expected)"
            )

            // SMF structure: format 1 @ 480 TPQ, conductor + one track per staff.
            let smf = SMFWriter().write(symbols: encoded)
            let header = SMFHeaderInspector.readHeader(from: smf)
            XCTAssertEqual(header?.format, 1, id)
            XCTAssertEqual(header?.division, 480, id)
            let staffTracks = (expected.map(\.staff).max() ?? 0) + 1
            XCTAssertEqual(Int(header?.trackCount ?? 0), 1 + staffTracks, "\(id) track count")
            XCTAssertEqual(SMFHeaderInspector.trackChunkCount(in: smf), 1 + staffTracks, id)
            if id == "piano.grand" { XCTAssertEqual(header?.trackCount, 3, id) }
            if id.hasPrefix("mono.") { XCTAssertEqual(header?.trackCount, 2, id) }
        }
    }

    func testMonoCMajorScaleIsC4ThroughC5Quarters() throws {
        let root = try Self.fixturesRoot()
        let notes = try Self.loadNotesCSV(
            from: root.appendingPathComponent("mono.c_major_scale/expected.notes.csv")
        )
        XCTAssertEqual(notes.map(\.pitch), [60, 62, 64, 65, 67, 69, 71, 72])
        XCTAssertEqual(notes.map(\.tick), [0, 480, 960, 1440, 1920, 2400, 2880, 3360])
        XCTAssertEqual(Set(notes.map(\.duration)), [480])
        XCTAssertEqual(Set(notes.map(\.staff)), [0])
    }

    func testPolyChordSharesOnset() throws {
        let root = try Self.fixturesRoot()
        let notes = try Self.loadNotesCSV(
            from: root.appendingPathComponent("poly.chord/expected.notes.csv")
        )
        XCTAssertEqual(notes.map(\.pitch).sorted(), [60, 64, 67])
        XCTAssertEqual(Set(notes.map(\.tick)), [0])
        XCTAssertEqual(Set(notes.map(\.duration)), [480])
    }

    /// Gate-1 oracle (homr 7d97c3c export, 995a272): complete, 12 symbols, and the oracle
    /// tokens round-trip through the writer to its expected.notes.csv (C4…C5 quarters).
    func testOracleCScaleStaffCompleteAndRoundTripsThroughWriter() throws {
        let root = try Self.fixturesRoot()
        let dir = root.appendingPathComponent("oracle.c_scale_staff")
        let fixture = try Self.loadTokenFixture(from: dir.appendingPathComponent("expected.tokens.json"))
        XCTAssertEqual(fixture.status, "complete")
        XCTAssertEqual(fixture.symbols.count, 12)

        let vocab = try TokenizerLoader.loadVocabulary()
        for (i, sym) in fixture.symbols.enumerated() {
            XCTAssertNotNil(vocab.rhythm[sym.rhythm], "oracle rhythm[\(i)] \(sym.rhythm) not in vocab")
            XCTAssertNotNil(vocab.pitch[sym.pitch], "oracle pitch[\(i)] \(sym.pitch) not in vocab")
            XCTAssertNotNil(vocab.position[sym.position], "oracle position[\(i)] \(sym.position) not in vocab")
        }

        let encoded = fixture.symbols.map { EncodedSymbol(oracleFields: $0) }
        let smf = SMFWriter().write(symbols: encoded)
        let contents = try SMFNoteReader.read(from: smf)
        let actual = contents.notes.map {
            CanonicalNote(tick: $0.tick, pitch: $0.pitch, duration: $0.duration, staff: contents.staff(of: $0) ?? -1)
        }.sorted()
        let expected = try Self.loadNotesCSV(from: dir.appendingPathComponent("expected.notes.csv")).sorted()
        XCTAssertEqual(actual, expected, "oracle tokens → SMF → notes != expected.notes.csv")
        XCTAssertEqual(actual.map(\.pitch), [60, 62, 64, 65, 67, 69, 71, 72])
        XCTAssertEqual(SMFHeaderInspector.readHeader(from: smf)?.trackCount, 2, "conductor + 1 staff")
    }

    // MARK: - Helpers

    struct CanonicalNote: Equatable, Comparable, CustomStringConvertible {
        var tick: Int
        var pitch: Int
        var duration: Int
        var staff: Int

        var description: String { "(\(tick),\(pitch),\(duration),\(staff))" }

        static func < (lhs: CanonicalNote, rhs: CanonicalNote) -> Bool {
            if lhs.tick != rhs.tick { return lhs.tick < rhs.tick }
            if lhs.pitch != rhs.pitch { return lhs.pitch < rhs.pitch }
            if lhs.duration != rhs.duration { return lhs.duration < rhs.duration }
            return lhs.staff < rhs.staff
        }
    }

    struct TokenFixture: Decodable {
        var status: String
        var symbols: [OracleSymbolFields]
    }

    static func fixturesRoot() throws -> URL {
        // .../Packages/omr-homr-ios/Tests/OMRHomrIOSTests/ThisFile.swift → repo root
        let thisFile = URL(fileURLWithPath: #filePath)
        let repoRoot = thisFile
            .deletingLastPathComponent() // OMRHomrIOSTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // omr-homr-ios
            .deletingLastPathComponent() // Packages
            .deletingLastPathComponent() // repo root
        let fixtures = repoRoot.appendingPathComponent("fixtures")
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: fixtures.path, isDirectory: &isDir),
              isDir.boolValue
        else {
            throw NSError(
                domain: "WriterOnlyFixtureTests",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "fixtures/ not found at \(fixtures.path)"]
            )
        }
        return fixtures
    }

    static func loadTokenFixture(from url: URL) throws -> TokenFixture {
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(TokenFixture.self, from: data)
    }

    static func loadNotesCSV(from url: URL) throws -> [CanonicalNote] {
        let text = try String(contentsOf: url, encoding: .utf8)
        var out: [CanonicalNote] = []
        for (lineNo, raw) in text.components(separatedBy: .newlines).enumerated() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            if lineNo == 0, line.lowercased().hasPrefix("tick") { continue }
            let cols = line.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            guard cols.count >= 4,
                  let tick = Int(cols[0]),
                  let pitch = Int(cols[1]),
                  let dur = Int(cols[2]),
                  let staff = Int(cols[3])
            else {
                throw NSError(
                    domain: "WriterOnlyFixtureTests",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "bad CSV row in \(url.lastPathComponent): \(line)"]
                )
            }
            out.append(CanonicalNote(tick: tick, pitch: pitch, duration: dur, staff: staff))
        }
        return out
    }
}
