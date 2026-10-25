import Foundation

/// Swift port of web src/hum/notes-to-ops.ts (gbk #109) and the `secToTick` it uses (src/workstation/timing.ts).
/// Same ops, same rounding, so web and iOS produce identical "Hummed melody" tracks.
struct HumTempo: Codable, Equatable { let tick: Int; let microPerQuarter: Int }

/// The slice of the studio Project the conversion needs (from `window.gbkHum.context()`).
struct HumProjectContext: Codable, Equatable {
    var ppq: Int = 480
    var tempos: [HumTempo] = [HumTempo(tick: 0, microPerQuarter: 500_000)]
    var trackChannels: [Int] = []
    var readOnlyReason: String? = nil
}

/// A transcribed note in seconds (web `TimedNote`).
struct HumTimedNote: Equatable { let pitchMidi: Double; let startSec: Double; let endSec: Double; let amplitude: Double? }

struct HumNote: Codable, Equatable { let trackId: String; let channel: Int; let tick: Int; let duration: Int; let pitch: Int; let velocity: Int }

enum HumOp: Equatable {
    case addTrack(id: String, name: String, channel: Int, program: Int)
    case addNotes([HumNote])

    /// Web op JSON (workstation/ops.ts).
    var json: [String: Any] {
        switch self {
        case let .addTrack(id, name, channel, program):
            return ["op": "addTrack", "id": id, "name": name, "channel": channel, "program": program,
                    "bankMsb": 0, "bankLsb": 0, "role": "melody"]
        case let .addNotes(notes):
            return ["op": "addNotes", "notes": notes.map {
                ["trackId": $0.trackId, "channel": $0.channel, "tick": $0.tick, "duration": $0.duration,
                 "pitch": $0.pitch, "velocity": $0.velocity] as [String: Any]
            }]
        }
    }
}

enum HumNotesToOps {
    static let trackName = "Hummed melody"
    static let program = 0 // GM Acoustic Grand Piano

    struct TempoSeg { let tick: Int; let sec: Double; let mpq: Int }

    static func tempoSegments(_ tempos: [HumTempo], ppq: Int) -> [TempoSeg] {
        var sorted = tempos.sorted { $0.tick < $1.tick }
        if sorted.first.map({ $0.tick > 0 }) ?? true { sorted.insert(HumTempo(tick: 0, microPerQuarter: 500_000), at: 0) }
        var segs: [TempoSeg] = []
        var sec = 0.0
        for i in sorted.indices {
            if i > 0 { sec += Double(sorted[i].tick - sorted[i - 1].tick) * Double(sorted[i - 1].microPerQuarter) / 1e6 / Double(ppq) }
            if segs.last?.tick == sorted[i].tick { segs.removeLast() }
            segs.append(TempoSeg(tick: sorted[i].tick, sec: sec, mpq: sorted[i].microPerQuarter))
        }
        return segs
    }

    /// JS Math.round (half up, also for negatives).
    static func jsRound(_ x: Double) -> Int { Int((x + 0.5).rounded(.down)) }

    static func secToTick(_ p: HumProjectContext, _ sec: Double) -> Int {
        let segs = tempoSegments(p.tempos, ppq: p.ppq)
        var s = segs[0]
        for seg in segs { if seg.sec <= sec { s = seg } else { break } }
        return jsRound(Double(s.tick) + (sec - s.sec) * 1e6 * Double(p.ppq) / Double(s.mpq))
    }

    /// Next free melodic channel, skipping 9 (GM drums).
    static func nextMelodicChannel(_ used: [Int]) -> Int {
        let u = Set(used)
        for c in 0..<16 where c != 9 && !u.contains(c) { return c }
        return 0
    }

    static func amplitudeToVelocity(_ amplitude: Double?) -> Int {
        let a = amplitude.flatMap { $0.isFinite ? $0 : nil } ?? 0.8
        return max(1, min(127, jsRound(a * 127)))
    }

    /// [addTrack, addNotes], or [] when the take produced no notes.
    static func ops(project: HumProjectContext, notes: [HumTimedNote], trackId: String) -> [HumOp] {
        guard !notes.isEmpty else { return [] }
        let channel = nextMelodicChannel(project.trackChannels)
        let converted = notes.map { n -> HumNote in
            let tick = max(0, secToTick(project, n.startSec))
            let end = max(tick + 1, secToTick(project, n.endSec))
            return HumNote(trackId: trackId, channel: channel, tick: tick, duration: end - tick,
                           pitch: max(0, min(127, jsRound(n.pitchMidi))), velocity: amplitudeToVelocity(n.amplitude))
        }.sorted { ($0.tick, $0.pitch) < ($1.tick, $1.pitch) }
        return [.addTrack(id: trackId, name: trackName, channel: channel, program: program), .addNotes(converted)]
    }

    /// Web `newId("trk")` shape: prefix + base36 time + counter + random.
    static func newTrackId(now: Date = Date()) -> String {
        let t = String(Int(now.timeIntervalSince1970 * 1000), radix: 36)
        return "trk_\(t)\(String(Int.random(in: 0..<1_000_000), radix: 36))"
    }
}
