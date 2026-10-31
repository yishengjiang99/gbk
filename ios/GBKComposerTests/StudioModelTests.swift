import XCTest
@testable import GBKComposer

/// Native Studio model core: ops, timing, SMF round-trip, voice validation, share sanitize.
final class StudioModelTests: XCTestCase {
    private func makeProject() -> (Project, GTrack) {
        var p = emptyProject(name: "Test")
        let t = GTrack(id: "trk_a", name: "Piano", channel: 0, color: trackColors[0], mix: .default, visible: true)
        p.tracks = [t]
        return (p, t)
    }

    func testAddNotesValidatesAndSorts() throws {
        let (p, t) = makeProject()
        let late = GNote(id: "n2", trackId: t.id, channel: 0, tick: 480, duration: 240, pitch: 62, velocity: 90)
        let early = GNote(id: "n1", trackId: t.id, channel: 0, tick: 0, duration: 240, pitch: 60, velocity: 100)
        let out = try applyProjectOps(p, [.addNotes([late, early])])
        XCTAssertEqual(out.notes.map { $0.id }, ["n1", "n2"])
        XCTAssertEqual(out.endTick, 720)
        XCTAssertThrowsError(try validateProjectOps(p, [.addNotes([GNote(id: "x", trackId: "nope", channel: 0, tick: 0, duration: 10, pitch: 60, velocity: 90)])])) {
            XCTAssertEqual(($0 as? ToolArgError)?.code, "INVALID_ARGUMENT")
        }
        XCTAssertThrowsError(try validateProjectOps(p, [.addNotes([GNote(id: "x", trackId: t.id, channel: 0, tick: 0, duration: 10, pitch: 200, velocity: 90)])])) {
            XCTAssertEqual(($0 as? ToolArgError)?.code, "INVALID_RANGE")
        }
    }

    func testUpdateAndRemoveNotes() throws {
        let (p, t) = makeProject()
        var p2 = try applyProjectOps(p, [.addNotes([GNote(id: "n1", trackId: t.id, channel: 0, tick: 0, duration: 240, pitch: 60, velocity: 100)])])
        p2 = try applyProjectOps(p2, [.updateNotes([(id: "n1", patch: NotePatch(pitch: 65, offVelocity: .some(nil)))])])
        XCTAssertEqual(p2.notes.first?.pitch, 65)
        p2 = try applyProjectOps(p2, [.removeNotes(["n1"])])
        XCTAssertTrue(p2.notes.isEmpty)
        XCTAssertEqual(p2.endTick, 0)
    }

    func testSetProgramStripsBankCCs() throws {
        let (p, t) = makeProject()
        var p2 = try applyProjectOps(p, [.setCC(trackId: t.id, controller: 0, points: [CCEvent(id: "c1", trackId: t.id, channel: 0, controller: 0, tick: 0, value: 3)], mode: "replace")])
        p2 = try applyProjectOps(p2, [.setProgram(trackId: t.id, program: 40, bankMsb: 1, bankLsb: 2, tick: 0)])
        XCTAssertEqual(p2.programs.first?.program, 40)
        XCTAssertTrue(p2.ccs.isEmpty)
    }

    func testTempoAndBars() {
        let (p, _) = makeProject()
        XCTAssertEqual(tickToSec(p, 480), 0.5, accuracy: 1e-9)
        XCTAssertEqual(secToTick(p, 1.0), 960)
        XCTAssertEqual(barBeatToTick(p, bar: 2, beat: 0), 1920)
        let bb = tickToBarBeat(p, 2400)
        XCTAssertEqual(bb.bar, 2)
        XCTAssertEqual(bb.beat, 1.0, accuracy: 1e-9)
    }

    func testSmfRoundTrip() throws {
        let (p, t) = makeProject()
        var src = try applyProjectOps(p, [
            .addNotes([
                GNote(id: "n1", trackId: t.id, channel: 0, tick: 0, duration: 480, pitch: 60, velocity: 100),
                GNote(id: "n2", trackId: t.id, channel: 0, tick: 480, duration: 240, pitch: 64, velocity: 90, offVelocity: 40),
            ]),
            .setProgram(trackId: t.id, program: 5, bankMsb: 0, bankLsb: 0, tick: 0),
            .setCC(trackId: t.id, controller: 7, points: [CCEvent(id: "c1", trackId: t.id, channel: 0, controller: 7, tick: 0, value: 88)], mode: "replace"),
        ])
        src.meta = ProjectMeta(key: "G major")
        src.meta?.sections = [Section(name: "Verse", startBar: 1, bars: 4)]
        let data = serializeSmf(src)
        let back = try parseSmf(data, name: "Test")
        XCTAssertEqual(back.ppq, 480)
        XCTAssertEqual(back.tracks.count, 1)
        XCTAssertEqual(back.tracks.first?.name, "Piano")
        XCTAssertEqual(back.notes.count, 2)
        XCTAssertEqual(back.notes[0].pitch, 60)
        XCTAssertEqual(back.notes[0].duration, 480)
        XCTAssertEqual(back.notes[1].offVelocity, 40)
        XCTAssertEqual(back.programs.first?.program, 5)
        XCTAssertEqual(back.ccs.first(where: { $0.controller == 7 })?.value, 88)
        XCTAssertEqual(back.tempos.first?.microPerQuarter, 500000)
        XCTAssertEqual(back.timeSigs.first?.numerator, 4)
    }

    func testParseRejectsSmpte() {
        let bad = Data([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0xe7, 0x28])
        XCTAssertThrowsError(try parseSmf(bad))
    }

    func testVoiceValidationAndHumanEdits() {
        XCTAssertNil(validateOverride(VoiceOverride(gen: 8, mode: "set", value: 8000)))
        XCTAssertNotNil(validateOverride(VoiceOverride(gen: 8, mode: "set", value: 100)))
        XCTAssertNotNil(validateOverride(VoiceOverride(gen: 41, mode: "set", value: 1)))
        switch humanEditToOverride(param: "filterCutoff", edit: .scale(0.5)) {
        case .success(let o): XCTAssertEqual(o.mode, "add"); XCTAssertEqual(o.value, -1200)
        case .failure(let e): XCTFail(e.message)
        }
        switch humanEditToOverride(param: "filterCutoff", edit: .add(100)) {
        case .success: XCTFail("add on Hz must be rejected")
        case .failure(let e): XCTAssertEqual(e.code, "INVALID_ARGUMENT")
        }
        switch humanEditToOverride(param: "attenuation", edit: .add(3)) {
        case .success(let o): XCTAssertEqual(o.value, 30)
        case .failure(let e): XCTFail(e.message)
        }
    }

    func testNrpnEncoding() {
        let out = overridesToNrpn([VoiceOverride(gen: 8, mode: "add", value: 1200)])
        XCTAssertEqual(out.map { $0.controller }, [99, 98, 6, 38])
        // gen 8 span 12000 -> step 2; data = 1200/2 + 8192 = 8792 -> MSB 68, LSB 88.
        XCTAssertEqual(out.map { $0.value }, [120, 8, 68, 88])
    }

    func testShareSanitizeDropsRawAndBadNotes() throws {
        let (p, t) = makeProject()
        var src = try applyProjectOps(p, [.addNotes([GNote(id: "n1", trackId: t.id, channel: 0, tick: 0, duration: 240, pitch: 60, velocity: 100)])])
        src.raw = [RawEvent(id: "r1", trackId: t.id, tick: 0, bytes: [0xf0, 1, 2], kind: "sysex")]
        let clean = try sanitizeSharedProject(src.json)
        XCTAssertTrue(clean.raw.isEmpty)
        XCTAssertEqual(clean.notes.count, 1)
        XCTAssertThrowsError(try sanitizeSharedProject(.object([("id", .string("x"))])))
    }

    func testProjectJsonRoundTrip() {
        let (p, t) = makeProject()
        var src = p
        src.sound = SoundSettings(tracks: [t.id: [VoiceOverride(gen: 8, mode: "add", value: -600)]], effects: nil)
        src.meta = ProjectMeta(key: "A minor", sections: [Section(name: "Intro", startBar: 1, bars: 2, energy: 0.5)], owner: "agent")
        let back = Project(json: src.json)
        XCTAssertEqual(back, src)
    }

    func testParseKey() {
        XCTAssertEqual(parseKey("C")?.sf, 0)
        XCTAssertEqual(parseKey("G major")?.sf, 1)
        XCTAssertEqual(parseKey("A minor")?.sf, 0)
        XCTAssertEqual(parseKey("D minor")?.sf, -1)
        XCTAssertEqual(parseKey("Bb")?.tonicPc, 10)
        XCTAssertNil(parseKey("H"))
    }
}
