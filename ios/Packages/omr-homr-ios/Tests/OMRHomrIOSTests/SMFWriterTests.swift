import XCTest
@testable import OMRHomrIOS

final class SMFWriterTests: XCTestCase {
    func testEmptyFileIsFormat1_480TPQ_TwoTracks() {
        let data = SMFWriter().writeEmpty()
        let header = SMFHeaderInspector.readHeader(from: data)
        XCTAssertNotNil(header)
        XCTAssertEqual(header?.format, 1)
        XCTAssertEqual(header?.trackCount, 2)
        XCTAssertEqual(header?.division, 480)
        XCTAssertEqual(SMFHeaderInspector.trackChunkCount(in: data), 2)
        XCTAssertEqual(String(data: data[0..<4], encoding: .ascii), "MThd")
        XCTAssertTrue(
            SMFHeaderInspector.containsTimeSignatureMeta(in: data),
            "metrical SMF should include FF 58 time signature on conductor track"
        )
    }

    func testSingleNoteWritesNoteTrack() {
        let notes = [
            SMFWriter.NoteEvent(midiNote: 60, onsetTicks: 0, durationTicks: 480),
            SMFWriter.NoteEvent(midiNote: 62, onsetTicks: 480, durationTicks: 480),
        ]
        let data = SMFWriter().write(notes: notes)
        let header = SMFHeaderInspector.readHeader(from: data)!
        XCTAssertEqual(header.format, 1)
        XCTAssertEqual(header.division, 480)
        XCTAssertEqual(header.trackCount, 2, "conductor + one staff track")
        XCTAssertEqual(SMFHeaderInspector.trackChunkCount(in: data), 2)
        XCTAssertGreaterThan(data.count, 30)
    }

    func testOneTrackPerStaffTopToBottom() {
        let notes = [
            SMFWriter.NoteEvent(midiNote: 60, onsetTicks: 0, durationTicks: 480, staff: 0),
            SMFWriter.NoteEvent(midiNote: 48, onsetTicks: 0, durationTicks: 480, staff: 1),
        ]
        let data = SMFWriter().write(notes: notes)
        XCTAssertEqual(SMFHeaderInspector.readHeader(from: data)?.trackCount, 3)
        XCTAssertEqual(SMFHeaderInspector.trackChunkCount(in: data), 3)
        let ons = RenderTokensLayoutTests.mergedNoteOns(in: data)
        XCTAssertEqual(ons.map(\.track), [1, 2], "track index - 1 == staff index")
        XCTAssertEqual(ons.map(\.pitch), [60, 48])
    }

    func testLowerStaffOnlyStillMapsTrackToStaff() {
        // Staff 1 alone → empty staff-0 track kept so track - 1 == staff holds.
        let data = SMFWriter().write(notes: [
            SMFWriter.NoteEvent(midiNote: 48, onsetTicks: 0, durationTicks: 480, staff: 1),
        ])
        XCTAssertEqual(SMFHeaderInspector.trackChunkCount(in: data), 3)
        XCTAssertEqual(RenderTokensLayoutTests.mergedNoteOns(in: data).map(\.track), [2])
    }

    func testStaffTracksContainOnlyProgramZeroAndNoteOnOff() {
        let data = SMFWriter().write(notes: [
            SMFWriter.NoteEvent(midiNote: 60, onsetTicks: 0, durationTicks: 480, staff: 0),
            SMFWriter.NoteEvent(midiNote: 48, onsetTicks: 480, durationTicks: 480, staff: 1),
        ])
        let bytes = [UInt8](data)
        var i = 14
        var track = 0
        while i + 8 <= bytes.count {
            let len = Int(bytes[i + 4]) << 24 | Int(bytes[i + 5]) << 16 | Int(bytes[i + 6]) << 8 | Int(bytes[i + 7])
            let body = Array(bytes[(i + 8)..<(i + 8 + len)])
            if track >= 1 {
                // Starts with delta 0 + program change 0; ends with end-of-track meta.
                XCTAssertEqual(Array(body.prefix(3)), [0x00, 0xC0, 0x00], "track \(track) program 0")
                XCTAssertEqual(Array(body.suffix(3)), [0xFF, 0x2F, 0x00], "track \(track) EOT")
                XCTAssertFalse(body.dropLast(3).contains(0xFF), "track \(track): no meta besides EOT")
            }
            track += 1
            i += 8 + len
        }
        XCTAssertEqual(track, 3)
    }

    func testVLQEncoding() {
        XCTAssertEqual(SMFWriter.encodeVLQ(0), [0x00])
        XCTAssertEqual(SMFWriter.encodeVLQ(0x7F), [0x7F])
        XCTAssertEqual(SMFWriter.encodeVLQ(0x80), [0x81, 0x00])
        XCTAssertEqual(SMFWriter.encodeVLQ(480), [0x83, 0x60])
    }

    func testCScaleSymbolMappingUsesTokenizerStringsOnly() {
        // Pitch/rhythm strings from Vocabulary — not invented IDs.
        let symbols: [EncodedSymbol] = [
            EncodedSymbol(rhythm: "clef_G2", pitch: ".", lift: ".", articulation: ".", slur: ".", position: "upper"),
            EncodedSymbol(rhythm: "note_4", pitch: "C4", lift: "_", articulation: "_", slur: "_", position: "upper"),
            EncodedSymbol(rhythm: "note_4", pitch: "D4", lift: "_", articulation: "_", slur: "_", position: "upper"),
            EncodedSymbol(rhythm: "note_4", pitch: "E4", lift: "_", articulation: "_", slur: "_", position: "upper"),
            EncodedSymbol(rhythm: "note_4", pitch: "F4", lift: "_", articulation: "_", slur: "_", position: "upper"),
            EncodedSymbol(rhythm: "note_4", pitch: "G4", lift: "_", articulation: "_", slur: "_", position: "upper"),
            EncodedSymbol(rhythm: "note_4", pitch: "A4", lift: "_", articulation: "_", slur: "_", position: "upper"),
            EncodedSymbol(rhythm: "note_4", pitch: "B4", lift: "_", articulation: "_", slur: "_", position: "upper"),
            EncodedSymbol(rhythm: "note_4", pitch: "C5", lift: "_", articulation: "_", slur: "_", position: "upper"),
        ]
        let events = SymbolMIDIMapping.noteEvents(from: symbols)
        XCTAssertEqual(events.map(\.midiNote), [60, 62, 64, 65, 67, 69, 71, 72])
        XCTAssertEqual(events.map(\.onsetTicks), [0, 480, 960, 1440, 1920, 2400, 2880, 3360])
        XCTAssertEqual(Set(events.map(\.durationTicks)), [480])

        let data = SMFWriter().write(symbols: symbols)
        let header = SMFHeaderInspector.readHeader(from: data)!
        XCTAssertEqual(header.format, 1)
        XCTAssertEqual(header.division, 480)
        XCTAssertTrue(SMFHeaderInspector.containsTimeSignatureMeta(in: data))
    }

    func testKernQuarterAndDotted() {
        XCTAssertEqual(SymbolMIDIMapping.durationTicks(rhythmToken: "note_4"), 480)
        XCTAssertEqual(SymbolMIDIMapping.durationTicks(rhythmToken: "note_8"), 240)
        XCTAssertEqual(SymbolMIDIMapping.durationTicks(rhythmToken: "note_4."), 720)
        XCTAssertEqual(SymbolMIDIMapping.durationTicks(rhythmToken: "rest_4"), 480)
        XCTAssertEqual(SymbolMIDIMapping.midiNote(pitchToken: "C4"), 60)
        XCTAssertEqual(SymbolMIDIMapping.midiNote(pitchToken: "C4", liftToken: "#"), 61)
        XCTAssertNil(SymbolMIDIMapping.midiNote(pitchToken: "."))
    }

    func testChordSharesOnset() {
        let symbols: [EncodedSymbol] = [
            EncodedSymbol(rhythm: "note_4", pitch: "C4", lift: "_", articulation: "_", slur: "_", position: "upper"),
            EncodedSymbol(rhythm: "chord", pitch: ".", lift: ".", articulation: ".", slur: ".", position: "."),
            EncodedSymbol(rhythm: "note_4", pitch: "E4", lift: "_", articulation: "_", slur: "_", position: "upper"),
            EncodedSymbol(rhythm: "chord", pitch: ".", lift: ".", articulation: ".", slur: ".", position: "."),
            EncodedSymbol(rhythm: "note_4", pitch: "G4", lift: "_", articulation: "_", slur: "_", position: "upper"),
        ]
        let events = SymbolMIDIMapping.noteEvents(from: symbols)
        XCTAssertEqual(events.map(\.midiNote), [60, 64, 67])
        XCTAssertEqual(events.map(\.onsetTicks), [0, 0, 0])
        XCTAssertEqual(Set(events.map(\.durationTicks)), [480])
    }

    func testLowerStaffClefRestartsTimeForGrandStaffDump() {
        // Grand-staff token order: upper staff first, then the lower staff. The lower clef
        // restarts time so the two staves sound simultaneously.
        let sym: (String, String, String) -> EncodedSymbol = { rhythm, pitch, position in
            EncodedSymbol(rhythm: rhythm, pitch: pitch, lift: "_", articulation: "_", slur: "_", position: position)
        }
        let symbols: [EncodedSymbol] = [
            sym("clef_G2", ".", "upper"),
            sym("note_4", "C4", "upper"),
            sym("note_4", "D4", "upper"),
            sym("clef_F4", ".", "lower"),
            sym("note_4", "C3", "lower"),
            sym("note_4", "D3", "lower"),
        ]
        let events = SymbolMIDIMapping.noteEvents(from: symbols)
        XCTAssertEqual(events.map(\.midiNote), [60, 62, 48, 50])
        XCTAssertEqual(events.map(\.onsetTicks), [0, 480, 0, 480])
        XCTAssertEqual(events.map(\.staff), [0, 0, 1, 1])
    }

    func testSameStaffClefChangeDoesNotRewindTime() {
        // A mid-piece clef change on the same staff keeps the cursor running.
        let sym: (String, String, String) -> EncodedSymbol = { rhythm, pitch, position in
            EncodedSymbol(rhythm: rhythm, pitch: pitch, lift: "_", articulation: "_", slur: "_", position: position)
        }
        let symbols: [EncodedSymbol] = [
            sym("clef_G2", ".", "upper"),
            sym("note_4", "C4", "upper"),
            sym("clef_C3", ".", "upper"),
            sym("note_4", "D4", "upper"),
        ]
        let events = SymbolMIDIMapping.noteEvents(from: symbols)
        XCTAssertEqual(events.map(\.midiNote), [60, 62])
        XCTAssertEqual(events.map(\.onsetTicks), [0, 480])
    }
    /// Grand-staff pickup: melody quarter + bass rest via `chord` must share onset.
    /// Pre-fix stacked the rest after the note → full-measure silence (2/4 pickup gap).
    func testPickupChordRestDoesNotPadMeasure() {
        let sym: (String, String, String) -> EncodedSymbol = { rhythm, pitch, position in
            EncodedSymbol(rhythm: rhythm, pitch: pitch, lift: "_", articulation: "_", slur: "_", position: position)
        }
        let chord = EncodedSymbol(rhythm: "chord", pitch: ".", lift: ".", articulation: ".", slur: ".", position: ".")
        let bar = EncodedSymbol(rhythm: "barline", pitch: ".", lift: ".", articulation: ".", slur: ".", position: ".")
        let symbols: [EncodedSymbol] = [
            sym("clef_G2", ".", "upper"),
            sym("clef_F4", ".", "lower"),
            // Pickup (anacrusis): one quarter in the melody, other hand rests
            sym("note_4", "C5", "upper"),
            chord,
            sym("rest_4", ".", "lower"),
            bar,
            // First full bar
            sym("note_4", "D5", "upper"),
            chord,
            sym("note_4", "D3", "lower"),
            sym("note_4", "E5", "upper"),
            chord,
            sym("note_4", "E3", "lower"),
        ]
        let events = SymbolMIDIMapping.noteEvents(from: symbols)
        // C5 @0; D5+D3 @480 (not 960); E5+E3 @960
        XCTAssertEqual(events.map(\.midiNote), [72, 74, 50, 76, 52])
        XCTAssertEqual(events.map(\.onsetTicks), [0, 480, 480, 960, 960])
        XCTAssertEqual(Set(events.map(\.durationTicks)), [480])
    }

    /// Rest then chord-tied note (bass enters under a rest): note at rest's onset, no extra gap.
    func testRestThenChordNoteSharesOnset() {
        let sym: (String, String, String) -> EncodedSymbol = { rhythm, pitch, position in
            EncodedSymbol(rhythm: rhythm, pitch: pitch, lift: "_", articulation: "_", slur: "_", position: position)
        }
        let chord = EncodedSymbol(rhythm: "chord", pitch: ".", lift: ".", articulation: ".", slur: ".", position: ".")
        let symbols: [EncodedSymbol] = [
            sym("rest_4", ".", "upper"),
            chord,
            sym("note_4", "C3", "lower"),
            sym("note_4", "D3", "lower"),
        ]
        let events = SymbolMIDIMapping.noteEvents(from: symbols)
        XCTAssertEqual(events.map(\.midiNote), [48, 50])
        XCTAssertEqual(events.map(\.onsetTicks), [0, 480])
    }

    /// Intentional sequential rests (no `chord`) still advance time — oracle mono.rests.
    func testSequentialRestsStillAdvanceTime() {
        let sym: (String, String, String) -> EncodedSymbol = { rhythm, pitch, position in
            EncodedSymbol(rhythm: rhythm, pitch: pitch, lift: "_", articulation: "_", slur: "_", position: position)
        }
        let symbols: [EncodedSymbol] = [
            sym("note_4", "C4", "upper"),
            sym("rest_4", ".", "upper"),
            sym("note_4", "E4", "upper"),
            sym("rest_4", ".", "upper"),
            EncodedSymbol(rhythm: "barline", pitch: ".", lift: ".", articulation: ".", slur: ".", position: "."),
            sym("note_4", "G4", "upper"),
        ]
        let events = SymbolMIDIMapping.noteEvents(from: symbols)
        XCTAssertEqual(events.map(\.midiNote), [60, 64, 67])
        XCTAssertEqual(events.map(\.onsetTicks), [0, 960, 1920])
    }


}
