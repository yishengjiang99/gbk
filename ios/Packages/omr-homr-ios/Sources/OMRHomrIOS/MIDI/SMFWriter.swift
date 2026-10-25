import Foundation

/// Minimal Standard MIDI File writer — **Format 1**, **480 TPQ**, metrical division.
///
/// Web-player-compatible subset: conductor track (name, tempo, optional time signature) +
/// one note track per staff, top-to-bottom (track index − 1 == staff index), program 0,
/// noteOn/noteOff only. See `write(notes:staffCount:)`.
public struct SMFWriter: Sendable {
    public static let ticksPerQuarter: UInt16 = 480
    public static let format: UInt16 = 1

    public var tempoMicroseconds: UInt32
    public var defaultVelocity: UInt8
    /// When set, writes FF 58 time-signature meta on the conductor track (metrical SMF).
    public var timeSignature: TimeSignature?

    public struct TimeSignature: Equatable, Sendable {
        public var numerator: UInt8
        public var denominatorPowerOfTwo: UInt8 // 2 = quarter (denom 4), MIDI meta encoding
        public var metronome: UInt8
        public var thirtySeconds: UInt8

        /// Common-time 4/4.
        public static let fourFour = TimeSignature(
            numerator: 4,
            denominatorPowerOfTwo: 2,
            metronome: 24,
            thirtySeconds: 8
        )

        public init(
            numerator: UInt8,
            denominatorPowerOfTwo: UInt8,
            metronome: UInt8 = 24,
            thirtySeconds: UInt8 = 8
        ) {
            self.numerator = numerator
            self.denominatorPowerOfTwo = denominatorPowerOfTwo
            self.metronome = metronome
            self.thirtySeconds = thirtySeconds
        }
    }

    public init(
        tempoMicroseconds: UInt32 = 500_000,
        defaultVelocity: UInt8 = 80,
        timeSignature: TimeSignature? = .fourFour
    ) {
        self.tempoMicroseconds = tempoMicroseconds
        self.defaultVelocity = defaultVelocity
        self.timeSignature = timeSignature
    }

    public struct NoteEvent: Equatable, Sendable {
        public var midiNote: UInt8
        public var onsetTicks: Int
        public var durationTicks: Int
        public var channel: UInt8
        public var velocity: UInt8?
        /// Staff index for Layer B canonicalize compares (`expected.notes.csv` column).
        public var staff: Int

        public init(
            midiNote: UInt8,
            onsetTicks: Int,
            durationTicks: Int,
            channel: UInt8 = 0,
            velocity: UInt8? = nil,
            staff: Int = 0
        ) {
            self.midiNote = midiNote
            self.onsetTicks = onsetTicks
            self.durationTicks = durationTicks
            self.channel = channel
            self.velocity = velocity
            self.staff = staff
        }
    }

    /// Conductor track name (FF 03) written on track 0.
    public static let conductorTrackName = "OMRHomrIOS"

    /// Write SMF format 1 @ 480 TPQ with **one track per staff**.
    ///
    /// Track layout (contract):
    /// - Track 0: conductor — track name, tempo, optional time signature (default 4/4). No notes.
    /// - Track 1 + s: staff `s` (0 = top staff), top-to-bottom. Each staff track holds a
    ///   program change to program 0 at tick 0, then noteOn/noteOff only.
    ///   `staff index == track index - 1`, so a note's staff is recoverable from its track.
    ///
    /// Staff track count = `max(1, staffCount ?? 0, highest note staff + 1)`; staves with no
    /// notes between the top and the highest used staff still get an (empty) track so the
    /// index mapping holds. Within a track, note-ons at the same tick keep input order, so
    /// merging all note-ons by `(tick, track)` reproduces input order when input is sorted by
    /// `(tick, staff, …)` (as `SymbolMIDIMapping.orderedNoteEvents` is).
    public func write(notes: [NoteEvent], staffCount: Int? = nil) -> Data {
        let maxStaff = notes.map { max(0, $0.staff) }.max() ?? -1
        let staffTracks = max(1, staffCount ?? 0, maxStaff + 1)
        var perStaff: [[(order: Int, note: NoteEvent)]] = Array(repeating: [], count: staffTracks)
        for (i, n) in notes.enumerated() {
            perStaff[max(0, n.staff)].append((order: i, note: n))
        }
        var tracks: [Data] = [makeConductorTrack()]
        for staffNotes in perStaff {
            tracks.append(makeStaffTrack(notes: staffNotes))
        }
        return assembleFile(tracks: tracks)
    }

    /// Convenience: map decoded symbols via `SymbolMIDIMapping` then write.
    /// Skips symbols that are not `note_*` with a scientific pitch token — no invented pitches.
    public func write(symbols: [EncodedSymbol]) -> Data {
        write(notes: SymbolMIDIMapping.noteEvents(from: symbols, tpq: Int(Self.ticksPerQuarter)))
    }

    /// Empty score (conductor + one empty staff track) — useful for structure tests.
    public func writeEmpty() -> Data {
        write(notes: [])
    }

    // MARK: - File assembly

    private func assembleFile(tracks: [Data]) -> Data {
        var data = Data()
        data.append(ascii("MThd"))
        data.append(u32be(6)) // header body length
        data.append(u16be(Self.format))
        data.append(u16be(UInt16(tracks.count)))
        data.append(u16be(Self.ticksPerQuarter)) // metrical division (positive)
        for track in tracks {
            data.append(ascii("MTrk"))
            data.append(u32be(UInt32(track.count)))
            data.append(track)
        }
        return data
    }

    private func makeConductorTrack() -> Data {
        var events = Data()
        // delta 0, meta FF 03 len name
        let name = Array(Self.conductorTrackName.utf8)
        events.append(contentsOf: Self.encodeVLQ(0))
        events.append(contentsOf: [0xFF, 0x03])
        events.append(contentsOf: Self.encodeVLQ(name.count))
        events.append(contentsOf: name)
        // delta 0, meta FF 51 03 tttttt
        events.append(contentsOf: Self.encodeVLQ(0))
        events.append(contentsOf: [0xFF, 0x51, 0x03])
        events.append(u24be(tempoMicroseconds))
        if let ts = timeSignature {
            events.append(contentsOf: Self.encodeVLQ(0))
            events.append(contentsOf: [
                0xFF, 0x58, 0x04,
                ts.numerator,
                ts.denominatorPowerOfTwo,
                ts.metronome,
                ts.thirtySeconds,
            ])
        }
        // end of track
        events.append(contentsOf: Self.encodeVLQ(0))
        events.append(contentsOf: [0xFF, 0x2F, 0x00])
        return events
    }

    private func makeStaffTrack(notes: [(order: Int, note: NoteEvent)]) -> Data {
        struct MIDIInstant: Comparable {
            var tick: Int
            var order: Int // note-off (0) before note-on (1 + input index) at same tick
            var bytes: [UInt8]
            static func < (lhs: MIDIInstant, rhs: MIDIInstant) -> Bool {
                if lhs.tick != rhs.tick { return lhs.tick < rhs.tick }
                return lhs.order < rhs.order
            }
        }

        var instants: [MIDIInstant] = []
        for (i, n) in notes {
            let vel = n.velocity ?? defaultVelocity
            let ch = n.channel & 0x0F
            let pitch = n.midiNote & 0x7F
            let on: [UInt8] = [0x90 | ch, pitch, vel & 0x7F]
            let off: [UInt8] = [0x80 | ch, pitch, 0x40]
            instants.append(MIDIInstant(tick: max(0, n.onsetTicks), order: 1 + i, bytes: on))
            instants.append(
                MIDIInstant(
                    tick: max(0, n.onsetTicks) + max(0, n.durationTicks),
                    order: 0,
                    bytes: off
                )
            )
        }
        instants.sort()

        var events = Data()
        // Program 0 (Acoustic Grand) on every channel this staff uses (channel 0 when empty).
        let channels = Set(notes.map { $0.note.channel & 0x0F })
        for ch in (channels.isEmpty ? [UInt8(0)] : channels.sorted()) {
            events.append(contentsOf: Self.encodeVLQ(0))
            events.append(contentsOf: [0xC0 | ch, 0x00])
        }
        var lastTick = 0
        for inst in instants {
            let delta = max(0, inst.tick - lastTick)
            events.append(contentsOf: Self.encodeVLQ(delta))
            events.append(contentsOf: inst.bytes)
            lastTick = inst.tick
        }
        events.append(contentsOf: Self.encodeVLQ(0))
        events.append(contentsOf: [0xFF, 0x2F, 0x00])
        return events
    }

    // MARK: - Binary helpers

    public static func encodeVLQ(_ value: Int) -> [UInt8] {
        var v = UInt32(max(0, value))
        var stack: [UInt8] = []
        stack.append(UInt8(v & 0x7F))
        v >>= 7
        while v > 0 {
            stack.append(UInt8((v & 0x7F) | 0x80))
            v >>= 7
        }
        return stack.reversed()
    }

    private func ascii(_ s: String) -> Data {
        Data(s.utf8)
    }

    private func u16be(_ v: UInt16) -> Data {
        Data([UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)])
    }

    private func u32be(_ v: UInt32) -> Data {
        Data([
            UInt8((v >> 24) & 0xFF),
            UInt8((v >> 16) & 0xFF),
            UInt8((v >> 8) & 0xFF),
            UInt8(v & 0xFF),
        ])
    }

    private func u24be(_ v: UInt32) -> Data {
        Data([
            UInt8((v >> 16) & 0xFF),
            UInt8((v >> 8) & 0xFF),
            UInt8(v & 0xFF),
        ])
    }
}

/// Lightweight SMF header inspection for tests (no full parser).
public enum SMFHeaderInspector {
    public struct Header: Equatable, Sendable {
        public var format: UInt16
        public var trackCount: UInt16
        public var division: UInt16
    }

    public static func readHeader(from data: Data) -> Header? {
        guard data.count >= 14 else { return nil }
        let magic = String(data: data[0..<4], encoding: .ascii)
        guard magic == "MThd" else { return nil }
        let format = u16(data, 8)
        let tracks = u16(data, 10)
        let division = u16(data, 12)
        // Metrical division: high bit clear
        guard division & 0x8000 == 0 else { return nil }
        return Header(format: format, trackCount: tracks, division: division)
    }

    public static func trackChunkCount(in data: Data) -> Int {
        var count = 0
        var i = 14
        let bytes = [UInt8](data)
        while i + 8 <= bytes.count {
            let tag = String(bytes: bytes[i..<i + 4], encoding: .ascii)
            let len = Int(u32(data, i + 4))
            guard tag == "MTrk" else { break }
            count += 1
            i += 8 + len
        }
        return count
    }

    /// True when conductor track contains FF 58 time-signature meta (metrical cue).
    public static func containsTimeSignatureMeta(in data: Data) -> Bool {
        guard data.count >= 14 else { return false }
        let i = 14
        let bytes = [UInt8](data)
        // Inspect first MTrk only (conductor)
        guard i + 8 <= bytes.count else { return false }
        guard String(bytes: bytes[i..<i + 4], encoding: .ascii) == "MTrk" else { return false }
        let len = Int(u32(data, i + 4))
        let start = i + 8
        let end = min(bytes.count, start + len)
        var j = start
        while j + 2 < end {
            // Skip VLQ delta
            while j < end, bytes[j] & 0x80 != 0 { j += 1 }
            if j >= end { break }
            j += 1 // last VLQ byte
            guard j + 2 < end else { break }
            if bytes[j] == 0xFF, bytes[j + 1] == 0x58 {
                return true
            }
            if bytes[j] == 0xFF {
                // meta: FF type len ...
                guard j + 2 < end else { break }
                let metaLen = Int(bytes[j + 2])
                j += 3 + metaLen
                continue
            }
            // Channel voice / other — rough skip: status + 1 or 2 data bytes
            let status = bytes[j]
            let hi = status >> 4
            if hi == 0xC || hi == 0xD {
                j += 2
            } else if status == 0xF0 || status == 0xF7 {
                break
            } else {
                j += 3
            }
        }
        return false
    }

    private static func u16(_ data: Data, _ offset: Int) -> UInt16 {
        UInt16(data[offset]) << 8 | UInt16(data[offset + 1])
    }

    private static func u32(_ data: Data, _ offset: Int) -> UInt32 {
        let b0: UInt32 = UInt32(data[offset]) << 24
        let b1: UInt32 = UInt32(data[offset + 1]) << 16
        let b2: UInt32 = UInt32(data[offset + 2]) << 8
        let b3: UInt32 = UInt32(data[offset + 3])
        return b0 | b1 | b2 | b3
    }
}
