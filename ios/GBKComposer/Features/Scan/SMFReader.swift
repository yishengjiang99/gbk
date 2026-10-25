import Foundation

/// Minimal Standard MIDI File reader: notes (per track), tempo, time and key signature -> Score.
enum SMFReader {
    enum Error: Swift.Error { case notSMF, truncated }

    static func score(from data: Data, partName: (Int) -> String = { "Staff \($0 + 1)" }) throws -> Score {
        let b = [UInt8](data)
        var i = 0
        func u32() throws -> Int { guard i + 4 <= b.count else { throw Error.truncated }; defer { i += 4 }; return Int(b[i]) << 24 | Int(b[i+1]) << 16 | Int(b[i+2]) << 8 | Int(b[i+3]) }
        func u16() throws -> Int { guard i + 2 <= b.count else { throw Error.truncated }; defer { i += 2 }; return Int(b[i]) << 8 | Int(b[i+1]) }
        guard b.count >= 14, Array(b[0..<4]) == Array("MThd".utf8) else { throw Error.notSMF }
        i = 4
        let hlen = try u32()
        _ = try u16()
        let ntrk = try u16()
        let division = try u16()
        i = 8 + hlen
        let tpq = Double(division & 0x8000 == 0 && division > 0 ? division : 480)
        var score = Score(parts: [])
        var trackIndex = 0
        for _ in 0..<ntrk {
            guard i + 8 <= b.count else { break }
            let isTrack = Array(b[i..<i+4]) == Array("MTrk".utf8)
            i += 4
            let len = try u32()
            let end = min(b.count, i + len)
            defer { i = end }
            guard isTrack else { continue }
            var tick = 0, status: UInt8 = 0
            var open: [Int: [(tick: Int, vel: Int)]] = [:]
            var notes: [ScoreNote] = []
            var name: String?
            var program: Int?
            func vlq() -> Int { var v = 0; while i < end { let c = b[i]; i += 1; v = v << 7 | Int(c & 0x7f); if c & 0x80 == 0 { break } }; return v }
            func close(_ p: Int, at t: Int) {
                guard var stack = open[p], !stack.isEmpty else { return }
                let s = stack.removeFirst(); open[p] = stack
                notes.append(ScoreNote(pitch: p, onset: Double(s.tick) / tpq, duration: Double(max(1, t - s.tick)) / tpq, velocity: s.vel))
            }
            while i < end {
                tick += vlq()
                guard i < end else { break }
                var st = b[i]
                if st & 0x80 != 0 { i += 1; if st < 0xf0 { status = st } } else { st = status }
                switch st {
                case 0xff:
                    guard i < end else { break }
                    let type = b[i]; i += 1
                    let l = vlq(); let d = Array(b[i..<min(end, i + l)]); i += l
                    switch type {
                    case 0x03: name = String(bytes: d, encoding: .utf8)
                    case 0x51 where d.count == 3 && score.tempo == nil:
                        score.tempo = 60_000_000 / Double(Int(d[0]) << 16 | Int(d[1]) << 8 | Int(d[2]))
                    case 0x58 where d.count >= 2 && score.timeSig == nil:
                        score.timeSig = TimeSignature(numerator: Int(d[0]), denominator: 1 << Int(d[1]))
                    case 0x59 where d.count == 2 && score.key == nil:
                        score.key = keyName(sharps: Int(Int8(bitPattern: d[0])), minor: d[1] == 1)
                    default: break
                    }
                case 0xf0, 0xf7: let l = vlq(); i += l
                default:
                    let kind = st & 0xf0
                    let n = (kind == 0xc0 || kind == 0xd0) ? 1 : 2
                    guard i + n <= end else { i = end; break }
                    let d1 = Int(b[i]), d2 = n == 2 ? Int(b[i+1]) : 0
                    i += n
                    if kind == 0x90 && d2 > 0 { open[d1, default: []].append((tick, d2)) }
                    else if kind == 0x80 || (kind == 0x90 && d2 == 0) { close(d1, at: tick) }
                    else if kind == 0xc0 && program == nil { program = d1 }
                }
            }
            for (p, stack) in open { for _ in stack { close(p, at: tick) } }
            if !notes.isEmpty {
                notes.sort { ($0.onset, $0.pitch) < ($1.onset, $1.pitch) }
                score.parts.append(ScorePart(name: name.flatMap { $0.isEmpty ? nil : $0 } ?? partName(trackIndex), program: program, notes: notes))
                trackIndex += 1
            }
        }
        return score
    }

    static func keyName(sharps: Int, minor: Bool) -> String {
        let major = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"]
        let minorKeys = ["Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#", "G#", "D#", "A#"]
        let idx = max(0, min(14, sharps + 7))
        return minor ? minorKeys[idx] + "m" : major[idx]
    }
}
