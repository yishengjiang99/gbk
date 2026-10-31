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
        src.meta?.sections = [ProjectSection(name: "Verse", startBar: 1, bars: 4)]
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

    func testProjectJsonRoundTrip() {
        let (p, t) = makeProject()
        var src = p
        src.sound = SoundSettings(tracks: [t.id: [VoiceOverride(gen: 8, mode: "add", value: -600)]], effects: nil)
        src.meta = ProjectMeta(key: "A minor", sections: [ProjectSection(name: "Intro", startBar: 1, bars: 2, energy: 0.5)], owner: "agent")
        let back = Project(json: src.json)
        XCTAssertEqual(back, src)
    }
}
