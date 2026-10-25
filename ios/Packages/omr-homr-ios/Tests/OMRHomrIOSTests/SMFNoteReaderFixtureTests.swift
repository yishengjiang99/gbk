import XCTest
import OMRHomrIOS // public API only — the same surface `omr-test` and the app extractor use.

/// Headless SMF note parser gate (docs/TESTING.md addendum: `parse_midi(bytes).notes == expected.notes`).
///
/// 1. Hand-built byte cases for `SMFNoteReader` (running status, velocity-0 note-off, meta/sysex
///    skipping, unterminated notes, multi-track staff mapping, error paths).
/// 2. Fixture round-trip: every `fixtures/<id>/expected.tokens.json` with `status == "complete"`
///    and non-empty `symbols` → `SMFWriter().write(symbols:)` → `SMFNoteReader.read(from:)` →
///    sorted `(tick, pitch, duration)` == `expected.notes.csv` rows, exactly.
///    `staff` is asserted only when the SMF carries more than one note track (format 1: track 0 is
///    the conductor, so `staff = track - 1`; the CSV `staff` column is zero-based).
final class SMFNoteReaderFixtureTests: XCTestCase {

    // MARK: - Hand-built byte cases

    /// Format 0 single track: running status, note-on vel 0 as off, explicit 0x80 off,
    /// overlapping same pitch (FIFO), a meta event mid-track, and an unterminated note.
    func testRunningStatusVelocityZeroMetaOverlapAndUnterminatedNote() throws {
        var track: [UInt8] = []
        track += [0x00, 0x90, 60, 100]      // t0    on C4 v100
        track += [0x00, 64, 90]             // t0    on E4 v90 (running status)
        track += [0x83, 0x60, 60, 0]        // t480  C4 vel0 → off (running status, delta 480)
        track += [0x00, 0xFF, 0x01, 0x02, 0x68, 0x69] // t480 text meta (cancels running status)
        track += [0x00, 0x80, 64, 0x40]     // t480  off E4
        track += [0x00, 0x90, 67, 80]       // t480  on G4 #1
        track += [0x60, 0x90, 67, 70]       // t576  on G4 #2 (overlap)
        track += [0x60, 0x80, 67, 0x40]     // t672  off → closes G4 #1 (FIFO)
        track += [0x60, 0x80, 67, 0x40]     // t768  off → closes G4 #2
        track += [0x00, 0x91, 72, 50]       // t768  on C5 ch1, never turned off
        track += [0x81, 0x70, 0xFF, 0x2F, 0x00] // t1008 end of track

        let contents = try SMFNoteReader.read(from: Self.smf(format: 0, tracks: [track]))
        XCTAssertEqual(contents.header, .init(format: 0, trackCount: 1, division: 480))
        XCTAssertEqual(contents.parsedTrackCount, 1)
        XCTAssertEqual(contents.noteTrackCount, 1)
        XCTAssertEqual(contents.notes, [
            SMFNote(tick: 0, pitch: 60, duration: 480, track: 0, channel: 0, velocity: 100),
            SMFNote(tick: 0, pitch: 64, duration: 480, track: 0, channel: 0, velocity: 90),
            SMFNote(tick: 480, pitch: 67, duration: 192, track: 0, channel: 0, velocity: 80),
            SMFNote(tick: 576, pitch: 67, duration: 192, track: 0, channel: 0, velocity: 70),
            // Unterminated: closed at the track's final tick (EOT at 1008).
            SMFNote(tick: 768, pitch: 72, duration: 240, track: 0, channel: 1, velocity: 50),
        ])
        // Format 0: the single track is staff 0.
        XCTAssertEqual(contents.notes.map { contents.staff(of: $0) }, [0, 0, 0, 0, 0])
    }

    /// Running status carries across note-on → note-on(vel 0) and program/pressure (1 data byte)
    /// messages don't desync the parser.
    func testRunningStatusAcrossOneByteMessages() throws {
        var track: [UInt8] = []
        track += [0x00, 0xC0, 0x00]         // program change 0 (1 data byte)
        track += [0x00, 0xD0, 0x10]         // channel pressure (1 data byte)
        track += [0x00, 0x90, 62, 64]       // on D4
        track += [0x81, 0x70, 62, 0]        // t240 running-status vel0 → off
        track += [0x00, 65, 64]             // t240 running-status on F4
        track += [0x81, 0x70, 65, 0]        // t480 off
        track += [0x00, 0xFF, 0x2F, 0x00]
        let notes = try SMFNoteReader.notes(from: Self.smf(format: 0, tracks: [track]))
        XCTAssertEqual(notes.map(\.tick), [0, 240])
        XCTAssertEqual(notes.map(\.pitch), [62, 65])
        XCTAssertEqual(notes.map(\.duration), [240, 240])
        XCTAssertEqual(notes.map(\.velocity), [64, 64])
    }

    /// Sysex (F0) and escape (F7) events are skipped by their VLQ length; a stray note-off is ignored.
    func testSkipsSysexAndIgnoresStrayNoteOff() throws {
        var track: [UInt8] = []
        track += [0x00, 0xF0, 0x05, 0x7E, 0x7F, 0x09, 0x01, 0xF7] // GM reset sysex
        track += [0x00, 0xF7, 0x02, 0x01, 0x02]                     // escape packet
        track += [0x00, 0x80, 50, 0x40]                             // stray off (no pending on)
        track += [0x00, 0x90, 60, 80]
        track += [0x83, 0x60, 0x80, 60, 0x40]
        track += [0x00, 0xFF, 0x2F, 0x00]
        let notes = try SMFNoteReader.notes(from: Self.smf(format: 0, tracks: [track]))
        XCTAssertEqual(notes, [SMFNote(tick: 0, pitch: 60, duration: 480, track: 0, channel: 0, velocity: 80)])
    }

    /// Sysex cancels running status: a data byte right after it is malformed.
    func testDataByteAfterSysexWithoutStatusThrows() {
        var track: [UInt8] = []
        track += [0x00, 0x90, 60, 80]
        track += [0x00, 0xF0, 0x01, 0xF7]
        track += [0x00, 64, 80] // would need running status → invalid
        track += [0x00, 0xFF, 0x2F, 0x00]
        XCTAssertThrowsError(try SMFNoteReader.notes(from: Self.smf(format: 0, tracks: [track]))) { error in
            guard case .unexpectedDataByte? = error as? SMFNoteReader.ReadError else {
                return XCTFail("expected unexpectedDataByte, got \(error)")
            }
        }
    }

    /// Format 1: conductor (track 0) + two staff tracks. `staff = track - 1`; sort is (tick, track, pitch).
    func testFormat1TrackToStaffMappingAndSortOrder() throws {
        let conductor: [UInt8] = [0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20, 0x00, 0xFF, 0x2F, 0x00]
        let upper: [UInt8] = [
            0x00, 0x90, 72, 80, 0x83, 0x60, 0x80, 72, 0x40,
            0x00, 0x90, 67, 80, 0x83, 0x60, 0x80, 67, 0x40,
            0x00, 0xFF, 0x2F, 0x00,
        ]
        let lower: [UInt8] = [
            0x00, 0x90, 48, 80, 0x87, 0x40, 0x80, 48, 0x40, // t0 C3, 960 ticks
            0x00, 0xFF, 0x2F, 0x00,
        ]
        let contents = try SMFNoteReader.read(from: Self.smf(format: 1, tracks: [conductor, upper, lower]))
        XCTAssertEqual(contents.header, .init(format: 1, trackCount: 3, division: 480))
        XCTAssertEqual(contents.parsedTrackCount, 3)
        XCTAssertEqual(contents.noteTrackCount, 2)
        XCTAssertEqual(contents.notes.map(\.tick), [0, 0, 480])
        XCTAssertEqual(contents.notes.map(\.track), [1, 2, 1])
        XCTAssertEqual(contents.notes.map(\.pitch), [72, 48, 67])
        XCTAssertEqual(contents.notes.map(\.duration), [480, 960, 480])
        XCTAssertEqual(contents.notes.map(\.staff), [0, 1, 0])
        XCTAssertEqual(contents.notes.map { contents.staff(of: $0) }, [0, 1, 0])
    }

    func testStaffTrackMappingHelpers() {
        XCTAssertNil(SMFNoteReader.staff(forTrack: 0), "format 1 conductor has no staff")
        XCTAssertEqual(SMFNoteReader.staff(forTrack: 1), 0)
        XCTAssertEqual(SMFNoteReader.staff(forTrack: 2), 1)
        XCTAssertEqual(SMFNoteReader.staff(forTrack: 0, format: 0), 0)
        XCTAssertNil(SMFNoteReader.staff(forTrack: -1))
        XCTAssertEqual(SMFNoteReader.track(forStaff: 0), 1)
        XCTAssertEqual(SMFNoteReader.track(forStaff: 1), 2)
        XCTAssertNil(SMFNote(tick: 0, pitch: 60, duration: 1, track: 0, velocity: 1).staff)
    }

    /// Unknown chunk types between tracks are skipped and do not advance the track index.
    func testSkipsUnknownChunks() throws {
        let noteTrack: [UInt8] = [0x00, 0x90, 60, 80, 0x83, 0x60, 0x80, 60, 0x40, 0x00, 0xFF, 0x2F, 0x00]
        var bytes = [UInt8](Self.smf(format: 1, tracks: []))
        bytes[11] = 2 // declare 2 tracks
        bytes += Self.chunk("MTrk", [0x00, 0xFF, 0x2F, 0x00])
        bytes += Self.chunk("XFIH", [1, 2, 3, 4, 5])
        bytes += Self.chunk("MTrk", noteTrack)
        let contents = try SMFNoteReader.read(from: Data(bytes))
        XCTAssertEqual(contents.parsedTrackCount, 2)
        XCTAssertEqual(contents.notes, [SMFNote(tick: 0, pitch: 60, duration: 480, track: 1, channel: 0, velocity: 80)])
    }

    func testErrorPaths() {
        XCTAssertThrowsError(try SMFNoteReader.notes(from: Data("not midi at all".utf8))) {
            XCTAssertEqual($0 as? SMFNoteReader.ReadError, .notSMF)
        }
        var smpte = [UInt8](Self.smf(format: 0, tracks: [[0x00, 0xFF, 0x2F, 0x00]]))
        smpte[12] = 0xE7 // -25 fps SMPTE division
        smpte[13] = 0x28
        XCTAssertThrowsError(try SMFNoteReader.notes(from: Data(smpte))) {
            XCTAssertEqual($0 as? SMFNoteReader.ReadError, .smpteDivisionUnsupported)
        }
        var truncated = [UInt8](Self.smf(format: 0, tracks: [[0x00, 0x90, 60, 80, 0x00, 0xFF, 0x2F, 0x00]]))
        truncated.removeLast(3)
        XCTAssertThrowsError(try SMFNoteReader.notes(from: Data(truncated))) {
            guard case .truncated? = $0 as? SMFNoteReader.ReadError else {
                return XCTFail("expected truncated, got \($0)")
            }
        }
    }

    func testEmptyWriterOutputHasNoNotes() throws {
        let contents = try SMFNoteReader.read(from: SMFWriter().writeEmpty())
        XCTAssertEqual(contents.header.format, 1)
        XCTAssertEqual(contents.header.division, Int(SMFWriter.ticksPerQuarter))
        XCTAssertTrue(contents.notes.isEmpty)
    }

    // MARK: - Fixture gate: SMF bytes → notes == expected.notes.csv

    func testFixtureMIDIParsesToExpectedNotesCSV() throws {
        let fixtures = try Self.loadCompleteFixtures()
        XCTAssertFalse(fixtures.isEmpty, "no complete fixtures with symbols found")

        for fx in fixtures {
            let smf = SMFWriter().write(symbols: fx.symbols)
            let contents = try SMFNoteReader.read(from: smf)
            XCTAssertEqual(contents.header.format, 1, "\(fx.id): SMF format")
            XCTAssertEqual(contents.header.division, 480, "\(fx.id): SMF division")
            XCTAssertFalse(
                contents.notes.contains { $0.track == SMFNoteReader.conductorTrackIndex },
                "\(fx.id): notes found on the conductor track"
            )

            let got = contents.notes.map { TPD(tick: $0.tick, pitch: $0.pitch, duration: $0.duration) }.sorted()
            let want = fx.expected.map { TPD(tick: $0.tick, pitch: $0.pitch, duration: $0.duration) }.sorted()
            XCTAssertEqual(got, want, "\(fx.id): SMF (tick,pitch,duration) != expected.notes.csv\n got=\(got)\nwant=\(want)")
        }
        print("SMFNoteReader fixture gate covered=\(fixtures.map(\.id))")
    }

    /// Staff is only recoverable when the writer emits more than one note track.
    func testFixtureStaffMatchesCSVWhenMultipleNoteTracks() throws {
        var asserted: [String] = []
        var skipped: [String] = []
        for fx in try Self.loadCompleteFixtures() {
            let contents = try SMFNoteReader.read(from: SMFWriter().write(symbols: fx.symbols))
            guard contents.noteTrackCount > 1 else {
                skipped.append("\(fx.id) (noteTracks=\(contents.noteTrackCount))")
                continue
            }
            let got = try contents.notes.map { n -> TPDS in
                let staff = try XCTUnwrap(contents.staff(of: n), "\(fx.id): note \(n) has no staff")
                return TPDS(tick: n.tick, pitch: n.pitch, duration: n.duration, staff: staff)
            }.sorted()
            let want = fx.expected.sorted()
            XCTAssertEqual(got, want, "\(fx.id): SMF (tick,pitch,duration,staff) != expected.notes.csv")
            asserted.append(fx.id)
        }
        print("SMFNoteReader staff check asserted=\(asserted) skipped=\(skipped)")
        if asserted.isEmpty {
            throw XCTSkip(
                "staff not checked: every fixture's SMF has a single note track, so staff "
                    + "(= track - 1) is not recoverable from the SMF. Skipped: \(skipped.joined(separator: ", "))"
            )
        }
    }

    // MARK: - Private helpers

    private struct TPD: Comparable, CustomStringConvertible {
        var tick: Int
        var pitch: Int
        var duration: Int
        var description: String { "(\(tick),\(pitch),\(duration))" }
        static func < (a: TPD, b: TPD) -> Bool {
            (a.tick, a.pitch, a.duration) < (b.tick, b.pitch, b.duration)
        }
    }

    private struct TPDS: Comparable, CustomStringConvertible {
        var tick: Int
        var pitch: Int
        var duration: Int
        var staff: Int
        var description: String { "(\(tick),\(pitch),\(duration),\(staff))" }
        static func < (a: TPDS, b: TPDS) -> Bool {
            (a.tick, a.pitch, a.duration, a.staff) < (b.tick, b.pitch, b.duration, b.staff)
        }
    }

    private struct CompleteFixture {
        var id: String
        var symbols: [EncodedSymbol]
        var expected: [TPDS]
    }

    private struct TokenFile: Decodable {
        var status: String?
        var symbols: [OracleSymbolFields]?
    }

    /// Every `fixtures/<id>/` whose tokens are `complete` with symbols; others are skipped (logged).
    private static func loadCompleteFixtures() throws -> [CompleteFixture] {
        let root = try fixturesRoot()
        let fm = FileManager.default
        var out: [CompleteFixture] = []
        var skipped: [String] = []
        for id in try fm.contentsOfDirectory(atPath: root.path).sorted() {
            let dir = root.appendingPathComponent(id)
            let tokensURL = dir.appendingPathComponent("expected.tokens.json")
            guard fm.fileExists(atPath: tokensURL.path) else {
                skipped.append("\(id) (no tokens)")
                continue
            }
            let file = try JSONDecoder().decode(TokenFile.self, from: Data(contentsOf: tokensURL))
            let symbols = file.symbols ?? []
            guard file.status == "complete", !symbols.isEmpty else {
                skipped.append("\(id) (status=\(file.status ?? "nil"), symbols=\(symbols.count))")
                continue
            }
            let notesURL = dir.appendingPathComponent("expected.notes.csv")
            guard fm.fileExists(atPath: notesURL.path) else {
                throw error("\(id): complete tokens but no expected.notes.csv")
            }
            out.append(CompleteFixture(
                id: id,
                symbols: symbols.map {
                    EncodedSymbol(
                        rhythm: $0.rhythm, pitch: $0.pitch, lift: $0.lift,
                        articulation: $0.articulation, slur: $0.slur, position: $0.position
                    )
                },
                expected: try loadNotesCSV(notesURL)
            ))
        }
        print("SMFNoteReader fixtures skipped=\(skipped)")
        return out
    }

    /// `Packages/omr-homr-ios/Tests/OMRHomrIOSTests/<file>` → repo root → `fixtures/`.
    private static func fixturesRoot() throws -> URL {
        let fixtures = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // OMRHomrIOSTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // omr-homr-ios
            .deletingLastPathComponent() // Packages
            .deletingLastPathComponent() // repo root
            .appendingPathComponent("fixtures")
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: fixtures.path, isDirectory: &isDir), isDir.boolValue else {
            throw error("fixtures/ not found at \(fixtures.path)")
        }
        return fixtures
    }

    /// `tick,pitch,duration,staff` (header row optional; staff zero-based).
    private static func loadNotesCSV(_ url: URL) throws -> [TPDS] {
        var out: [TPDS] = []
        for (lineNo, raw) in try String(contentsOf: url, encoding: .utf8).components(separatedBy: .newlines).enumerated() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || (lineNo == 0 && line.lowercased().hasPrefix("tick")) { continue }
            let c = line.split(separator: ",").map { Int($0.trimmingCharacters(in: .whitespaces)) }
            guard c.count >= 4, let t = c[0], let p = c[1], let d = c[2], let s = c[3] else {
                throw error("bad CSV row in \(url.path): \(line)")
            }
            out.append(TPDS(tick: t, pitch: p, duration: d, staff: s))
        }
        return out
    }

    private static func error(_ message: String) -> NSError {
        NSError(domain: "SMFNoteReaderFixtureTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private static func chunk(_ tag: String, _ body: [UInt8]) -> [UInt8] {
        let n = body.count
        return Array(tag.utf8) + [UInt8((n >> 24) & 0xFF), UInt8((n >> 16) & 0xFF), UInt8((n >> 8) & 0xFF), UInt8(n & 0xFF)] + body
    }

    private static func smf(format: UInt16, division: UInt16 = 480, tracks: [[UInt8]]) -> Data {
        let count = UInt16(tracks.count)
        var bytes = chunk("MThd", [
            UInt8(format >> 8), UInt8(format & 0xFF),
            UInt8(count >> 8), UInt8(count & 0xFF),
            UInt8(division >> 8), UInt8(division & 0xFF),
        ])
        for t in tracks { bytes += chunk("MTrk", t) }
        return Data(bytes)
    }
}
