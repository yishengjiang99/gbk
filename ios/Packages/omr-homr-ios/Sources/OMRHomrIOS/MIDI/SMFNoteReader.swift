import Foundation

// Part of omr-homr-ios (AGPL-3.0; see this package's LICENSE / NOTICE).
//
// Foundation-only on purpose: must build on Linux (`swift test`) and back the headless
// `omr-test` CLI. Do NOT import AVFoundation / CoreMIDI / CoreGraphics here.
//
// Public API is consumed by `omr-test` (OMR Core) and the app's `MIDINoteExtractor`;
// keep `SMFNote` / `SMFNoteReader.notes(from:)` / `SMFNoteReader.read(from:)` stable.

/// One sounding note recovered from Standard MIDI File bytes.
///
/// `track` is the zero-based `MTrk` chunk index (format 1: `0` = conductor). Use
/// `SMFNoteReader.staff(forTrack:format:)` (or `staff`) to map it to the zero-based staff index
/// used by `fixtures/*/expected.notes.csv`.
public struct SMFNote: Equatable, Hashable, Sendable, CustomStringConvertible {
    /// Absolute onset in SMF ticks (metrical division, e.g. 480 TPQ).
    public var tick: Int
    /// MIDI note number 0...127.
    public var pitch: Int
    /// Note-off tick minus note-on tick (>= 0).
    public var duration: Int
    /// Zero-based `MTrk` chunk index the note lives in.
    public var track: Int
    /// MIDI channel 0...15.
    public var channel: Int
    /// Note-on velocity (always > 0 — velocity-0 note-ons are treated as note-offs).
    public var velocity: Int

    public init(tick: Int, pitch: Int, duration: Int, track: Int, channel: Int = 0, velocity: Int) {
        self.tick = tick
        self.pitch = pitch
        self.duration = duration
        self.track = track
        self.channel = channel
        self.velocity = velocity
    }

    /// Zero-based staff index for a **format 1** file (`track - 1`); nil on the conductor track.
    /// For format 0 files use `SMFNoteReader.staff(forTrack:format:)` with `format: 0`.
    public var staff: Int? { SMFNoteReader.staff(forTrack: track, format: 1) }

    public var description: String { "(t\(tick) p\(pitch) d\(duration) trk\(track) ch\(channel) v\(velocity))" }
}

/// Headless SMF (format 0/1) note-on/off reader — the Layer B / playback-smoke compare source:
/// `SMFNoteReader.notes(from: bytes)` → sorted `(tick, pitch, duration[, staff])` == `expected.notes.csv`.
///
/// Handles: running status, note-on velocity 0 as note-off, meta + sysex skipping, unknown
/// chunk skipping, overlapping same-pitch notes on one channel (FIFO pairing), stray note-offs
/// (ignored), and notes left hanging at end of track (closed at the track's final tick).
///
/// ## Track → staff convention (`expected.notes.csv` `staff` column)
/// The CSV `staff` column is **zero-based**, top staff first (`upper` → 0, `lower` → 1; see
/// `SymbolMIDIMapping.staffIndex(positionToken:)`). `SMFWriter` format 1 layout is
/// track 0 = conductor (tempo / time signature, no notes), then one track per staff top → bottom,
/// so **`staff = track - 1`** (track 1 → staff 0, track 2 → staff 1, …). No 1-based offset.
/// Format 0 (single track) maps everything to staff 0.
///
/// `SMFWriter.write(notes:staffCount:)` emits one track per staff (including empty tracks for
/// unused staves below the top), so the mapping holds. Staff compares are only meaningful when
/// the file has more than one note track (see `Contents.noteTrackCount`): with a single note
/// track every note maps to staff 0 regardless of what the source notation said.
public enum SMFNoteReader {

    /// Format 1 conductor track index.
    public static let conductorTrackIndex = 0

    public struct Header: Equatable, Sendable {
        public var format: Int
        /// Track count declared in `MThd` (may differ from `MTrk` chunks actually present).
        public var trackCount: Int
        /// Metrical division (ticks per quarter note).
        public var division: Int

        public init(format: Int, trackCount: Int, division: Int) {
            self.format = format
            self.trackCount = trackCount
            self.division = division
        }
    }

    /// Full parse result.
    public struct Contents: Equatable, Sendable {
        public var header: Header
        /// Number of `MTrk` chunks actually parsed (0-based track indices are `0..<parsedTrackCount`).
        public var parsedTrackCount: Int
        /// Sounding notes sorted by `(tick, track, pitch)` (ties broken by `channel`).
        public var notes: [SMFNote]

        public init(header: Header, parsedTrackCount: Int, notes: [SMFNote]) {
            self.header = header
            self.parsedTrackCount = parsedTrackCount
            self.notes = notes
        }

        /// Non-conductor track chunks (format 1: `parsedTrackCount - 1`; format 0: `parsedTrackCount`).
        /// Counts note tracks even if a given staff track happens to be empty.
        public var noteTrackCount: Int {
            header.format == 0 ? parsedTrackCount : max(0, parsedTrackCount - 1)
        }

        /// Zero-based staff for `note` per the convention above (nil for conductor-track notes).
        public func staff(of note: SMFNote) -> Int? {
            SMFNoteReader.staff(forTrack: note.track, format: header.format)
        }
    }

    public enum ReadError: Error, Equatable, Sendable {
        case notSMF
        case smpteDivisionUnsupported
        case truncated(offset: Int)
        case unexpectedDataByte(offset: Int)
    }

    /// Sounding notes sorted by `(tick, track, pitch)` (ties broken by `channel`).
    public static func notes(from data: Data) throws -> [SMFNote] {
        try read(from: data).notes
    }

    /// Track index → zero-based staff index (CSV convention).
    ///
    /// - format 1 (and 2): `track - 1`; returns nil for the conductor (`track 0`) or negative input.
    /// - format 0: the single track is staff 0.
    public static func staff(forTrack track: Int, format: Int = 1) -> Int? {
        if format == 0 { return track == 0 ? 0 : nil }
        guard track > conductorTrackIndex else { return nil }
        return track - 1
    }

    /// Inverse of `staff(forTrack:format:)` for format 1: staff → `staff + 1`.
    public static func track(forStaff staff: Int) -> Int {
        staff + 1
    }

    /// Parse header + every `MTrk` chunk. Throws `ReadError` on non-SMF / SMPTE / truncated input.
    public static func read(from data: Data) throws -> Contents {
        let bytes = [UInt8](data)
        guard bytes.count >= 14,
              bytes[0] == 0x4D, bytes[1] == 0x54, bytes[2] == 0x68, bytes[3] == 0x64 // "MThd"
        else { throw ReadError.notSMF }

        let headerLength = Int(try readU32(bytes, 4))
        guard headerLength >= 6 else { throw ReadError.notSMF }
        let format = Int(try readU16(bytes, 8))
        let trackCount = Int(try readU16(bytes, 10))
        let division = Int(try readU16(bytes, 12))
        guard division & 0x8000 == 0 else { throw ReadError.smpteDivisionUnsupported }
        let header = Header(format: format, trackCount: trackCount, division: division)

        var notes: [SMFNote] = []
        var offset = 8 + headerLength
        var trackIndex = 0
        while offset + 8 <= bytes.count {
            let isTrack = bytes[offset] == 0x4D && bytes[offset + 1] == 0x54
                && bytes[offset + 2] == 0x72 && bytes[offset + 3] == 0x6B // "MTrk"
            let length = Int(try readU32(bytes, offset + 4))
            let bodyStart = offset + 8
            let bodyEnd = bodyStart + length
            guard bodyEnd <= bytes.count else { throw ReadError.truncated(offset: offset) }
            if isTrack {
                notes.append(contentsOf: try parseTrack(bytes, start: bodyStart, end: bodyEnd, track: trackIndex))
                trackIndex += 1
            }
            // Non-MTrk chunks are skipped per the SMF spec.
            offset = bodyEnd
        }

        notes.sort { a, b in
            if a.tick != b.tick { return a.tick < b.tick }
            if a.track != b.track { return a.track < b.track }
            if a.pitch != b.pitch { return a.pitch < b.pitch }
            return a.channel < b.channel
        }
        return Contents(header: header, parsedTrackCount: trackIndex, notes: notes)
    }

    // MARK: - Track parsing

    private struct PendingOn {
        var tick: Int
        var velocity: Int
    }

    private static func parseTrack(_ bytes: [UInt8], start: Int, end: Int, track: Int) throws -> [SMFNote] {
        var out: [SMFNote] = []
        // key = channel * 128 + pitch → FIFO of open note-ons
        var pending: [Int: [PendingOn]] = [:]
        var i = start
        var tick = 0
        var runningStatus: UInt8?

        func close(channel: Int, pitch: Int, at t: Int) {
            let key = channel * 128 + pitch
            guard var queue = pending[key], !queue.isEmpty else { return } // stray note-off
            let on = queue.removeFirst()
            pending[key] = queue.isEmpty ? nil : queue
            out.append(SMFNote(
                tick: on.tick,
                pitch: pitch,
                duration: max(0, t - on.tick),
                track: track,
                channel: channel,
                velocity: on.velocity
            ))
        }

        while i < end {
            let (delta, afterDelta) = try readVLQ(bytes, i, end: end)
            tick += delta
            i = afterDelta
            guard i < end else { throw ReadError.truncated(offset: i) }

            var status = bytes[i]
            if status & 0x80 != 0 {
                i += 1
            } else {
                // Running status: reuse previous channel status; `i` stays on the data byte.
                guard let rs = runningStatus else { throw ReadError.unexpectedDataByte(offset: i) }
                status = rs
            }

            switch status {
            case 0xFF: // meta: type, VLQ length, data
                runningStatus = nil
                guard i < end else { throw ReadError.truncated(offset: i) }
                let type = bytes[i]
                i += 1
                let (len, afterLen) = try readVLQ(bytes, i, end: end)
                i = afterLen + len
                guard i <= end else { throw ReadError.truncated(offset: afterLen) }
                if type == 0x2F { // end of track
                    i = end
                }
            case 0xF0, 0xF7: // sysex / escape: VLQ length, data
                runningStatus = nil
                let (len, afterLen) = try readVLQ(bytes, i, end: end)
                i = afterLen + len
                guard i <= end else { throw ReadError.truncated(offset: afterLen) }
            default:
                guard status >= 0x80, status < 0xF0 else {
                    // System common / realtime bytes are not valid in SMF tracks; bail safely.
                    throw ReadError.unexpectedDataByte(offset: i)
                }
                runningStatus = status
                let kind = status & 0xF0
                let channel = Int(status & 0x0F)
                let dataCount = (kind == 0xC0 || kind == 0xD0) ? 1 : 2
                guard i + dataCount <= end else { throw ReadError.truncated(offset: i) }
                let d1 = Int(bytes[i] & 0x7F)
                let d2 = dataCount == 2 ? Int(bytes[i + 1] & 0x7F) : 0
                i += dataCount

                if kind == 0x90, d2 > 0 {
                    pending[channel * 128 + d1, default: []].append(PendingOn(tick: tick, velocity: d2))
                } else if kind == 0x80 || (kind == 0x90 && d2 == 0) {
                    close(channel: channel, pitch: d1, at: tick)
                }
            }
        }

        // Notes never switched off: close at the final track tick so they still count as sounding.
        for key in pending.keys.sorted() {
            while pending[key]?.isEmpty == false {
                close(channel: key / 128, pitch: key % 128, at: tick)
            }
        }
        return out
    }

    // MARK: - Binary helpers

    private static func readVLQ(_ bytes: [UInt8], _ start: Int, end: Int) throws -> (value: Int, next: Int) {
        var value = 0
        var i = start
        for _ in 0..<4 {
            guard i < end else { throw ReadError.truncated(offset: i) }
            let b = bytes[i]
            i += 1
            value = (value << 7) | Int(b & 0x7F)
            if b & 0x80 == 0 { return (value, i) }
        }
        throw ReadError.truncated(offset: start) // VLQ longer than 4 bytes is invalid
    }

    private static func readU16(_ bytes: [UInt8], _ at: Int) throws -> UInt16 {
        guard at + 2 <= bytes.count else { throw ReadError.truncated(offset: at) }
        return UInt16(bytes[at]) << 8 | UInt16(bytes[at + 1])
    }

    private static func readU32(_ bytes: [UInt8], _ at: Int) throws -> UInt32 {
        guard at + 4 <= bytes.count else { throw ReadError.truncated(offset: at) }
        return UInt32(bytes[at]) << 24 | UInt32(bytes[at + 1]) << 16
            | UInt32(bytes[at + 2]) << 8 | UInt32(bytes[at + 3])
    }
}
