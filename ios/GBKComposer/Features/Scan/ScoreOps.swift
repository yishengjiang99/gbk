import Foundation

/// What the studio tells native about the open project (sent with `scan.start`).
struct StudioProjectInfo: Codable, Equatable, Sendable {
    var ppq: Int
    var channels: [Int]
    var noteCount: Int
    var readOnly: Bool
    var readOnlyReason: String?
}

/// Studio ops (src/workstation/ops.ts), the same shape `humToOps` (src/hum/notes-to-ops.ts) emits.
enum StudioOp: Encodable, Equatable {
    struct Note: Encodable, Equatable { var trackId: String; var channel: Int; var tick: Int; var duration: Int; var pitch: Int; var velocity: Int }
    struct Tempo: Encodable, Equatable { var tick: Int; var microPerQuarter: Int }
    struct TimeSig: Encodable, Equatable { var tick: Int; var numerator: Int; var denominator: Int }

    case addTrack(id: String, name: String, channel: Int, program: Int)
    case addNotes([Note])
    case setTempoMap([Tempo])
    case setTimeSigMap([TimeSig])
    case setMeta(key: String)

    private enum K: String, CodingKey { case op, id, name, channel, program, bankMsb, bankLsb, role, notes, events, key }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        switch self {
        case let .addTrack(id, name, channel, program):
            try c.encode("addTrack", forKey: .op); try c.encode(id, forKey: .id); try c.encode(name, forKey: .name)
            try c.encode(channel, forKey: .channel); try c.encode(program, forKey: .program)
            try c.encode(0, forKey: .bankMsb); try c.encode(0, forKey: .bankLsb); try c.encode("melody", forKey: .role)
        case let .addNotes(n): try c.encode("addNotes", forKey: .op); try c.encode(n, forKey: .notes)
        case let .setTempoMap(e): try c.encode("setTempoMap", forKey: .op); try c.encode(e, forKey: .events)
        case let .setTimeSigMap(e): try c.encode("setTimeSigMap", forKey: .op); try c.encode(e, forKey: .events)
        case let .setMeta(key): try c.encode("setMeta", forKey: .op); try c.encode(key, forKey: .key)
        }
    }
}

enum ScoreOps {
    /// Next free melodic channels (skip 9 = GM drums), like nextMelodicChannel in notes-to-ops.ts.
    static func freeChannels(used: [Int], count: Int) -> [Int] {
        var taken = Set(used), out: [Int] = []
        for _ in 0..<count {
            let c = (0..<16).first { $0 != 9 && !taken.contains($0) } ?? 0
            out.append(c); taken.insert(c)
        }
        return out
    }

    /// One addTrack + addNotes per part. Tempo/time signature/key are set only on an empty project
    /// (never re-time someone's existing song).
    static func ops(for score: Score, project: StudioProjectInfo,
                    newId: () -> String = { "trk_scan_" + UUID().uuidString.prefix(8).lowercased() }) throws -> [StudioOp] {
        if project.readOnly { throw ScanError.readOnlyProject }
        let parts = score.parts.filter { !$0.notes.isEmpty }
        guard !parts.isEmpty else { throw ScanError.nothingRecognized }
        var ops: [StudioOp] = []
        if project.noteCount == 0 {
            if let bpm = score.tempo, bpm > 0 { ops.append(.setTempoMap([.init(tick: 0, microPerQuarter: Int((60_000_000 / bpm).rounded()))])) }
            if let ts = score.timeSig { ops.append(.setTimeSigMap([.init(tick: 0, numerator: ts.numerator, denominator: ts.denominator)])) }
            if let key = score.key { ops.append(.setMeta(key: key)) }
        }
        let channels = freeChannels(used: project.channels, count: parts.count)
        let ppq = Double(max(1, project.ppq))
        for (part, ch) in zip(parts, channels) {
            let id = newId()
            ops.append(.addTrack(id: id, name: part.name, channel: ch, program: part.program ?? 0))
            let notes = part.notes.map { n -> StudioOp.Note in
                let tick = max(0, Int((n.onset * ppq).rounded()))
                return .init(trackId: id, channel: ch, tick: tick, duration: max(1, Int((n.duration * ppq).rounded())),
                             pitch: min(127, max(0, n.pitch)), velocity: min(127, max(1, n.velocity)))
            }.sorted { ($0.tick, $0.pitch) < ($1.tick, $1.pitch) }
            ops.append(.addNotes(notes))
        }
        return ops
    }

    static func json(_ ops: [StudioOp]) throws -> String {
        let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys]
        return String(decoding: try enc.encode(ops), as: UTF8.self)
    }
}
