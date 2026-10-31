import XCTest
@testable import GBKComposer

/// Phase 1b regression tests: expected values were produced by running the TS originals
/// (theory.ts / compose.ts / arrangement.ts / bach-generator.ts) on the same inputs, so a
/// pass means the Swift port is stream- and output-identical to the web implementation.
final class StudioMusicTests: XCTestCase {

    func testBachCanonicalPiece() {
        let g = generateBachMidi(key: "D minor", length: "medium", voices: 4, character: "compact fugue",
                                 complexity: 3, tempo: 92, seed: 42, attempts: 10)
        XCTAssertEqual(g.piece.subject.map { $0.midi }, [74, 79, 81, 81, 82, 82, 79, 77, 77, 81])
        XCTAssertEqual(g.piece.notes.count, 608)
        XCTAssertEqual(g.piece.score.score, 13.8614, accuracy: 0.01)
        XCTAssertEqual(g.piece.score.par.p5, 0)
        XCTAssertEqual(g.piece.score.par.p8, 2)
        XCTAssertEqual(g.piece.score.par.contrary, 201)
        XCTAssertEqual(g.piece.score.par.totalMotion, 685)
        XCTAssertEqual(g.piece.score.par.unisons, 254)
        XCTAssertEqual(g.piece.score.par.overlaps, 0)
        XCTAssertEqual(g.piece.score.leaps, 97)
        XCTAssertEqual(g.piece.score.cad, 48)
        XCTAssertEqual(g.piece.score.subj, 110)
        var roles: [String: Int] = [:]
        for n in g.piece.notes { roles[n.role, default: 0] += 1 }
        XCTAssertEqual(roles, ["subject": 50, "countersubject": 156, "answer": 20, "free": 198, "episode": 144, "stretto": 40])
        XCTAssertEqual(g.midiData.count, 5632)
    }

    private func fourTrackProject() -> (Project, [AssignedPart]) {
        let defs = [("t1", "Violin", 0, "melody"), ("t2", "Viola", 1, "harmony"), ("t3", "Cello", 2, "bass"), ("t4", "Harpsichord", 3, "accompaniment")]
        var p = emptyProject(name: "T")
        p.tracks = defs.map { GTrack(id: $0.0, name: $0.1, channel: $0.2, color: "#ffffff", mix: .default, visible: true, role: $0.3) }
        return (p, p.tracks.map { AssignedPart(track: $0, spec: instrumentSpec($0.name)) })
    }

    func testArrangementBaroque() throws {
        let (p, parts) = fourTrackProject()
        let res = try generateArrangement(p, plan: ArrangementPlan(style: "baroque", key: try parseKeyInfo("C major"), bars: 8, seed: 42, voices: 3, complexity: 3), parts: parts)
        XCTAssertEqual(res.totalNotes, 217)
        XCTAssertEqual(res.totalCcs, 232)
        XCTAssertEqual(res.durationSec, 16, accuracy: 0.001)
        XCTAssertEqual(res.perTrack.map { $0.notes }, [58, 59, 59, 41])
        XCTAssertEqual(res.perTrack.map { $0.range }, [[69, 83], [57, 72], [45, 59], [53, 67]])
        XCTAssertEqual(res.metrics.parallelPerfects, 0)
        XCTAssertEqual(res.metrics.voiceCrossings, 0)
        XCTAssertEqual(res.metrics.repeatedNoteRatio, 0.254, accuracy: 0.001)
    }
}
