import Foundation

/// Score -> Standard MIDI File (type 1, 480 TPQ): conductor track (tempo, time sig, key) + one track per part.
enum SMFWriter {
    static let tpq = 480

    static func data(for score: Score) -> Data {
        var conductor: [(Int, [UInt8])] = []
        let bpm = (score.tempo ?? 120) > 0 ? (score.tempo ?? 120) : 120
        let mpq = Int((60_000_000 / bpm).rounded())
        conductor.append((0, [0xff, 0x51, 3, UInt8(mpq >> 16 & 0xff), UInt8(mpq >> 8 & 0xff), UInt8(mpq & 0xff)]))
        if let ts = score.timeSig, ts.denominator > 0 {
            let pow = max(0, Int(log2(Double(ts.denominator)).rounded()))
            conductor.append((0, [0xff, 0x58, 4, UInt8(clamping: ts.numerator), UInt8(pow), 24, 8]))
        }
        if let key = score.key, let k = keySignature(key) { conductor.append((0, [0xff, 0x59, 2, UInt8(bitPattern: Int8(k.sharps)), k.minor ? 1 : 0])) }
        var tracks = [track(conductor)]
        for (i, part) in score.parts.enumerated() where !part.notes.isEmpty {
            let ch = UInt8(channel(for: i))
            var ev: [(Int, [UInt8])] = [(0, [0xff, 0x03] + vlq(part.name.utf8.count) + Array(part.name.utf8))]
            ev.append((0, [0xc0 | ch, UInt8(clamping: part.program ?? 0)]))
            for n in part.notes {
                let on = max(0, Int((n.onset * Double(tpq)).rounded()))
                let off = on + max(1, Int((n.duration * Double(tpq)).rounded()))
                let p = UInt8(clamping: min(127, max(0, n.pitch)))
                ev.append((off, [0x80 | ch, p, 0]))
                ev.append((on, [0x90 | ch, p, UInt8(clamping: min(127, max(1, n.velocity)))]))
            }
            tracks.append(track(ev))
        }
        var out: [UInt8] = Array("MThd".utf8) + [0, 0, 0, 6, 0, 1] + u16(tracks.count) + u16(tpq)
        for t in tracks { out += t }
        return Data(out)
    }

    /// Channels like the studio's nextMelodicChannel: 0..15 skipping 9 (drums).
    static func channel(for part: Int) -> Int { let c = part % 15; return c >= 9 ? c + 1 : c }

    private static func track(_ events: [(Int, [UInt8])]) -> [UInt8] {
        // Stable sort by tick; at equal ticks note-offs (0x8n) before note-ons so repeated pitches retrigger.
        let sorted = events.enumerated().sorted { a, b in
            if a.element.0 != b.element.0 { return a.element.0 < b.element.0 }
            let ao = a.element.1[0] & 0xf0 == 0x80, bo = b.element.1[0] & 0xf0 == 0x80
            return ao != bo ? ao : a.offset < b.offset
        }.map(\.element)
        var body: [UInt8] = [], last = 0
        for (t, e) in sorted { body += vlq(t - last) + e; last = t }
        body += [0, 0xff, 0x2f, 0]
        return Array("MTrk".utf8) + u32(body.count) + body
    }

    static func vlq(_ v: Int) -> [UInt8] {
        var v = max(0, v), out = [UInt8(v & 0x7f)]
        v >>= 7
        while v > 0 { out.insert(UInt8(v & 0x7f) | 0x80, at: 0); v >>= 7 }
        return out
    }
    private static func u16(_ v: Int) -> [UInt8] { [UInt8(v >> 8 & 0xff), UInt8(v & 0xff)] }
    private static func u32(_ v: Int) -> [UInt8] { [UInt8(v >> 24 & 0xff), UInt8(v >> 16 & 0xff), UInt8(v >> 8 & 0xff), UInt8(v & 0xff)] }

    static func keySignature(_ name: String) -> (sharps: Int, minor: Bool)? {
        let minor = name.hasSuffix("m")
        let root = minor ? String(name.dropLast()) : name
        let majors = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"]
        let minors = ["Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#", "G#", "D#", "A#"]
        guard let i = (minor ? minors : majors).firstIndex(of: root) else { return nil }
        return (i - 7, minor)
    }
}
