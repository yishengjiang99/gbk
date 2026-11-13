import SF2Player
import XCTest
@testable import GBKComposer

/// Hostile or broken music data must fail the song, never trap or exhaust memory (#139).
final class MusicInputLimitsTests: XCTestCase {
    private func smf(_ track: [UInt8]) -> Data {
        let n = track.count
        let head: [UInt8] = Array("MThd".utf8) + [0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xE0] + Array("MTrk".utf8)
        return Data(head + [UInt8(n >> 24 & 0xff), UInt8(n >> 16 & 0xff), UInt8(n >> 8 & 0xff), UInt8(n & 0xff)] + track)
    }

    func testTempoZeroIsIgnored() throws {
        let song = try SMFSong(data: smf([0x00, 0xFF, 0x51, 0x03, 0, 0, 0, 0x00, 0x90, 60, 100, 0x60, 0x80, 60, 0, 0x00, 0xFF, 0x2F, 0x00]))
        XCTAssertEqual(song.bpm, 120)
        XCTAssertEqual(song.tracks[0].notes.count, 1)
        XCTAssertTrue(song.secToTick(1).isFinite)
    }

    func testOversizedMIDIFails() {
        XCTAssertThrowsError(try SMFSong(data: Data(count: SMFReader.maxBytes + 1))) { XCTAssertEqual($0 as? SMFError, .tooLarge) }
        var notes: [UInt8] = []
        for _ in 0...SMFReader.maxEvents { notes += [0x00, 0x90, 60, 100] }
        XCTAssertThrowsError(try SMFSong(data: smf(notes))) { XCTAssertEqual($0 as? SMFError, .tooLarge) }
    }

    func testMIDIDownloadStopsAtCap() async {
        defer { StubProtocol.handler = nil }
        StubProtocol.handler = { _ in (200, String(repeating: "a", count: 2048)) }
        let url = URL(string: "https://compose.grepawk.com/api/shares/x/media/midi")!
        let capped = await FeedPlayer.download(url, maxBytes: 1024, session: StubProtocol.session())
        XCTAssertNil(capped)
        let ok = await FeedPlayer.download(url, maxBytes: 4096, session: StubProtocol.session())
        XCTAssertEqual(ok?.count, 2048)
    }

    func testPreviewNumbersOutOfRangeAreDropped() throws {
        let preview = try JSONDecoder().decode(SongPreview.self, from: Data(#"{"lo":1e300,"hi":-1e300,"notes":[[0,0,100,1e300],[1e300,0,100,60],[0,0,100,64]]}"#.utf8))
        let notes = PianoRollMath.notes(from: preview, durationSeconds: 10)
        XCTAssertEqual(notes.map(\.pitch), [64])
        let span = PianoRollMath.noteSpan([], fallbackLo: preview.lo ?? 60, fallbackHi: preview.hi ?? 72)
        XCTAssertEqual(span.lo, 127)
        XCTAssertEqual(span.hi, 0)
    }

    func testHumTempoMapFromThePageCannotTrap() {
        let ctx = HumProjectContext(ppq: 0, tempos: [HumTempo(tick: 0, microPerQuarter: 0)])
        let ops = HumNotesToOps.ops(project: ctx, notes: [HumTimedNote(pitchMidi: .nan, startSec: 0, endSec: 1e300, amplitude: nil)], trackId: "t")
        guard case .addNotes(let n)? = ops.last else { return XCTFail("no notes") }
        XCTAssertEqual(n.first?.pitch, 0)
    }
}
