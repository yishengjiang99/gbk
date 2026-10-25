import Foundation

/// MIDI 1.0 byte-stream framing (running status, system common, realtime, SysEx skipped) and UMP → MIDI 1.0 bytes.
/// Output is one complete message per element, exactly what Web MIDI hands a `midimessage` listener.
struct MIDIMessageParser {
    private var running: UInt8 = 0
    private var pending: [UInt8] = []
    private var inSysEx = false

    /// Data bytes that follow a status byte (nil = SysEx / undefined).
    static func dataLength(_ status: UInt8) -> Int? {
        switch status & 0xF0 {
        case 0x80, 0x90, 0xA0, 0xB0, 0xE0: return 2
        case 0xC0, 0xD0: return 1
        default: break
        }
        switch status {
        case 0xF1, 0xF3: return 1
        case 0xF2: return 2
        case 0xF6, 0xF8...0xFF: return 0
        default: return nil
        }
    }

    mutating func feed<S: Sequence>(_ bytes: S) -> [[UInt8]] where S.Element == UInt8 {
        var out: [[UInt8]] = []
        for b in bytes {
            if b >= 0xF8 { out.append([b]); continue }            // realtime: anywhere, no state change
            if b & 0x80 != 0 {                                     // status
                if b == 0xF0 { inSysEx = true; running = 0; pending = []; continue }
                if b == 0xF7 { inSysEx = false; continue }
                inSysEx = false
                guard let n = Self.dataLength(b) else { running = 0; pending = []; continue }
                if n == 0 { out.append([b]); running = 0; pending = []; continue }
                running = b < 0xF0 ? b : 0                          // system common cancels running status
                pending = [b]
                if b >= 0xF0 { running = 0; pending = [b] }
                continue
            }
            if inSysEx { continue }
            if pending.isEmpty {                                     // running status
                guard running != 0 else { continue }
                pending = [running]
            }
            pending.append(b)
            if let n = Self.dataLength(pending[0]), pending.count == n + 1 {
                out.append(pending)
                pending = []
            }
        }
        return out
    }

    /// Words in one UMP packet for a message type (the top nibble of its first word).
    static func umpWordCount(_ firstWord: UInt32) -> Int {
        switch firstWord >> 28 {
        case 0x0, 0x1, 0x2, 0x6, 0x7: return 1
        case 0x3, 0x4, 0x8, 0x9, 0xA: return 2
        case 0xB, 0xC: return 3
        default: return 4
        }
    }

    /// Convert UMP words to MIDI 1.0 messages. Handles system (0x1), MIDI 1.0 channel voice (0x2) and
    /// MIDI 2.0 channel voice (0x4, scaled down to 7/14-bit). SysEx and other types are dropped.
    static func messages(fromUMP words: [UInt32]) -> [[UInt8]] {
        var out: [[UInt8]] = []
        var i = 0
        while i < words.count {
            let w = words[i], n = umpWordCount(w)
            let status = UInt8((w >> 16) & 0xFF), d1 = UInt8((w >> 8) & 0x7F), d2 = UInt8(w & 0x7F)
            switch w >> 28 {
            case 0x1:
                if let len = dataLength(status) { out.append(Array([status, d1, d2].prefix(len + 1))) }
            case 0x2:
                if let len = dataLength(status), status < 0xF0 { out.append(Array([status, d1, d2].prefix(len + 1))) }
            case 0x4 where i + 1 < words.count:
                let data = words[i + 1], cmd = status & 0xF0
                switch cmd {
                case 0x80, 0x90:
                    var vel = UInt8(data >> 25)                         // 16-bit velocity → 7-bit
                    if cmd == 0x90 && vel == 0 { vel = 1 }              // MIDI 2 note-on vel 0 is still a note-on
                    out.append([status, d1, vel])
                case 0xA0, 0xB0: out.append([status, d1, UInt8(data >> 25)])
                case 0xC0: out.append([status, UInt8((data >> 24) & 0x7F)])
                case 0xD0: out.append([status, UInt8(data >> 25)])
                case 0xE0:
                    let v14 = data >> 18
                    out.append([status, UInt8(v14 & 0x7F), UInt8((v14 >> 7) & 0x7F)])
                default: break
                }
            default: break
            }
            i += n
        }
        return out
    }
}

/// Semantic view of one message, mirroring web `parseMidiMessage` (src/workstation/live-input.ts).
enum MIDIEvent: Equatable {
    case noteOn(channel: UInt8, note: UInt8, velocity: UInt8)
    case noteOff(channel: UInt8, note: UInt8)
    case sustain(channel: UInt8, on: Bool, value: UInt8)   // CC64, on at >= 64
    case modWheel(channel: UInt8, value: UInt8)            // CC1
    case cc(channel: UInt8, controller: UInt8, value: UInt8)
    case pitchBend(channel: UInt8, value: UInt16)          // 0...16383, 8192 centre
    case other

    init(_ d: [UInt8]) {
        guard let st = d.first, st < 0xF0 else { self = .other; return }
        let ch = st & 0x0F, d1 = (d.count > 1 ? d[1] : 0) & 0x7F, d2 = (d.count > 2 ? d[2] : 0) & 0x7F
        switch st & 0xF0 {
        case 0x90 where d2 > 0: self = .noteOn(channel: ch, note: d1, velocity: d2)
        case 0x80, 0x90: self = .noteOff(channel: ch, note: d1)
        case 0xB0 where d1 == 64: self = .sustain(channel: ch, on: d2 >= 64, value: d2)
        case 0xB0 where d1 == 1: self = .modWheel(channel: ch, value: d2)
        case 0xB0: self = .cc(channel: ch, controller: d1, value: d2)
        case 0xE0: self = .pitchBend(channel: ch, value: UInt16(d2) << 7 | UInt16(d1))
        default: self = .other
        }
    }
}
