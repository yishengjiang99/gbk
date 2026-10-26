// SPDX-License-Identifier: AGPL-3.0-or-later
import Foundation

// Port of gbk src/midi-timer.worker.ts parseMidiBuffer (SMF format 0/1, PPQ division):
// running status (also latched by meta/sysex status bytes, as in gbk), tempo map (compacted,
// 500000 us/qn default at tick 0), time signatures, note on/off (vel 0 = off), CC0/CC32 bank
// select latched per track+channel into program events, notes paired LIFO per channel:note.
// Extras gbk parses but drops are kept as data only: CC values and pitch bend per track.

public enum SMFError: Error, Equatable {
    case invalidHeader
    case smpteNotSupported
    case missingTrack(Int)
}

public struct SMFTempoSegment: Equatable, Sendable {
    public var tick: Int
    public var startSec: Double
    public var microPerQuarter: Int
}

public struct SMFTimeSignature: Equatable, Sendable {
    public var tick: Int
    public var numerator: Int
    public var denominator: Int
}

public struct SMFPlayEvent: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case noteOn(note: Int, velocity: Int)
        case noteOff(note: Int)
        case program(program: Int, bank: Int)
    }
    public var sec: Double
    public var tick: Int
    public var channel: Int
    public var seq: Int
    public var kind: Kind
}

public struct SMFNoteRecord: Equatable, Sendable {
    public var note: Int
    public var velocity: Int
    public var channel: Int
    public var startSec: Double
    public var durationSec: Double
    public var startTick: Int
    public var endTick: Int
}

public struct SMFControlEvent: Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case cc(controller: Int, value: Int), pitchBend(value: Int) }
    public var tick: Int
    public var sec: Double
    public var channel: Int
    public var kind: Kind
    /// Order among the track's events at the same tick: a CC's gbk seq; a pitch bend sorts right
    /// after the event that preceded it in the file.
    public var seq: Int = 0
}

public struct SMFTrack: Equatable, Sendable {
    public var index: Int
    public var name: String
    public var instrumentName: String
    public var notes: [SMFNoteRecord]
    public var playEvents: [SMFPlayEvent]
    /// All CC and pitch-bend messages (gbk only uses CC0/CC32 for bank select; not applied to audio).
    public var controlEvents: [SMFControlEvent]
}

public struct SMFSong: Equatable, Sendable {
    public var format: Int
    public var division: Int
    public var durationSec: Double
    public var maxTick: Int
    public var tracks: [SMFTrack]
    public var totalBars: Double
    public var bpm: Int
    public var timeSig: String
    public var tempoMap: [SMFTempoSegment]
    public var timeSignatures: [SMFTimeSignature]

    public init(data: Data) throws { self = try SMFReader.parse(data) }
    init(format: Int, division: Int, durationSec: Double, maxTick: Int, tracks: [SMFTrack], totalBars: Double, bpm: Int,
         timeSig: String, tempoMap: [SMFTempoSegment], timeSignatures: [SMFTimeSignature]) {
        self.format = format; self.division = division; self.durationSec = durationSec; self.maxTick = maxTick
        self.tracks = tracks; self.totalBars = totalBars; self.bpm = bpm; self.timeSig = timeSig
        self.tempoMap = tempoMap; self.timeSignatures = timeSignatures
    }

    public func tickToSec(_ tick: Int) -> Double { SMFReader.tickToSec(tempoMap, division, Double(tick)) }

    /// Inverse of the tempo map (fractional ticks).
    public func secToTick(_ sec: Double) -> Double {
        var seg = tempoMap[0]
        for s in tempoMap.dropFirst() {
            if s.startSec > sec { break }
            seg = s
        }
        return Double(seg.tick) + (sec - seg.startSec) * 1_000_000 * Double(division) / Double(seg.microPerQuarter)
    }
}

enum SMFReader {
    enum RawKind {
        case tempo(Int), timeSig(Int, Int), noteOn(Int, Int), noteOff(Int), cc(Int, Int), program(Int), pitchBend(Int)
    }
    struct RawEvent { var seq: Int; var tick: Int; var channel: Int; var kind: RawKind; var order = 0 }
    struct RawTrack { var name = ""; var instrument = ""; var events: [RawEvent] = [] }

    static func text(_ b: ArraySlice<UInt8>) -> String {
        String(b.filter { $0 != 0 }.map { Character(Unicode.Scalar($0)) })
    }

    static func parseTrack(_ t: ArraySlice<UInt8>) -> RawTrack {
        let bytes = Array(t)
        var out = RawTrack()
        var pos = 0
        var tick = 0
        var running = 0
        var seq = 0
        @inline(__always) func at(_ p: Int) -> Int { p >= 0 && p < bytes.count ? Int(bytes[p]) : 0 }
        func varLen() -> Int {
            var v: UInt32 = 0
            for _ in 0 ..< 4 {
                let b = at(pos); pos += 1
                v = (v << 7) | UInt32(b & 0x7f)
                if b & 0x80 == 0 { break }
            }
            return Int(v)
        }
        while pos < bytes.count {
            tick += varLen()
            if pos >= bytes.count { break }
            var status = at(pos); pos += 1
            if status < 0x80 { pos -= 1; status = running } else { running = status }

            if status == 0xff {
                let metaType = at(pos); pos += 1
                let len = varLen()
                let start = pos
                pos += len
                if metaType == 0x2f { break }
                let slice = bytes[min(start, bytes.count) ..< min(start + len, bytes.count)]
                if metaType == 0x03 && len > 0 { out.name = text(slice) }
                if metaType == 0x04 && len > 0 { out.instrument = text(slice) }
                if metaType == 0x51 && len == 3 {
                    out.events.append(RawEvent(seq: seq, tick: tick, channel: 0, kind: .tempo((at(start) << 16) | (at(start + 1) << 8) | at(start + 2))))
                    seq += 1
                }
                if metaType == 0x58 && len >= 2 {
                    let num = at(start) != 0 ? at(start) : 4
                    let den = 1 << (at(start + 1) != 0 ? at(start + 1) : 2)
                    out.events.append(RawEvent(seq: seq, tick: tick, channel: 0, kind: .timeSig(num, den)))
                    seq += 1
                }
                continue
            }
            if status == 0xf0 || status == 0xf7 {
                pos += varLen()
                continue
            }
            let cmd = status & 0xf0
            let ch = status & 0x0f
            let d1 = at(pos); pos += 1
            var d2 = 0
            if cmd != 0xc0 && cmd != 0xd0 { d2 = at(pos); pos += 1 }
            var kind: RawKind?
            if cmd == 0x90 && d2 > 0 { kind = .noteOn(d1 & 0x7f, d2 & 0x7f) }
            else if cmd == 0x80 || (cmd == 0x90 && d2 == 0) { kind = .noteOff(d1 & 0x7f) }
            else if cmd == 0xb0 { kind = .cc(d1 & 0x7f, d2 & 0x7f) }
            else if cmd == 0xc0 { kind = .program(d1 & 0x7f) }
            else if cmd == 0xe0 {
                // Not in gbk's event list (and not counted in its seq); kept as data only.
                // `order` = seq of the event before it, so a spec render can place it in file order.
                out.events.append(RawEvent(seq: -1, tick: tick, channel: ch, kind: .pitchBend(((d2 & 0x7f) << 7 | (d1 & 0x7f)) - 8192),
                                           order: seq - 1))
            }
            if let kind { out.events.append(RawEvent(seq: seq, tick: tick, channel: ch, kind: kind)); seq += 1 }
        }
        return out
    }

    static func buildTempoMap(_ all: [RawEvent], _ division: Int) -> [SMFTempoSegment] {
        var tempos: [(tick: Int, mpq: Int)] = all.compactMap {
            if case let .tempo(m) = $0.kind { return ($0.tick, m) }
            return nil
        }
        tempos = stableSorted(tempos) { $0.tick < $1.tick }
        if tempos.isEmpty || tempos[0].tick != 0 { tempos.insert((0, 500_000), at: 0) }
        var compact: [(tick: Int, mpq: Int)] = []
        for t in tempos {
            if let last = compact.last, last.tick == t.tick { compact[compact.count - 1] = t } else { compact.append(t) }
        }
        var segs: [SMFTempoSegment] = []
        var startSec = 0.0
        for (i, cur) in compact.enumerated() {
            segs.append(SMFTempoSegment(tick: cur.tick, startSec: startSec, microPerQuarter: cur.mpq))
            if i + 1 < compact.count {
                let dticks = Double(compact[i + 1].tick - cur.tick)
                startSec += (dticks * Double(cur.mpq)) / 1_000_000 / Double(division)
            }
        }
        return segs
    }

    static func tickToSec(_ segs: [SMFTempoSegment], _ division: Int, _ tick: Double) -> Double {
        var seg = segs[0]
        for s in segs.dropFirst() {
            if Double(s.tick) > tick { break }
            seg = s
        }
        return seg.startSec + ((tick - Double(seg.tick)) * Double(seg.microPerQuarter)) / 1_000_000 / Double(division)
    }

    static func stableSorted<T>(_ a: [T], by less: (T, T) -> Bool) -> [T] {
        a.enumerated().sorted { x, y in
            if less(x.element, y.element) { return true }
            if less(y.element, x.element) { return false }
            return x.offset < y.offset
        }.map(\.element)
    }

    static func parse(_ data: Data) throws -> SMFSong {
        let u8 = [UInt8](data)
        func be16(_ p: Int) -> Int { p + 1 < u8.count ? Int(u8[p]) << 8 | Int(u8[p + 1]) : 0 }
        func be32(_ p: Int) -> Int { p + 3 < u8.count ? Int(u8[p]) << 24 | Int(u8[p + 1]) << 16 | Int(u8[p + 2]) << 8 | Int(u8[p + 3]) : 0 }
        func id(_ p: Int) -> String { p + 4 <= u8.count ? String(decoding: u8[p ..< p + 4], as: UTF8.self) : "" }
        guard id(0) == "MThd" else { throw SMFError.invalidHeader }
        let headerLen = be32(4)
        let format = be16(8)
        let ntrks = be16(10)
        let division = be16(12)
        if division & 0x8000 != 0 { throw SMFError.smpteNotSupported }

        var pos = 8 + headerLen
        var raw: [RawTrack] = []
        for i in 0 ..< ntrks {
            guard id(pos) == "MTrk" else { throw SMFError.missingTrack(i) }
            let len = be32(pos + 4)
            let start = pos + 8
            raw.append(parseTrack(u8[min(start, u8.count) ..< min(start + len, u8.count)]))
            pos = start + len
        }
        let all = raw.flatMap(\.events)
        let div = max(1, division)
        let tempoMap = buildTempoMap(all, div)
        var maxTick = 0

        let tracks: [SMFTrack] = raw.enumerated().map { idx, track in
            var notes: [SMFNoteRecord] = []
            var play: [SMFPlayEvent] = []
            var controls: [SMFControlEvent] = []
            var active: [Int: [(startSec: Double, startTick: Int, velocity: Int)]] = [:]
            var bankMsb = [Int](repeating: 0, count: 16), bankLsb = [Int](repeating: 0, count: 16)
            let gbkEvents = track.events.filter { $0.seq >= 0 }
            let sorted = stableSorted(gbkEvents) { ($0.tick, $0.seq) < ($1.tick, $1.seq) }
            for e in sorted {
                let sec = tickToSec(tempoMap, div, Double(e.tick))
                maxTick = max(maxTick, e.tick)
                switch e.kind {
                case let .cc(c, v):
                    if c == 0 { bankMsb[e.channel] = v }
                    if c == 32 { bankLsb[e.channel] = v }
                    controls.append(SMFControlEvent(tick: e.tick, sec: sec, channel: e.channel, kind: .cc(controller: c, value: v), seq: e.seq))
                case let .program(p):
                    let bank = ((bankMsb[e.channel] & 0x7f) << 7) | (bankLsb[e.channel] & 0x7f)
                    play.append(SMFPlayEvent(sec: sec, tick: e.tick, channel: e.channel, seq: e.seq, kind: .program(program: p, bank: bank)))
                case let .noteOn(n, v):
                    active[e.channel << 8 | n, default: []].append((sec, e.tick, v))
                    play.append(SMFPlayEvent(sec: sec, tick: e.tick, channel: e.channel, seq: e.seq, kind: .noteOn(note: n, velocity: v)))
                case let .noteOff(n):
                    if let start = active[e.channel << 8 | n]?.popLast() {
                        notes.append(SMFNoteRecord(note: n, velocity: start.velocity, channel: e.channel, startSec: start.startSec,
                                                   durationSec: max(0.01, sec - start.startSec), startTick: start.startTick, endTick: e.tick))
                    }
                    play.append(SMFPlayEvent(sec: sec, tick: e.tick, channel: e.channel, seq: e.seq, kind: .noteOff(note: n)))
                default:
                    break
                }
            }
            for e in track.events {
                if case let .pitchBend(v) = e.kind {
                    controls.append(SMFControlEvent(tick: e.tick, sec: tickToSec(tempoMap, div, Double(e.tick)), channel: e.channel,
                                                    kind: .pitchBend(value: v), seq: e.order))
                }
            }
            controls = stableSorted(controls) { $0.tick < $1.tick }
            return SMFTrack(index: idx, name: track.name.isEmpty ? "Track \(idx + 1)" : track.name, instrumentName: track.instrument,
                            notes: stableSorted(notes) { $0.startSec < $1.startSec },
                            playEvents: stableSorted(play) { ($0.sec, $0.seq) < ($1.sec, $1.seq) },
                            controlEvents: controls)
        }

        var timeSigs: [(tick: Int, seq: Int, num: Int, den: Int)] = []
        var tempos: [(tick: Int, seq: Int, mpq: Int)] = []
        for e in all {
            if case let .timeSig(n, d) = e.kind { timeSigs.append((e.tick, e.seq, n, d)) }
            if case let .tempo(m) = e.kind { tempos.append((e.tick, e.seq, m)) }
        }
        timeSigs = stableSorted(timeSigs) { ($0.tick, $0.seq) < ($1.tick, $1.seq) }
        tempos = stableSorted(tempos) { ($0.tick, $0.seq) < ($1.tick, $1.seq) }
        let primary = timeSigs.first.map { ($0.num, $0.den) } ?? (4, 4)
        let primaryTempo = tempos.first?.mpq ?? 500_000
        let barTicks = max(1, Double(primary.0) * Double(division) * (4 / Double(primary.1)))
        return SMFSong(format: format, division: division, durationSec: tickToSec(tempoMap, div, Double(maxTick)), maxTick: maxTick,
                       tracks: tracks, totalBars: max(1, Double(maxTick) / barTicks),
                       bpm: Int((60_000_000 / Double(primaryTempo)).rounded(.toNearestOrAwayFromZero)),
                       timeSig: "\(primary.0)/\(primary.1)", tempoMap: tempoMap,
                       timeSignatures: timeSigs.map { SMFTimeSignature(tick: $0.tick, numerator: $0.num, denominator: $0.den) })
    }
}
