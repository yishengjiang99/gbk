import Foundation

/// Native port of src/music/compose.ts: seeded rule-based composition strategies and
/// primitives over MNote lines. Random-stream consumption order mirrors the TS originals.

struct InstrumentSpec: Equatable, Sendable {
    var name: String; var program: Int; var lo: Int; var hi: Int
    var role: String   // melody | harmony | bass | accompaniment | percussion | counterpoint
    var family: String // strings | keys | winds | brass | plucked | drums | voice
    var pan: Int
}

let instrumentTable: [String: InstrumentSpec] = [
    "violin": InstrumentSpec(name: "Violin", program: 40, lo: 55, hi: 96, role: "melody", family: "strings", pan: 40),
    "viola": InstrumentSpec(name: "Viola", program: 41, lo: 48, hi: 84, role: "harmony", family: "strings", pan: 56),
    "cello": InstrumentSpec(name: "Cello", program: 42, lo: 36, hi: 72, role: "bass", family: "strings", pan: 84),
    "contrabass": InstrumentSpec(name: "Contrabass", program: 43, lo: 28, hi: 60, role: "bass", family: "strings", pan: 72),
    "strings": InstrumentSpec(name: "Strings", program: 48, lo: 36, hi: 96, role: "harmony", family: "strings", pan: 64),
    "harpsichord": InstrumentSpec(name: "Harpsichord", program: 6, lo: 29, hi: 89, role: "accompaniment", family: "keys", pan: 64),
    "piano": InstrumentSpec(name: "Piano", program: 0, lo: 21, hi: 108, role: "accompaniment", family: "keys", pan: 64),
    "organ": InstrumentSpec(name: "Organ", program: 19, lo: 36, hi: 96, role: "accompaniment", family: "keys", pan: 64),
    "flute": InstrumentSpec(name: "Flute", program: 73, lo: 60, hi: 96, role: "melody", family: "winds", pan: 52),
    "oboe": InstrumentSpec(name: "Oboe", program: 68, lo: 58, hi: 91, role: "melody", family: "winds", pan: 58),
    "clarinet": InstrumentSpec(name: "Clarinet", program: 71, lo: 50, hi: 91, role: "harmony", family: "winds", pan: 70),
    "bassoon": InstrumentSpec(name: "Bassoon", program: 70, lo: 34, hi: 72, role: "bass", family: "winds", pan: 76),
    "horn": InstrumentSpec(name: "Horn", program: 60, lo: 41, hi: 77, role: "harmony", family: "brass", pan: 70),
    "trumpet": InstrumentSpec(name: "Trumpet", program: 56, lo: 55, hi: 82, role: "melody", family: "brass", pan: 60),
    "guitar": InstrumentSpec(name: "Guitar", program: 24, lo: 40, hi: 84, role: "accompaniment", family: "plucked", pan: 50),
    "bass": InstrumentSpec(name: "Bass", program: 32, lo: 28, hi: 55, role: "bass", family: "plucked", pan: 64),
    "choir": InstrumentSpec(name: "Choir", program: 52, lo: 48, hi: 81, role: "harmony", family: "voice", pan: 64),
    "drums": InstrumentSpec(name: "Drums", program: 0, lo: 35, hi: 81, role: "percussion", family: "drums", pan: 64),
]

func instrumentSpec(_ name: String) -> InstrumentSpec {
    var k = name.lowercased()
    if k.hasSuffix("s") { k = String(k.dropLast()) }
    k = k.filter { $0.isASCII && ($0.asciiValue ?? 0) >= 97 && ($0.asciiValue ?? 0) <= 122 }
    if let s = instrumentTable[k] { return s }
    if let s = instrumentTable[name.lowercased()] { return s }
    return InstrumentSpec(name: name, program: 0, lo: 36, hi: 96, role: "harmony", family: "keys", pan: 64)
}

// MARK: - Harmony

private let degMajor = [0, 2, 4, 5, 7, 9, 11], degMinor = [0, 2, 3, 5, 7, 8, 10]

/// Diatonic triad (pitch classes) on scale degree 1..7; minor-key V and vii use the raised leading tone.
func triadPcs(key: KeyInfo, degree: Int) -> [Int] {
    let sc = key.mode == "major" ? degMajor : degMinor
    let d = (degree - 1) % 7
    var pcs = [0, 2, 4].map { (key.tonic + sc[(d + $0) % 7]) % 12 }
    if key.mode == "minor" && (degree == 5 || degree == 7) {
        let lt = (key.tonic + 11) % 12, sub = (key.tonic + 10) % 12
        pcs = pcs.map { $0 == sub ? lt : $0 }
    }
    return pcs
}

private let progressionPool: [String: [[Int]]] = [
    "baroque": [[1, 4, 5, 1], [1, 6, 2, 5], [1, 4, 7, 3], [6, 2, 5, 1]],
    "classical": [[1, 4, 5, 1], [1, 2, 5, 1], [1, 6, 4, 5], [4, 5, 3, 6]],
    "pop": [[1, 5, 6, 4], [6, 4, 1, 5], [1, 6, 4, 5], [4, 1, 5, 6]],
    "jazz": [[2, 5, 1, 6], [1, 6, 2, 5], [3, 6, 2, 5]],
]

func chordProgression(bars: Int, style: String, r: Rand, cadenceBars: Set<Int> = []) -> [Int] {
    let pool = progressionPool[style] ?? progressionPool["classical"]!
    var out: [Int] = []
    var b = 0
    while b < bars { out += pool[Int(r() * Double(pool.count))]; b += 4 }
    out = Array(out.prefix(bars))
    for cb in cadenceBars where cb >= 1 && cb < bars { out[cb - 1] = 5; out[cb] = 1 }
    if bars >= 2 { out[bars - 2] = 5; out[bars - 1] = 1 }
    return out
}

/// Nearest pitch to target within [lo, hi] whose pc is in pcs (target itself when none).
func nearPitch(_ pcs: [Int], target: Int, lo: Int, hi: Int) -> Int {
    var best = target, bd = Int.max
    for p in lo...hi where pcs.contains(pcNorm(p)) && abs(p - target) < bd { bd = abs(p - target); best = p }
    return best
}

struct BarGrid: Equatable, Sendable { var tick: Int; var length: Int; var beats: Int; var beatTicks: Int }

/// JS template-printing of a beat count: integers without a decimal point.
func fmtBeat(_ x: Double) -> String { x == x.rounded() ? String(Int(x)) : String(x) }

// MARK: - Line generators

func composeMelody(grid: [BarGrid], chords: [Int], key: KeyInfo, lo: Int, hi: Int, r: Rand, density: Int = 2) -> [MNote] {
    let sc = scalePcs(tonic: key.tonic, mode: key.mode)
    var out: [MNote] = []
    var prev = jsRound(Double(lo + hi) / 2)
    for (bi, g) in grid.enumerated() {
        let ch = triadPcs(key: key, degree: chords[bi])
        let step = g.beatTicks / density
        let phrasePos = Double(bi % 4) / 3
        let contour = jsRound(sin(phrasePos * Double.pi) * 5)
        var t = 0
        while t < g.length {
            defer { t += step }
            let strong = jsMod(t, g.beatTicks) == 0
            if !strong && r() < 0.25 { continue }
            let target = prev + (r() < 0.5 ? -2 : 2) + jsRound((Double(contour) - (Double(prev) - Double(lo + hi) / 2) / 4) * 0.3)
            var p = strong ? nearPitch(ch, target: target, lo: lo, hi: hi) : nearPitch(sc, target: target, lo: lo, hi: hi)
            if p == prev && r() < 0.7 { p = nearPitch(sc, target: p + (r() < 0.5 ? 1 : -1) * 2, lo: lo, hi: hi) }
            out.append(MNote(tick: g.tick + t, duration: step, pitch: p, velocity: strong ? 84 : 72))
            prev = p
        }
    }
    if out.count > 1 { for i in 0..<(out.count - 1) { out[i].duration = min(out[i + 1].tick - out[i].tick, out[i].duration * 2) } }
    return out
}

func composeBassLine(grid: [BarGrid], chords: [Int], key: KeyInfo, lo: Int, hi: Int, r: Rand, pattern: String = "root-fifth") -> [MNote] {
    var out: [MNote] = []
    var prev = jsRound(Double(lo) + Double(hi - lo) * 0.35)
    let sc = scalePcs(tonic: key.tonic, mode: key.mode)
    for (bi, g) in grid.enumerated() {
        let ch = triadPcs(key: key, degree: chords[bi])
        let nextRoot = triadPcs(key: key, degree: chords[min(bi + 1, chords.count - 1)])[0]
        for b in 0..<g.beats {
            var pc: [Int]
            if pattern == "roots" || b == 0 { pc = [ch[0]] }
            else if pattern == "root-fifth" { pc = b % 2 == 1 ? [ch[2]] : [ch[0]] }
            else { pc = b == g.beats - 1 ? [(nextRoot + 11) % 12, (nextRoot + 1) % 12, (nextRoot + 2) % 12].filter { sc.contains($0) } : ch }
            if pc.isEmpty { pc = [ch[0]] }
            let p = nearPitch(pc, target: prev + (r() < 0.5 ? -1 : 1), lo: lo, hi: hi)
            out.append(MNote(tick: g.tick + b * g.beatTicks, duration: g.beatTicks, pitch: p, velocity: b == 0 ? 88 : 76))
            prev = p
        }
    }
    return out
}

func composeAccompaniment(grid: [BarGrid], chords: [Int], key: KeyInfo, lo: Int, hi: Int, r: Rand, style: String = "block") -> [MNote] {
    var out: [MNote] = []
    var center = jsRound(Double(lo + hi) / 2)
    for (bi, g) in grid.enumerated() {
        let pcs = triadPcs(key: key, degree: chords[bi])
        let voicing = pcs.map { nearPitch([$0], target: center, lo: lo, hi: hi) }.sorted()
        center = voicing[1]
        if style == "block" {
            let hits = (g.beats % 3 == 0 ? [0, 3] : [0, 2]).filter { $0 < g.beats }
            for (i, b) in hits.enumerated() {
                let dur = jsRound(Double(g.beatTicks) * Double(i == hits.count - 1 ? g.beats - b : hits[i + 1] - b) * 0.92)
                for p in voicing { out.append(MNote(tick: g.tick + b * g.beatTicks, duration: dur, pitch: p, velocity: b == 0 ? 70 : 62)) }
            }
        } else {
            let order = style == "alberti" ? [0, 2, 1, 2] : [0, 1, 2, 1]
            let step = g.beatTicks / 2
            var k = 0
            while k * step < g.length {
                out.append(MNote(tick: g.tick + k * step, duration: step, pitch: voicing[order[k % 4]], velocity: k % 2 == 1 ? 58 : 66))
                k += 1
            }
        }
    }
    _ = r
    return out
}

/// GM drum grid: kick 36, snare 38, closed hat 42, open hat 46, crash 49.
func composeDrumPattern(grid: [BarGrid], r: Rand, style: String = "pop", energy: (Int) -> Double = { _ in 0.6 }) -> [MNote] {
    var out: [MNote] = []
    for (bi, g) in grid.enumerated() {
        let e = energy(bi)
        let sub = g.beatTicks / 2
        for k in 0..<(g.beats * 2) {
            let t = g.tick + k * sub
            let beat = Double(k) / 2
            if k % 2 == 0 && (beat == 0 || (style != "waltz" && beat == Double(g.beats / 2) && style == "rock")) {
                out.append(MNote(tick: t, duration: sub, pitch: 36, velocity: 100))
            }
            if style != "waltz" && k % 2 == 0 && Int(beat) % 2 == 1 {
                out.append(MNote(tick: t, duration: sub, pitch: 38, velocity: 92))
            }
            if style == "waltz" && k % 2 == 0 && beat > 0 {
                out.append(MNote(tick: t, duration: sub, pitch: 42, velocity: 70))
            }
            if style != "waltz" && (e > 0.4 || k % 2 == 0) {
                out.append(MNote(tick: t, duration: sub, pitch: e > 0.85 && k % 4 == 3 ? 46 : 42, velocity: k % 2 == 1 ? 58 : 74))
            }
            if k == 1 && r() < 0.15 * e {
                out.append(MNote(tick: t, duration: sub, pitch: 36, velocity: 80))
            }
        }
        if bi % 8 == 0 && e > 0.5 { out.append(MNote(tick: g.tick, duration: g.beatTicks * 2, pitch: 49, velocity: 96)) }
    }
    return out
}

// MARK: - Transforms

func quantizeNotes(_ ns: [MNote], grid: Int, strength: Double = 1) -> [MNote] {
    ns.map { n in
        let q = jsRound(Double(n.tick) / Double(grid)) * grid
        let qd = jsRound(Double(n.duration) / Double(grid)) * grid
        return MNote(tick: jsRound(Double(n.tick) + Double(q - n.tick) * strength),
                     duration: max(1, qd != 0 ? qd : grid), pitch: n.pitch, velocity: n.velocity)
    }
}
func humanizeNotes(_ ns: [MNote], r: Rand, velocity: Int = 6, timing: Int = 0) -> [MNote] {
    ns.map { n in
        // TS evaluates the velocity jitter's r() before the tick jitter's; keep that order.
        let vel = max(1, min(127, jsRound(Double(n.velocity) + (r() * 2 - 1) * Double(velocity))))
        let tick = max(0, n.tick + jsRound((r() * 2 - 1) * Double(timing)))
        return MNote(tick: tick, duration: n.duration, pitch: n.pitch, velocity: vel)
    }
}
func articulateNotes(_ ns: [MNote], kind: String) -> [MNote] {
    let factors: [String: Double] = ["legato": 1.02, "detache": 0.88, "staccato": 0.45, "tenuto": 1.0, "marcato": 0.75]
    let f = factors[kind] ?? 1
    let accent = kind == "marcato" ? 12 : 0
    return ns.map { MNote(tick: $0.tick, duration: max(1, jsRound(Double($0.duration) * f)), pitch: $0.pitch, velocity: min(127, $0.velocity + accent)) }
}
func phraseDynamics(_ ns: [MNote], phraseTicks: Int, depth: Double = 14, start: Int = 0) -> [MNote] {
    ns.map { n in
        let x = Double(jsMod(n.tick - start, phraseTicks)) / Double(phraseTicks)
        let arc = x < 0.6 ? x / 0.6 : (1 - x) / 0.4
        return MNote(tick: n.tick, duration: n.duration, pitch: n.pitch,
                     velocity: max(1, min(127, jsRound(Double(n.velocity) - depth / 2 + arc * depth))))
    }
}
func variationNotes(_ ns: [MNote], key: KeyInfo, r: Rand, kind: String = "ornament") -> [MNote] {
    let sc = scalePcs(tonic: key.tonic, mode: key.mode)
    func up(_ p: Int) -> Int { for k in 1..<4 where sc.contains(pcNorm(p + k)) { return p + k }; return p + 2 }
    if kind == "inversion" && !ns.isEmpty {
        return invertNotes(ns, axis: ns[0].pitch).map { var n = $0; n.pitch = nearPitch(sc, target: n.pitch, lo: n.pitch - 1, hi: n.pitch + 1); return n }
    }
    var out: [MNote] = []
    for n in ns {
        if kind == "diminution" && n.duration >= 480 && r() < 0.7 {
            let h = jsRound(Double(n.duration) / 2)
            out.append(MNote(tick: n.tick, duration: h, pitch: n.pitch, velocity: n.velocity))
            out.append(MNote(tick: n.tick + h, duration: n.duration - h, pitch: up(n.pitch), velocity: n.velocity))
        } else if kind == "ornament" && n.duration >= 240 && r() < 0.35 {
            let q = jsRound(Double(n.duration) / 4)
            out.append(MNote(tick: n.tick, duration: q, pitch: n.pitch, velocity: n.velocity))
            out.append(MNote(tick: n.tick + q, duration: q, pitch: up(n.pitch), velocity: n.velocity - 8))
            out.append(MNote(tick: n.tick + 2 * q, duration: n.duration - 2 * q, pitch: n.pitch, velocity: n.velocity))
        } else { out.append(n) }
    }
    return out
}

// MARK: - Quality metrics

func voiceMetrics(_ voices: [[MNote]]) -> (parallelPerfects: Int, voiceCrossings: Int, repeatedNoteRatio: Double) {
    var crossings = 0, parallels = 0, repeated = 0, total = 0
    if voices.count > 1 {
        for i in 0..<(voices.count - 1) {
            parallels += parallelPerfects(upper: voices[i], lower: voices[i + 1]).count
            let lower = voices[i + 1]
            for n in voices[i] {
                if let l = lower.first(where: { $0.tick <= n.tick && $0.tick + $0.duration > n.tick }), l.pitch > n.pitch { crossings += 1 }
            }
        }
    }
    for v in voices where v.count > 1 { for i in 1..<v.count { total += 1; if v[i].pitch == v[i - 1].pitch { repeated += 1 } } }
    return (parallels, crossings, total > 0 ? (Double(repeated) / Double(total)).rounded(3) : 0)
}

// MARK: - Baroque strategy (Bach generator) + continuo

private let bachMinorKeys = ["A minor", "E minor", "D minor", "G minor"]
private let bachMajorKeys = ["C", "G", "D", "A", "E", "F", "Bb", "Eb"]
private let bachKeyPc: [String: Int] = ["C": 0, "G": 7, "D": 2, "A": 9, "E": 4, "F": 5, "Bb": 10, "Eb": 3, "A minor": 9, "E minor": 4, "D minor": 2, "G minor": 7]

func baroqueVoices(key: KeyInfo, totalTicks: Int, ppq: Int, voices: Int, complexity: Int, seed: Int) -> (lines: [[MNote]], analysis: [String]) {
    let pool = key.mode == "minor" ? bachMinorKeys : bachMajorKeys
    var src = pool[0], bestD = 99
    for k in pool {
        let d = min(pcNorm(bachKeyPc[k]! - key.tonic), pcNorm(key.tonic - bachKeyPc[k]!))
        if d < bestD { bestD = d; src = k }
    }
    var shift = pcNorm(key.tonic - bachKeyPc[src]!)
    if shift > 6 { shift -= 12 }
    let g = generateBachMidi(key: src, length: "short", voices: voices, complexity: complexity, tempo: 100, seed: seed, attempts: 1)
    let piece = g.piece
    let spanBeats = piece.notes.map { $0.startBeat + $0.durBeat }.max() ?? 0
    func toNotes(beatOffset: Double, semis: Int, fromBeat: Double = 0) -> [(voice: Int, note: MNote)] {
        piece.notes.filter { $0.startBeat >= fromBeat }.map { n in
            let tick: Int = jsRound((n.startBeat - fromBeat + beatOffset) * Double(ppq))
            let duration: Int = max(1, jsRound(n.durBeat * Double(ppq)))
            let note = MNote(tick: tick, duration: duration, pitch: n.midi + shift + semis, velocity: 80)
            return (voice: n.voice, note: note)
        }
    }
    var all: [(voice: Int, note: MNote)] = []
    let plan = key.mode == "minor" ? [0, 3, 7, -2] : [0, 7, -3, 5]
    var analysis = ["fugue material: GBK Bach generator, seed \(seed), \(voices) voices, generated in \(src) and transposed \(shift >= 0 ? "+" : "")\(shift)"]
    let totalBeats = Double(totalTicks) / Double(ppq)
    if spanBeats >= totalBeats {
        all += toNotes(beatOffset: 0, semis: 0, fromBeat: spanBeats - totalBeats)
    } else {
        var beat = 0.0, k = 0
        while totalBeats - beat > spanBeats {
            let s = plan[k % plan.count]
            all += toNotes(beatOffset: beat, semis: s).filter { $0.note.tick < totalTicks }
            analysis.append("statement \(k + 1) at beat \(fmtBeat(beat)) transposed \(s >= 0 ? "+" : "")\(s)")
            beat += spanBeats; k += 1
            if k > 64 { break }
        }
        let rem = totalBeats - beat
        all += toNotes(beatOffset: beat, semis: 0, fromBeat: spanBeats - rem)
        analysis.append("closing statement: final \(fmtBeat(rem)) beats of the fugue (its cadence) aligned to the last bar")
    }
    var lines: [[MNote]] = Array(repeating: [], count: voices)
    for (v, n) in all where n.tick >= 0 && n.tick < totalTicks {
        lines[v].append(MNote(tick: n.tick, duration: min(n.duration, totalTicks - n.tick), pitch: n.pitch, velocity: n.velocity))
    }
    for i in lines.indices { lines[i].sort { $0.tick < $1.tick } }
    func avg(_ ns: [MNote]) -> Double { ns.isEmpty ? 0 : Double(ns.reduce(0) { $0 + $1.pitch }) / Double(ns.count) }
    lines.sort { avg($0) > avg($1) }
    return (lines, analysis)
}

/// Shift a whole line by octaves so its median sits inside [lo, hi], then fold outliers by octave.
func placeInRange(_ ns: [MNote], lo: Int, hi: Int) -> [MNote] {
    if ns.isEmpty { return ns }
    let med = ns.map { $0.pitch }.sorted()[ns.count >> 1]
    let mid = Double(lo + hi) / 2
    let oct = jsRound((mid - Double(med)) / 12) * 12
    return fitRangeNotes(transposeNotes(ns, oct), lo: lo, hi: hi)
}

/// Continuo realization: a close-position chord per half bar from the pitch classes sounding in the lines.
func continuo(lines: [[MNote]], grid: [BarGrid], key: KeyInfo, lo: Int, hi: Int) -> [MNote] {
    var out: [MNote] = []
    var center = jsRound(Double(lo + hi) / 2)
    func sounding(_ t: Int) -> [Int] { lines.flatMap { l in l.filter { $0.tick <= t && $0.tick + $0.duration > t }.map { $0.pitch } } }
    for g in grid {
        let halves = g.beats % 3 == 0 && g.beats > 3 ? 2 : g.beats >= 4 ? 2 : 1
        let hl = jsRound(Double(g.length) / Double(halves))
        for h in 0..<halves {
            let t = g.tick + h * hl
            let ps = sounding(t + 1)
            let bass = ps.min()
            var pcs: [Int] = []
            for p in ps { let pc = pcNorm(p); if !pcs.contains(pc) { pcs.append(pc) } }
            if pcs.count < 2, let bass {
                var deg0 = 1 + ([0, 2, 4, 5, 7, 9, 11].firstIndex(of: pcNorm(bass - key.tonic)) ?? -1)
                if deg0 == 0 { deg0 = 1 }
                pcs = triadPcs(key: key, degree: deg0)
            }
            if pcs.isEmpty { continue }
            let chord = pcs.prefix(3).map { nearPitch([$0], target: center, lo: lo, hi: hi) }.sorted()
            center = chord[chord.count / 2]
            for p in Array(Set(chord)).sorted() { out.append(MNote(tick: t, duration: jsRound(Double(hl) * 0.9), pitch: p, velocity: h == 0 ? 68 : 60)) }
        }
    }
    return out
}
