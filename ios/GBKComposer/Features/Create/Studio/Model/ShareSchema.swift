import Foundation

/// Port of src/workstation/share-schema.ts: a shared project is untrusted input. Rebuild it from
/// known fields only, enforce hard limits, and drop raw events entirely.
enum ShareLimits {
    static let projectJsonBytes = 6_000_000
    static let tracks = 64
    static let notes = 200_000
    static let events = 200_000
    static let titleChars = 120
}

struct ShareValidationError: Error { var message: String }

func sanitizeSharedProject(_ input: JSONValue) throws -> Project {
    if input.data.count > ShareLimits.projectJsonBytes {
        throw ShareValidationError(message: "shared project exceeds the \(ShareLimits.projectJsonBytes / 1_000_000) MB limit")
    }
    guard var p = Project(json: input) else {
        throw ShareValidationError(message: "shared project is missing its id or name")
    }
    if p.ppq < 24 || p.ppq > 32767 { throw ShareValidationError(message: "shared project has an invalid ppq") }
    if p.tracks.count > ShareLimits.tracks { throw ShareValidationError(message: "shared project has too many tracks") }
    if p.notes.count > ShareLimits.notes { throw ShareValidationError(message: "shared project has too many notes") }
    let eventCount = p.ccs.count + p.pitchBends.count + p.channelPressure.count + p.polyPressure.count + p.programs.count
    if eventCount > ShareLimits.events { throw ShareValidationError(message: "shared project has too many events") }
    let trackIds = Set(p.tracks.map { $0.id })
    p.name = String(sanitizeText(p.name).prefix(ShareLimits.titleChars))
    p.tracks = p.tracks.map { t in
        var t = t
        t.name = String(sanitizeText(t.name).prefix(ShareLimits.titleChars))
        t.channel = min(15, max(0, t.channel))
        t.mix.volume = min(127, max(0, t.mix.volume)); t.mix.pan = min(127, max(0, t.mix.pan)); t.mix.expression = min(127, max(0, t.mix.expression))
        return t
    }
    p.notes = p.notes.filter { trackIds.contains($0.trackId) && $0.tick >= 0 && $0.duration >= 1 && (0...127).contains($0.pitch) && (1...127).contains($0.velocity) }
    p.ccs = p.ccs.filter { trackIds.contains($0.trackId) && $0.tick >= 0 && (0...127).contains($0.controller) && (0...127).contains($0.value) }
    p.pitchBends = p.pitchBends.filter { trackIds.contains($0.trackId) && $0.tick >= 0 && (0...16383).contains($0.value) }
    p.channelPressure = p.channelPressure.filter { trackIds.contains($0.trackId) && $0.tick >= 0 }
    p.polyPressure = p.polyPressure.filter { trackIds.contains($0.trackId) && $0.tick >= 0 }
    p.programs = p.programs.filter { trackIds.contains($0.trackId) && $0.tick >= 0 && (0...127).contains($0.program) }
    p.tempos = p.tempos.filter { $0.tick >= 0 && (100_000...8_000_000).contains($0.microPerQuarter) }
    if p.tempos.isEmpty || p.tempos.first?.tick != 0 { p.tempos.insert(TempoEvent(tick: 0, microPerQuarter: 500000), at: 0) }
    p.tempos.sort { $0.tick < $1.tick }
    p.timeSigs = p.timeSigs.filter { $0.tick >= 0 && (1...32).contains($0.numerator) && [1, 2, 4, 8, 16, 32].contains($0.denominator) }
    if p.timeSigs.isEmpty || p.timeSigs.first?.tick != 0 { p.timeSigs.insert(TimeSigEvent(tick: 0, numerator: 4, denominator: 4), at: 0) }
    p.timeSigs.sort { $0.tick < $1.tick }
    p.raw = [] // raw bytes never cross the share boundary
    p.endTick = computeEndTick(p)
    return p
}
