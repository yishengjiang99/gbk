import XCTest
@testable import GBKComposer

/// Phase 1b regression tests: expected values were produced by running the TS originals
/// (theory.ts / compose.ts / arrangement.ts / bach-generator.ts) on the same inputs, so a
/// pass means the Swift port is stream- and output-identical to the web implementation.
final class StudioMusicTests: XCTestCase {

    func testMulberryStreamMatchesTS() {
        let r = SeededRNG(seed: 1234)
        let expected = [0.0732949781, 0.7034119898, 0.9028560191, 0.9705493662, 0.0409639762]
        for e in expected { XCTAssertEqual(r.next(), e, accuracy: 1e-9) }
    }

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

    func testBachShortThreeVoices() {
        let g = generateBachMidi(key: "C", length: "short", voices: 3, character: "compact fugue",
                                 complexity: 3, tempo: 100, seed: 7, attempts: 1)
        XCTAssertEqual(g.piece.notes.count, 378)
        XCTAssertEqual(g.piece.score.score, 107.4904, accuracy: 0.01)
        XCTAssertEqual(g.piece.notes.map { $0.startBeat + $0.durBeat }.max()!, 64.5, accuracy: 1e-9)
    }

    func testChordAndKeyEstimation() {
        XCTAssertEqual(estimateChord(pcs: [0, 4, 7])?.label, "C major")
        XCTAssertEqual(estimateChord(pcs: [2, 5, 9])?.label, "D minor")
        let scale = [60, 62, 64, 65, 67, 69, 71, 72].enumerated().map { MNote(tick: $0.offset * 480, duration: 480, pitch: $0.element, velocity: 80) }
        let key = estimateKey(scale)
        XCTAssertEqual(key.label, "C major")
        XCTAssertEqual(key.confidence, 0.901, accuracy: 0.001)
    }

    func testCounterpointDeterministic() {
        let cantus = [72, 74, 76, 77, 79, 77, 76, 74].enumerated().map { MNote(tick: $0.offset * 480, duration: 480, pitch: $0.element, velocity: 80) }
        let cp = counterpoint(cantus: cantus, CounterpointOpts(lo: 60, hi: 84, rhythm: 1, seed: 99, startTick: 0,
                                                               endTick: 8 * 480, ppq: 480, velocity: 78, tonic: 0, mode: "major", above: true))
        XCTAssertEqual(cp.notes.map { $0.pitch }, [76, 77, 79, 81, 83, 84, 84, 83])
        XCTAssertEqual(cp.score, 3.677, accuracy: 0.001)
        XCTAssertTrue(cp.issues.isEmpty)
    }

    func testComposeDeterminism() throws {
        let key = try parseKeyInfo("G major")
        let r1 = SeededRNG(seed: 5)
        XCTAssertEqual(chordProgression(bars: 8, style: "classical", r: r1.next), [1, 6, 4, 5, 4, 5, 5, 1])
        let grid = (0..<8).map { BarGrid(tick: $0 * 1920, length: 1920, beats: 4, beatTicks: 480) }
        let prog = [1, 6, 4, 5, 4, 5, 5, 1]
        let r2 = SeededRNG(seed: 11)
        let mel = composeMelody(grid: grid, chords: prog, key: key, lo: 60, hi: 88, r: r2.next, density: 2)
        XCTAssertEqual(mel.count, 59)
        XCTAssertEqual(mel.prefix(10).map { "\($0.tick):\($0.pitch)" },
                       ["0:72", "240:74", "480:72", "720:69", "960:67", "1200:66", "1440:67", "1680:66", "1920:67", "2160:64"])
        let r3 = SeededRNG(seed: 13)
        let bass = composeBassLine(grid: grid, chords: prog, key: key, lo: 36, hi: 60, r: r3.next, pattern: "root-fifth")
        XCTAssertEqual(bass.count, 32)
        XCTAssertEqual(bass.prefix(8).map { "\($0.tick):\($0.pitch)" },
                       ["0:43", "480:38", "960:43", "1440:38", "1920:40", "2400:47", "2880:40", "3360:47"])
    }

    func testBaroqueVoicesShape() throws {
        let key = try parseKeyInfo("C major")
        let bv = baroqueVoices(key: key, totalTicks: 15360, ppq: 480, voices: 3, complexity: 3, seed: 7)
        XCTAssertEqual(bv.lines.map { $0.count }, [66, 61, 72])
        XCTAssertEqual(bv.lines[0].prefix(5).map { "\($0.tick):\($0.pitch)" }, ["0:69", "360:69", "540:71", "720:71", "1200:71"])
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

    func testArrangementClassical() throws {
        let (p, parts) = fourTrackProject()
        let res = try generateArrangement(p, plan: ArrangementPlan(style: "classical", key: try parseKeyInfo("G major"), bars: 8, seed: 5, voices: 4, complexity: 3), parts: parts)
        XCTAssertEqual(res.totalNotes, 201)
        XCTAssertEqual(res.perTrack.map { $0.notes }, [57, 48, 32, 64])
    }
}
