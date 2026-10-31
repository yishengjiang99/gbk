import Foundation

/// Native port of src/music/theory.ts (+ KeyInfo/parseKey from src/music/keys.ts).
/// Deterministic music utilities; RNG and rounding mirror the JS originals bit-for-bit
/// (mulberry32 over UInt32, Math.round = floor(x + 0.5), JS remainder semantics).

struct MNote: Equatable, Sendable { var tick: Int; var duration: Int; var pitch: Int; var velocity: Int }

struct KeyInfo: Equatable, Sendable { var label: String; var tonic: Int; var mode: String; var sf: Int } // mode: "major" | "minor"

func jsRound(_ x: Double) -> Int { Int(floor(x + 0.5)) }
func jsMod(_ a: Int, _ b: Int) -> Int { a % b } // Swift % is already JS-style remainder for Int
func pcNorm(_ p: Int) -> Int { ((p % 12) + 12) % 12 }

private let keyPC: [String: Int] = ["C": 0, "B#": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "Fb": 4, "F": 5, "E#": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11, "Cb": 11]
private let keyMajorSF: [Int: Int] = [0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1]

/// "C minor", "Eb major", "f# minor", "Bb" (major), "Am" -> KeyInfo. Throws like the TS parseKey.
func parseKeyInfo(_ s: String) throws -> KeyInfo {
    let str = s.trimmingCharacters(in: .whitespaces)
    func bad() -> ToolArgError { ToolArgError("INVALID_ARGUMENT", "unrecognized key \(String(describing: String(s.prefix(40)))); use e.g. \"C minor\" or \"Eb major\"") }
    guard let first = str.first, "ABCDEFGabcdefg".contains(first) else { throw bad() }
    var rest = str.dropFirst()
    while rest.first == " " { rest = rest.dropFirst() }
    var accidental = ""
    if let a = rest.first, "#b♯♭B".contains(a) {
        accidental = a == "♯" ? "#" : a == "♭" ? "b" : String(a)
        rest = rest.dropFirst()
    }
    let tail = rest.trimmingCharacters(in: .whitespaces).lowercased()
    guard tail.isEmpty || ["major", "minor", "maj", "min", "m"].contains(tail) else { throw bad() }
    let name = first.uppercased() + accidental
    guard let tonic = keyPC[name] else { throw ToolArgError("INVALID_ARGUMENT", "unknown tonic \(name)") }
    let mode = (tail == "minor" || tail == "min" || tail == "m") ? "minor" : "major"
    let sf = keyMajorSF[mode == "minor" ? (tonic + 3) % 12 : tonic] ?? 0
    return KeyInfo(label: "\(name) \(mode)", tonic: tonic, mode: mode, sf: sf)
}

// MARK: - Seeded PRNG (mulberry32, identical stream to the TS original)

final class SeededRNG: @unchecked Sendable {
    private var state: UInt32
    init(seed: Int) { state = UInt32(bitPattern: Int32(truncatingIfNeeded: seed)) }
    func next() -> Double {
        state &+= 0x6D2B79F5
        var t = state
        t = (t ^ (t >> 15)) &* (t | 1)
        t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
        return Double(t ^ (t >> 14)) / 4294967296.0
    }
}
func seededRNG(_ seed: Int) -> SeededRNG { SeededRNG(seed: seed) }
typealias Rand = () -> Double

// MARK: - Transforms (theory.ts)

func transposeNotes(_ ns: [MNote], _ semis: Int) -> [MNote] { ns.map { MNote(tick: $0.tick, duration: $0.duration, pitch: $0.pitch + semis, velocity: $0.velocity) } }
func invertNotes(_ ns: [MNote], axis: Int) -> [MNote] { ns.map { MNote(tick: $0.tick, duration: $0.duration, pitch: 2 * axis - $0.pitch, velocity: $0.velocity) } }
func retrogradeNotes(_ ns: [MNote]) -> [MNote] {
    if ns.isEmpty { return [] }
    let start = ns.map { $0.tick }.min()!, end = ns.map { $0.tick + $0.duration }.max()!
    return ns.map { MNote(tick: start + (end - ($0.tick + $0.duration)), duration: $0.duration, pitch: $0.pitch, velocity: $0.velocity) }
        .sorted { $0.tick < $1.tick }
}
func scaleTimeNotes(_ ns: [MNote], factor: Double, origin: Int? = nil) -> [MNote] {
    let o = origin ?? ns.first?.tick ?? 0
    return ns.map { MNote(tick: jsRound(Double(o) + Double($0.tick - o) * factor), duration: max(1, jsRound(Double($0.duration) * factor)), pitch: $0.pitch, velocity: $0.velocity) }
}
func sequenceNotes(_ ns: [MNote], times: Int, tickOffset: Int, semis: Int) -> [MNote] {
    var out: [MNote] = []
    for k in 0..<times { out += ns.map { MNote(tick: $0.tick + k * tickOffset, duration: $0.duration, pitch: $0.pitch + k * semis, velocity: $0.velocity) } }
    return out
}
func fitRangeNotes(_ ns: [MNote], lo: Int, hi: Int) -> [MNote] {
    ns.map { n in
        var p = n.pitch
        while p < lo { p += 12 }
        while p > hi { p -= 12 }
        return MNote(tick: n.tick, duration: n.duration, pitch: max(lo, min(hi, p)), velocity: n.velocity)
    }
}

enum VoiceMotion: String { case parallel, similar, contrary, oblique, static_ = "static" }
func voiceMotion(_ a1: Int, _ a2: Int, _ b1: Int, _ b2: Int) -> VoiceMotion {
    let da = a2 - a1, db = b2 - b1
    if da == 0 && db == 0 { return .static_ }
    if da == 0 || db == 0 { return .oblique }
    if (da > 0) != (db > 0) { return .contrary }
    return (a2 - b2) == (a1 - b1) ? .parallel : .similar
}
private let perfectIntervals: Set<Int> = [0, 7]
/// Parallel perfect 5ths/octaves between two voices sampled at shared onsets (JS % semantics kept).
func parallelPerfects(upper: [MNote], lower: [MNote]) -> [(tick: Int, interval: String)] {
    func at(_ ns: [MNote], _ t: Int) -> Int? { ns.first { $0.tick <= t && $0.tick + $0.duration > t }?.pitch }
    let ticks = Array(Set(upper.map { $0.tick } + lower.map { $0.tick })).sorted()
    var out: [(tick: Int, interval: String)] = []
    guard ticks.count > 1 else { return out }
    for i in 1..<ticks.count {
        guard let a1 = at(upper, ticks[i - 1]), let a2 = at(upper, ticks[i]),
              let b1 = at(lower, ticks[i - 1]), let b2 = at(lower, ticks[i]) else { continue }
        let i1 = jsMod(a1 - b1, 12), i2 = jsMod(a2 - b2, 12)
        if perfectIntervals.contains(i1) && i1 == i2 && a1 != a2 && voiceMotion(a1, a2, b1, b2) != .contrary {
            out.append((ticks[i], i2 == 7 ? "P5" : "P8"))
        }
    }
    return out
}

// MARK: - Chord / key estimation

let pcNamesSharp = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]

func estimateChord(pcs: [Int]) -> (root: Int, rootName: String, quality: String, label: String)? {
    let set = Set(pcs.map(pcNorm))
    if set.count < 2 { return nil }
    let templates: [(String, [Int])] = [
        ("major", [0, 4, 7]), ("minor", [0, 3, 7]), ("diminished", [0, 3, 6]), ("augmented", [0, 4, 8]),
        ("dominant 7th", [0, 4, 7, 10]), ("major 7th", [0, 4, 7, 11]), ("minor 7th", [0, 3, 7, 10]),
        ("suspended 4th", [0, 5, 7]), ("suspended 2nd", [0, 2, 7]), ("power", [0, 7]),
    ]
    var best: (root: Int, quality: String, score: Double)? = nil
    for root in 0..<12 { for t in templates {
        let tones = Set(t.1.map { (root + $0) % 12 })
        var hit = 0; for pc in set where tones.contains(pc) { hit += 1 }
        if hit < 3 && hit < tones.count { continue }
        let score = Double(hit * 2) - Double(set.count - hit) - Double(tones.count - hit) * 0.5
        if best == nil || score > best!.score { best = (root, t.0, score) }
    } }
    guard let b = best else { return nil }
    return (b.root, pcNamesSharp[b.root], b.quality, "\(pcNamesSharp[b.root]) \(b.quality)")
}

func restingAnchor(_ ns: [MNote], tonic: Int, mode: String) -> Double {
    if ns.isEmpty { return 0 }
    let durs = ns.map { $0.duration }.sorted()
    let med = durs[durs.count / 2]
    let endMax = ns.map { $0.tick + $0.duration }.max()!
    let fin = ns.filter { $0.tick + $0.duration == endMax }.sorted { $0.pitch < $1.pitch }.first
    var tones: [(pc: Int, w: Int)] = []
    if med > 0 { for n in ns where n.duration >= 2 * med { tones.append((pcNorm(n.pitch), n.duration)) } }
    if let fin { tones.append((pcNorm(fin.pitch), fin.duration * 2)) }
    if tones.isEmpty { return 0 }
    func stab(_ rel: Int) -> Double {
        if rel == 0 { return 1 }
        if rel == 7 { return 0.7 }
        if rel == (mode == "major" ? 4 : 3) { return 0.7 }
        if rel == 11 { return -0.5 }
        if [2, 5, 8, 9, 10].contains(rel) { return 0.25 }
        return 0
    }
    let tw = Double(tones.reduce(0) { $0 + $1.w })
    return tones.reduce(0.0) { $0 + Double($1.w) * stab(pcNorm($1.pc - tonic)) } / (tw == 0 ? 1 : tw)
}

private let ksMajor = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
private let ksMinor = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

struct KeyEstimate: Equatable, Sendable { var label: String; var tonic: Int; var mode: String; var confidence: Double; var method: String }

func estimateKey(_ ns: [MNote]) -> KeyEstimate {
    var h = [Double](repeating: 0, count: 12)
    for n in ns { h[pcNorm(n.pitch)] += Double(n.duration) }
    func corr(_ prof: [Double], _ r: Int) -> Double {
        let y = (0..<12).map { prof[($0 - r + 12) % 12] }
        let mx = h.reduce(0, +) / 12, my = y.reduce(0, +) / 12
        var num = 0.0, dx = 0.0, dy = 0.0
        for i in 0..<12 { num += (h[i] - mx) * (y[i] - my); dx += (h[i] - mx) * (h[i] - mx); dy += (y[i] - my) * (y[i] - my) }
        return (dx != 0 && dy != 0) ? num / sqrt(dx * dy) : 0
    }
    var best = (tonic: 0, mode: "major", r: -2.0, score: -Double.infinity)
    for t in 0..<12 { for (mode, prof) in [("major", ksMajor), ("minor", ksMinor)] {
        let r = corr(prof, t)
        let score = r + 0.3 * restingAnchor(ns, tonic: t, mode: mode)
        if score > best.score { best = (t, mode, r, score) }
    } }
    return KeyEstimate(label: "\(pcNamesSharp[best.tonic]) \(best.mode)", tonic: best.tonic, mode: best.mode,
                       confidence: (best.r * 1000).rounded() / 1000,
                       method: "heuristic: Krumhansl-Schmuckler profile correlation + resting-tone anchor")
}

func scalePcs(tonic: Int, mode: String) -> [Int] {
    let steps = mode == "major" ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10, 11]
    return steps.map { (tonic + $0) % 12 }
}

func analyzeNotes(_ ns: [MNote], ppq: Int, ticksPerBar: Int) -> JSONValue {
    let sorted = ns.sorted { ($0.tick, $0.pitch) < ($1.tick, $1.pitch) }
    var pcs = [Int](repeating: 0, count: 12)
    for n in sorted { pcs[pcNorm(n.pitch)] += 1 }
    let span = sorted.isEmpty ? 0 : sorted.map { $0.tick + $0.duration }.max()! - sorted[0].tick
    var top: [MNote] = []
    for n in sorted {
        if let l = top.last, l.tick == n.tick { if n.pitch > l.pitch { top[top.count - 1] = n } }
        else { top.append(n) }
    }
    var ints: [Int] = []
    if top.count > 1 { for i in 1..<top.count { ints.append(top[i].pitch - top[i - 1].pitch) } }
    var ih: [(String, Int)] = []
    var ihMap: [Int: Int] = [:]
    for i in ints { ihMap[i, default: 0] += 1 }
    for k in ihMap.keys { ih.append((String(k), ihMap[k]!)) }
    var motifs: [String: Int] = [:]
    if ints.count >= 3 { for i in 0...(ints.count - 3) { let k = ints[i..<(i + 3)].map(String.init).joined(separator: ","); motifs[k, default: 0] += 1 } }
    let motifList = motifs.filter { $0.value > 1 }.sorted { $0.value > $1.value }.prefix(8)
    let key = estimateKey(sorted)
    var histObj: [(String, JSONValue)] = []
    for (i, name) in pcNamesSharp.enumerated() { histObj.append((name, .int(Int64(pcs[i])))) }
    var ihObj: [(String, JSONValue)] = []
    for (k, v) in ih { ihObj.append((k, .int(Int64(v)))) }
    return .object([
        ("noteCount", .int(Int64(sorted.count))),
        ("pitchRange", sorted.isEmpty ? .null : .object([("low", .int(Int64(sorted.map { $0.pitch }.min()!))), ("high", .int(Int64(sorted.map { $0.pitch }.max()!)))])),
        ("pitchClassHistogram", .object(histObj)),
        ("key", .object([("label", .string(key.label)), ("tonic", .int(Int64(key.tonic))), ("mode", .string(key.mode)), ("confidence", .double(key.confidence)), ("method", .string(key.method))])),
        ("densityNotesPerBar", .double(span != 0 ? (Double(sorted.count) / (Double(span) / Double(ticksPerBar)) * 100).rounded() / 100 : 0)),
        ("averageDurationBeats", .double(sorted.isEmpty ? 0 : (sorted.reduce(0.0) { $0 + Double($1.duration) } / Double(sorted.count) / Double(ppq) * 1000).rounded() / 1000)),
        ("melodicIntervalHistogram", .object(ihObj)),
        ("recurringMotifs", .array(motifList.map { .object([("intervals", .array($0.key.split(separator: ",").map { .int(Int64(Int($0) ?? 0)) })), ("count", .int(Int64($0.value)))]) })),
    ])
}

func detectCadences(bass: [MNote], tonic: Int, ticksPerBar: Int) -> [(tick: Int, type: String)] {
    var out: [(tick: Int, type: String)] = []
    guard bass.count > 1 else { return out }
    for i in 1..<bass.count {
        let d = bass[i].pitch - bass[i - 1].pitch
        if (d == -7 || d == 5) && jsMod(bass[i].pitch, 12) == tonic && jsMod(bass[i].tick, ticksPerBar) == 0 {
            out.append((bass[i].tick, "authentic (heuristic)"))
        }
    }
    return out
}

// MARK: - Counterpoint (first/second/fourth-species flavored, deterministic per seed)

struct CounterpointOpts {
    var lo: Int; var hi: Int; var rhythm: Int // 1 | 2 | 3
    var seed: Int; var startTick: Int; var endTick: Int; var ppq: Int
    var velocity: Int?; var tonic: Int; var mode: String; var above: Bool?
}
private let consonantClasses: Set<Int> = [0, 3, 4, 7, 8, 9]

func counterpoint(cantus: [MNote], _ o: CounterpointOpts) -> (notes: [MNote], score: Double, issues: [String]) {
    let r = SeededRNG(seed: o.seed)
    let scale = scalePcs(tonic: o.tonic, mode: o.mode)
    func sounding(_ t: Int) -> [Int] { cantus.filter { $0.tick <= t && $0.tick + $0.duration > t }.map { $0.pitch } }
    let slot = o.rhythm == 1 ? o.ppq : o.rhythm == 2 ? o.ppq / 2 : o.ppq / 4
    var out: [MNote] = []
    var prev = jsRound(Double(o.lo + o.hi) / 2)
    var score = 0.0
    var issues: [String] = []
    var prevC: Int? = nil
    var t = o.startTick
    while t < o.endTick {
        defer { t += slot }
        let cs = sounding(t)
        let c: Int? = cs.isEmpty ? nil : (o.above == false ? cs.min()! : cs.max()!)
        let strong = jsMod(t - o.startTick, o.ppq) == 0
        var best: (p: Int, s: Double)? = nil
        for p in o.lo...o.hi {
            if !scale.contains(pcNorm(p)) { continue }
            var s = -Double(abs(p - prev)) * 0.6 + r.next() * 0.8
            if let c {
                let iv = abs(p - c) % 12
                if consonantClasses.contains(iv) { s += strong ? 4 : 1.5 } else { s -= strong ? 6 : 0.5 }
                if o.above != false ? p <= c : p >= c { s -= 3 }
                if let pc0 = prevC {
                    let m = voiceMotion(prev, p, pc0, c)
                    if m == .contrary { s += 1.5 } else if m == .oblique { s += 0.5 }
                    if perfectIntervals.contains(iv) && perfectIntervals.contains(abs(prev - pc0) % 12) && m != .contrary && p != prev { s -= 8 }
                }
            }
            if abs(p - prev) > 9 { s -= 4 }
            if best == nil || s > best!.s { best = (p, s) }
        }
        guard let b = best else { continue }
        score += b.s; prev = b.p; prevC = c
        if let last = out.last, last.pitch == b.p && o.rhythm == 1 && r.next() < 0.3 {
            out[out.count - 1].duration += slot
        } else {
            out.append(MNote(tick: t, duration: slot, pitch: b.p, velocity: o.velocity ?? 80))
        }
    }
    let par = parallelPerfects(upper: o.above == false ? cantus : out, lower: o.above == false ? out : cantus)
    if !par.isEmpty { issues.append("\(par.count) parallel perfect interval(s) at ticks \(par.prefix(5).map { String($0.tick) }.joined(separator: ", "))") }
    return (out, (score / Double(max(1, out.count)) - Double(par.count)).rounded(3), issues)
}

extension Double {
    func rounded(_ places: Int) -> Double { let f = pow(10.0, Double(places)); return (self * f).rounded() / f }
}
