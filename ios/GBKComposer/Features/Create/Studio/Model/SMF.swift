import Foundation

/// Port of src/workstation/smf.ts: Standard MIDI File parse/serialize for the project model.

private func vlqEncode(_ n: Int) -> [UInt8] {
    var bytes: [UInt8] = [UInt8(n & 0x7f)]
    var v = n >> 7
    while v > 0 { bytes.insert(UInt8(v & 0x7f) | 0x80, at: 0); v >>= 7 }
    return bytes
}

func sanitizeText(_ s: String) -> String {
    let cleaned = s.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7f }
    return String(String.UnicodeScalarView(cleaned).prefix(128))
}

private struct ByteReader {
    let bytes: [UInt8]; var pos = 0
    mutating func u8() throws -> Int {
        guard pos < bytes.count else { throw ToolArgError("INVALID_ARGUMENT", "unexpected end of MIDI data") }
        defer { pos += 1 }
        return Int(bytes[pos])
    }
    mutating func take(_ n: Int) throws -> [UInt8] {
        guard pos + n <= bytes.count else { throw ToolArgError("INVALID_ARGUMENT", "unexpected end of MIDI data") }
        defer { pos += n }
        return Array(bytes[pos..<(pos + n)])
    }
    mutating func vlq() throws -> Int {
        var v = 0
        for _ in 0..<4 {
            let b = try u8()
            v = (v << 7) | (b & 0x7f)
            if b & 0x80 == 0 { return v }
        }
        return v
    }
    var atEnd: Bool { pos >= bytes.count }
}

func parseSmf(_ data: Data, name: String = "Imported") throws -> Project {
    var r = ByteReader(bytes: [UInt8](data))
    let magic = try r.take(4)
    guard magic == [0x4d, 0x54, 0x68, 0x64] else { throw ToolArgError("INVALID_ARGUMENT", "not a MIDI file (missing MThd)") }
    _ = try r.take(4) // header length
    let format = try (r.u8() << 8) | r.u8()
    let ntrks = try (r.u8() << 8) | r.u8()
    let division = try (r.u8() << 8) | r.u8()
    if division & 0x8000 != 0 { throw ToolArgError("INVALID_ARGUMENT", "SMPTE time division is not supported") }
    let ppq = max(1, division)

    var p = emptyProject(name: name, ppq: ppq)
    p.format = format
    p.tempos = []; p.timeSigs = []
    var sawTempo0 = false, sawSig0 = false

    for chunkIdx in 0..<ntrks {
        let chunkMagic = try r.take(4)
        guard chunkMagic == [0x4d, 0x54, 0x72, 0x6b] else { throw ToolArgError("INVALID_ARGUMENT", "bad track chunk") }
        let len = try (r.u8() << 24) | (r.u8() << 16) | (r.u8() << 8) | r.u8()
        var tr = ByteReader(bytes: try r.take(len))
        var tick = 0
        var running: Int? = nil
        var trackName: String? = nil
        var channel: Int? = nil
        var notes: [GNote] = []; var ccs: [CCEvent] = []; var bends: [PitchBendEvent] = []
        var chP: [ChannelPressureEvent] = []; var polyP: [PolyPressureEvent] = []
        var progs: [ProgramEvent] = []; var raw: [RawEvent] = []
        var open: [String: [GNote]] = [:] // "ch:pitch" -> stack of pending notes (velocity placeholder)
        var bankMsb: [Int: Int] = [:]; var bankLsb: [Int: Int] = [:]
        let trackId = newStudioId("trk")
        var lastTick = 0

        func closeNote(ch: Int, pitch: Int, at: Int, offVel: Int) {
            let key = "\(ch):\(pitch)"
            guard var stack = open[key], !stack.isEmpty else { return }
            var n = stack.removeFirst()
            n.duration = max(1, at - n.tick)
            if offVel != 64 { n.offVelocity = offVel }
            notes.append(n)
            open[key] = stack
        }

        while !tr.atEnd {
            let delta = try tr.vlq()
            tick += delta; lastTick = tick
            var status = try tr.u8()
            if status < 0x80 {
                guard let rs = running else { throw ToolArgError("INVALID_ARGUMENT", "running status without a status byte") }
                status = rs
                // push back: the byte was a data byte
                tr.pos -= 1
            }
            if status == 0xff {
                running = nil
                let type = try tr.u8()
                let mlen = try tr.vlq()
                let mdata = try tr.take(mlen)
                if type == 0x2f { break }
                switch type {
                case 0x51 where mdata.count == 3:
                    let mpq = (Int(mdata[0]) << 16) | (Int(mdata[1]) << 8) | Int(mdata[2])
                    p.tempos.append(TempoEvent(tick: tick, microPerQuarter: mpq))
                    if tick == 0 { sawTempo0 = true }
                case 0x58 where mdata.count >= 2:
                    p.timeSigs.append(TimeSigEvent(tick: tick, numerator: Int(mdata[0]), denominator: 1 << Int(mdata[1])))
                    if tick == 0 { sawSig0 = true }
                case 0x03:
                    trackName = String(bytes: mdata, encoding: .utf8) ?? trackName
                default:
                    raw.append(RawEvent(id: newStudioId("raw"), trackId: trackId, tick: tick, bytes: [0xff, type] + mdata.map(Int.init), kind: "meta"))
                }
                continue
            }
            if status == 0xf0 || status == 0xf7 {
                running = nil
                let slen = try tr.vlq()
                let sdata = try tr.take(slen)
                raw.append(RawEvent(id: newStudioId("raw"), trackId: trackId, tick: tick, bytes: [status] + sdata.map(Int.init), kind: "sysex"))
                continue
            }
            running = status
            let kind = status & 0xf0
            let ch = status & 0x0f
            if channel == nil && kind != 0xf0 { channel = ch }
            switch kind {
            case 0x80, 0x90:
                let pitch = try tr.u8(); let vel = try tr.u8()
                if kind == 0x90 && vel > 0 {
                    let n = GNote(id: newStudioId("note"), trackId: trackId, channel: ch, tick: tick, duration: 1, pitch: pitch, velocity: vel)
                    open["\(ch):\(pitch)", default: []].append(n)
                } else {
                    closeNote(ch: ch, pitch: pitch, at: tick, offVel: vel)
                }
            case 0xa0:
                let pitch = try tr.u8(); let v = try tr.u8()
                polyP.append(PolyPressureEvent(id: newStudioId("pp"), trackId: trackId, channel: ch, tick: tick, pitch: pitch, value: v))
            case 0xb0:
                let controller = try tr.u8(); let v = try tr.u8()
                if controller == 0 { bankMsb[ch] = v }
                if controller == 32 { bankLsb[ch] = v }
                ccs.append(CCEvent(id: newStudioId("cc"), trackId: trackId, channel: ch, controller: controller, tick: tick, value: v))
            case 0xc0:
                let program = try tr.u8()
                progs.append(ProgramEvent(id: newStudioId("pgm"), trackId: trackId, channel: ch, tick: tick, program: program, bankMsb: bankMsb[ch] ?? 0, bankLsb: bankLsb[ch] ?? 0))
            case 0xd0:
                let v = try tr.u8()
                chP.append(ChannelPressureEvent(id: newStudioId("cp"), trackId: trackId, channel: ch, tick: tick, value: v))
            case 0xe0:
                let lsb = try tr.u8(); let msb = try tr.u8()
                bends.append(PitchBendEvent(id: newStudioId("bend"), trackId: trackId, channel: ch, tick: tick, value: (msb << 7) | lsb))
            default:
                throw ToolArgError("INVALID_ARGUMENT", "unsupported MIDI status 0x\(String(status, radix: 16))")
            }
        }
        // Dangling notes close at the track's end.
        for key in Array(open.keys) {
            let parts = key.split(separator: ":")
            while open[key]?.isEmpty == false {
                closeNote(ch: Int(parts[0]) ?? 0, pitch: Int(parts[1]) ?? 0, at: lastTick, offVel: 64)
            }
        }
        let hasChannelEvents = !(notes.isEmpty && ccs.isEmpty && progs.isEmpty && bends.isEmpty && chP.isEmpty && polyP.isEmpty)
        if format == 1 && chunkIdx == 0 && !hasChannelEvents { continue } // conductor chunk: maps already harvested
        let track = GTrack(id: trackId, name: trackName ?? "Track \(p.tracks.count + 1)", channel: channel ?? 0,
                           color: trackColors[p.tracks.count % trackColors.count], mix: .default, visible: true)
        p.tracks.append(track)
        p.notes.append(contentsOf: notes); p.ccs.append(contentsOf: ccs); p.pitchBends.append(contentsOf: bends)
        p.channelPressure.append(contentsOf: chP); p.polyPressure.append(contentsOf: polyP)
        p.programs.append(contentsOf: progs); p.raw.append(contentsOf: raw)
    }
    if !sawTempo0 { p.tempos.insert(TempoEvent(tick: 0, microPerQuarter: 500000), at: 0) }
    if !sawSig0 { p.timeSigs.insert(TimeSigEvent(tick: 0, numerator: 4, denominator: 4), at: 0) }
    p.tempos.sort { $0.tick < $1.tick }; p.timeSigs.sort { $0.tick < $1.tick }
    p.notes.sort { ($0.tick, $0.pitch) < ($1.tick, $1.pitch) }
    p.endTick = computeEndTick(p)
    return p
}

// MARK: - Serialize

private struct OutEvent { var tick: Int; var order: Int; var seq: Int; var bytes: [UInt8] }

private func trackChunk(_ events: [OutEvent]) -> [UInt8] {
    let sorted = events.sorted { ($0.tick, $0.order, $0.seq) < ($1.tick, $1.order, $1.seq) }
    var body: [UInt8] = []
    var prev = 0
    for e in sorted {
        body += vlqEncode(max(0, e.tick - prev))
        body += e.bytes
        prev = e.tick
    }
    body += [0x00, 0xff, 0x2f, 0x00]
    var chunk: [UInt8] = [0x4d, 0x54, 0x72, 0x6b]
    chunk += [UInt8((body.count >> 24) & 0xff), UInt8((body.count >> 16) & 0xff), UInt8((body.count >> 8) & 0xff), UInt8(body.count & 0xff)]
    chunk += body
    return chunk
}

func serializeSmf(_ p: Project, soundNrpn: Bool = false) -> Data {
    var chunks: [[UInt8]] = []
    // Conductor track.
    var cond: [OutEvent] = []
    var seq = 0
    for t in p.tempos {
        let mpq = t.microPerQuarter
        cond.append(OutEvent(tick: t.tick, order: 0, seq: seq, bytes: [0xff, 0x51, 0x03, UInt8((mpq >> 16) & 0xff), UInt8((mpq >> 8) & 0xff), UInt8(mpq & 0xff)])); seq += 1
    }
    for s in p.timeSigs {
        let dd = Int(log2(Double(max(1, s.denominator))))
        cond.append(OutEvent(tick: s.tick, order: 1, seq: seq, bytes: [0xff, 0x58, 0x04, UInt8(s.numerator), UInt8(dd), 0x18, 0x08])); seq += 1
    }
    if let key = parseKey(p.meta?.key) {
        cond.append(OutEvent(tick: 0, order: 2, seq: seq, bytes: [0xff, 0x59, 0x02, UInt8(bitPattern: Int8(key.sf)), key.mode == "minor" ? 1 : 0])); seq += 1
    }
    for s in p.meta?.sections ?? [] {
        let tick = barBeatToTick(p, bar: s.startBar, beat: 0)
        let nameBytes = [UInt8](sanitizeText(s.name).utf8)
        cond.append(OutEvent(tick: tick, order: 3, seq: seq, bytes: [0xff, 0x06] + vlqEncode(nameBytes.count) + nameBytes)); seq += 1
    }
    chunks.append(trackChunk(cond))

    // Same-tick order: bank CC 0, program 1, noteOff 2, noteOn 3, other CC 4, bend 5, pressure 6.
    for track in p.tracks {
        var evs: [OutEvent] = []
        var s2 = 0
        func push(_ tick: Int, _ order: Int, _ bytes: [UInt8]) { evs.append(OutEvent(tick: tick, order: order, seq: s2, bytes: bytes)); s2 += 1 }
        let nameBytes = [UInt8](sanitizeText(track.name).utf8)
        push(0, 0, [0xff, 0x03] + vlqEncode(nameBytes.count) + nameBytes)
        for r in p.raw where r.trackId == track.id {
            if r.bytes.first == 0xff, r.bytes.count >= 2 {
                let payload = Array(r.bytes.dropFirst(2))
                push(r.tick, 0, [0xff, UInt8(r.bytes[1])] + vlqEncode(payload.count) + payload.map(UInt8.init))
            } else if r.bytes.first == 0xf0 || r.bytes.first == 0xf7 {
                let payload = Array(r.bytes.dropFirst())
                push(r.tick, 0, [UInt8(r.bytes[0])] + vlqEncode(payload.count) + payload.map(UInt8.init))
            }
        }
        for pgm in p.programs where pgm.trackId == track.id {
            if pgm.bankMsb != 0 { push(pgm.tick, 0, [0xb0 | UInt8(pgm.channel), 0, UInt8(pgm.bankMsb)]) }
            if pgm.bankLsb != 0 { push(pgm.tick, 0, [0xb0 | UInt8(pgm.channel), 32, UInt8(pgm.bankLsb)]) }
            push(pgm.tick, 1, [0xc0 | UInt8(pgm.channel), UInt8(pgm.program)])
        }
        for n in p.notes where n.trackId == track.id {
            push(n.tick + n.duration, 2, [0x80 | UInt8(n.channel), UInt8(n.pitch), UInt8(n.offVelocity ?? 64)])
            push(n.tick, 3, [0x90 | UInt8(n.channel), UInt8(n.pitch), UInt8(n.velocity)])
        }
        for c in p.ccs where c.trackId == track.id {
            let order = (c.controller == 0 || c.controller == 32) ? 0 : 4
            push(c.tick, order, [0xb0 | UInt8(c.channel), UInt8(c.controller), UInt8(c.value)])
        }
        if soundNrpn, let ovs = p.sound?.tracks[track.id], !ovs.isEmpty {
            for (controller, value) in overridesToNrpn(ovs) {
                push(0, 4, [0xb0 | UInt8(track.channel), UInt8(controller), UInt8(value)])
            }
        }
        for b in p.pitchBends where b.trackId == track.id {
            push(b.tick, 5, [0xe0 | UInt8(b.channel), UInt8(b.value & 0x7f), UInt8((b.value >> 7) & 0x7f)])
        }
        for e in p.channelPressure where e.trackId == track.id {
            push(e.tick, 6, [0xd0 | UInt8(e.channel), UInt8(e.value)])
        }
        for e in p.polyPressure where e.trackId == track.id {
            push(e.tick, 6, [0xa0 | UInt8(e.channel), UInt8(e.pitch), UInt8(e.value)])
        }
        chunks.append(trackChunk(evs))
    }

    var out: [UInt8] = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1,
                        UInt8((chunks.count >> 8) & 0xff), UInt8(chunks.count & 0xff),
                        UInt8((p.ppq >> 8) & 0xff), UInt8(p.ppq & 0xff)]
    for c in chunks { out += c }
    return Data(out)
}
