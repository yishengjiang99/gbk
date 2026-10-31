import Foundation

/// Native port of src/bach-generator.ts: the seeded, rule-based Bach-style fugue generator.
/// RNG stream, candidate iteration order, and scoring mirror the TS original exactly, so a
/// given (key, length, voices, character, complexity, seed) produces the same piece.
/// TS note objects are shared by reference (groupByVoice/repairScore mutate in place);
/// the Swift port uses indices into the notes array wherever the original relies on that.

struct BachFugueConfig: Equatable, Sendable {
    var key: String = "C"               // BachKey
    var length: String = "medium"       // "short" | "medium" | "long"
    var voices: Int = 4                 // 3 | 4
    var character: String = "compact fugue"
    var complexity: Int = 3             // 1..5
    var tempo: Int = 92
    var seed: Int = 0
    var attempts: Int? = nil            // default 10
}
struct BachKeyContext: Equatable, Sendable { var key: String; var tonicPc: Int; var mode: String; var scale: [Int] }
struct FugueNote: Equatable, Sendable {
    var voice: Int; var midi: Int; var startBeat: Double; var durBeat: Double; var role: String; var section: String? = nil
}
struct HarmonicPlanMeasure: Equatable, Sendable { var measure: Int; var fn: String; var region: String } // fn: T | PD | D | CAD
struct FuguePar: Equatable, Sendable { var p5 = 0; var p8 = 0; var contrary = 0; var totalMotion = 0; var unisons = 0; var overlaps = 0 }
struct FugueScore: Equatable, Sendable { var score: Double; var par: FuguePar; var leaps: Int; var cad: Int; var harm: Double; var subj: Int }
struct BachPiece: Equatable, Sendable {
    var notes: [FugueNote]; var totalBeats: Double; var analysis: [String]
    var subject: [FugueNote]; var countersubject: [FugueNote]; var plan: [HarmonicPlanMeasure]
    var score: FugueScore; var ctx: BachKeyContext
}
struct GeneratedBachMidi { var midiData: Data; var fileName: String; var seed: Int; var piece: BachPiece; var config: BachFugueConfig }

let bachKeyOptions = ["C", "G", "D", "A", "E", "F", "Bb", "Eb", "A minor", "E minor", "D minor", "G minor"]
private let bachKeyToPc: [String: Int] = ["C": 0, "G": 7, "D": 2, "A": 9, "E": 4, "F": 5, "Bb": 10, "Eb": 3, "A minor": 9, "E minor": 4, "D minor": 2, "G minor": 7]
private let bachScales: [String: [Int]] = ["major": [0, 2, 4, 5, 7, 9, 11], "minor": [0, 2, 3, 5, 7, 8, 10]]
private let bachVoiceNames = ["Soprano", "Alto", "Tenor", "Bass"]

// MARK: - RNG (mulberry32 over a hashString seed, identical stream to TS)

final class BachRNG: @unchecked Sendable {
    private var state: UInt32
    init(seed: UInt32) { state = seed }
    func next() -> Double {
        state &+= 0x6D2B79F5
        var t = state
        t = (t ^ (t >> 15)) &* (t | 1)
        t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
        return Double(t ^ (t >> 14)) / 4294967296.0
    }
}
func bachHashString(_ s: String) -> UInt32 {
    var h: UInt32 = 1779033703 ^ UInt32(s.unicodeScalars.count)
    for ch in s.unicodeScalars {
        h = (h ^ ch.value) &* 3432918353
        h = (h &<< 13) | (h >> 19)
    }
    return h
}
private func bChoice<T>(_ r: BachRNG, _ arr: [T]) -> T { arr[Int(r.next() * Double(arr.count))] }
private func bCoin(_ r: BachRNG, _ p: Double = 0.5) -> Bool { r.next() < p }
private func clampI(_ x: Int, _ a: Int, _ b: Int) -> Int { max(a, min(b, x)) }
private func signum(_ x: Int) -> Int { x > 0 ? 1 : x < 0 ? -1 : 0 }
private func byStart(_ a: FugueNote, _ b: FugueNote) -> Bool {
    if a.startBeat != b.startBeat { return a.startBeat < b.startBeat }
    if a.voice != b.voice { return a.voice < b.voice }
    return a.midi < b.midi
}

// MARK: - Key context helpers

func bachKeyContext(_ key: String) -> BachKeyContext {
    let mode = key.contains("minor") ? "minor" : "major"
    return BachKeyContext(key: key, tonicPc: bachKeyToPc[key] ?? 0, mode: mode, scale: bachScales[mode]!)
}
private func degreePc(_ ctx: BachKeyContext, _ degree: Int) -> Int { (ctx.tonicPc + ctx.scale[(degree - 1) % 7]) % 12 }
private func scaleMidi(_ ctx: BachKeyContext, _ degree: Int, _ octave: Int) -> Int { 12 * (octave + 1) + degreePc(ctx, degree) }
private func nearestInScale(_ ctx: BachKeyContext, _ midi: Int) -> Int {
    var best = midi, bestDistance = 999
    for oct in -1...9 { for deg in 1...7 {
        let m = scaleMidi(ctx, deg, oct)
        let d = abs(m - midi)
        if d < bestDistance { bestDistance = d; best = m }
    } }
    return best
}
private func fitToScale(_ ctx: BachKeyContext, _ midi: Int) -> Int { nearestInScale(ctx, midi) }
private func chordPcsForFunction(_ ctx: BachKeyContext, _ fn: String) -> [Int] {
    let map: [String: [Int]] = ["T": [1, 3, 5], "PD": [2, 4, 6], "D": [5, 7, 2], "CAD": [5, 1]]
    return (map[fn] ?? [1, 3, 5]).map { degreePc(ctx, $0) }
}
private func isConsonant(_ semi: Int) -> Bool { [0, 3, 4, 7, 8, 9].contains(abs(semi) % 12) }
private func intervalClass(_ a: Int, _ b: Int) -> Int { abs(a - b) % 12 }

private func buildHarmonicPlan(_ ctx: BachKeyContext, length: String, character: String) -> [HarmonicPlanMeasure] {
    let measures = length == "short" ? 14 : length == "medium" ? 20 : 28
    var plan: [HarmonicPlanMeasure] = []
    for i in 0..<measures {
        var fn = "T", region = "tonic"
        if i >= 4 && i < 7 { fn = "D" }
        if i == 7 { fn = "CAD" }
        if i >= 8 && i < 11 { fn = ["T", "PD", "D"][i % 3]; region = ctx.mode == "major" ? "dominant" : "relative" }
        if i >= 11 && i < 14 { fn = ["PD", "D", "T"][i % 3]; region = "sequence" }
        if i >= 14 && i < measures - 4 { fn = ["T", "PD", "D", "T"][i % 4]; region = i % 6 < 3 ? "medial" : "modulatory" }
        if i >= measures - 4 { fn = i == measures - 1 ? "CAD" : i == measures - 2 ? "D" : "T"; region = "closing" }
        if character == "stretto-driven fugue" && i > measures - 6 { region = "stretto" }
        if character == "toccata + fugue hybrid" && i < 2 { region = "prelude" }
        plan.append(HarmonicPlanMeasure(measure: i, fn: fn, region: region))
    }
    return plan
}

// MARK: - Subject

private func generateSubject(_ ctx: BachKeyContext, _ rng: BachRNG, character: String, complexity: Int) -> (notes: [FugueNote], totalBeats: Double) {
    let rhythmBanks: [String: [[Double]]] = [
        "severe ricercar": [[1, 1, 1, 1, 1, 1], [2, 1, 1, 2, 2], [1, 0.5, 0.5, 1, 1, 2]],
        "compact fugue": [[1, 0.5, 0.5, 1, 1, 1, 1], [0.5, 0.5, 1, 1, 0.5, 0.5, 2, 1], [1, 1, 0.5, 0.5, 1, 2]],
        "lively fughetta": [[0.5, 0.5, 0.5, 0.5, 1, 1, 1, 1], [1, 0.5, 0.5, 0.5, 0.5, 1, 2], [0.5, 0.5, 1, 0.5, 0.5, 1, 1, 1]],
        "stretto-driven fugue": [[0.5, 0.5, 1, 0.5, 0.5, 1, 1, 1], [1, 0.5, 0.5, 1, 0.5, 0.5, 1, 1], [0.5, 0.5, 0.5, 0.5, 1, 1, 2]],
        "toccata + fugue hybrid": [[0.25, 0.25, 0.5, 0.5, 0.5, 0.5, 1, 1, 1], [0.5, 0.5, 0.5, 0.5, 1, 1, 1, 1], [1, 0.5, 0.5, 0.25, 0.25, 1, 2]],
    ]
    let contourBanks = [[0, 2, 4, 3, 5, 4, 2, 1], [0, 1, 3, 5, 4, 2, 3, 1], [0, 4, 3, 1, 2, 5, 4, 2], [0, -1, 2, 4, 3, 1, 2, 0], [0, 3, 2, 4, 6, 5, 3, 2]]
    var rhythm = bChoice(rng, rhythmBanks[character] ?? rhythmBanks["compact fugue"]!)
    while rhythm.count < 6 { rhythm.append(1) }
    let contour = bChoice(rng, contourBanks)
    let len = clampI(jsRound(6 + Double(complexity) + rng.next() * 3), 6, 12)
    let startDegree = bCoin(rng, 0.6) ? 1 : bChoice(rng, [3, 5])
    let startOct = ctx.mode == "major" ? 5 : 4
    let baseMidi = scaleMidi(ctx, startDegree, startOct)
    var last = baseMidi
    var notes: [FugueNote] = []
    var beat = 0.0
    for i in 0..<len {
        let dur = rhythm[i % rhythm.count]
        let target = baseMidi + contour[i % contour.count] + (bCoin(rng, 0.2) ? bChoice(rng, [-2, 2]) : 0)
        var midi = fitToScale(ctx, target)
        if abs(midi - last) > 8 { midi = fitToScale(ctx, last + signum(midi - last) * bChoice(rng, [2, 3, 4, 5])) }
        notes.append(FugueNote(voice: 0, midi: midi, startBeat: beat, durBeat: dur, role: "subject", section: "subject"))
        beat += dur
        last = midi
    }
    let li = notes.count - 1
    notes[li].midi = fitToScale(ctx, scaleMidi(ctx, bCoin(rng, 0.5) ? 5 : 2, notes[li].midi / 12 - 1))
    return (notes, beat)
}

private func transformSubject(_ subjectNotes: [FugueNote], transpose: Int = 0, invertAround: Int? = nil,
                              retrograde: Bool = false, augment: Double = 1, diminish: Double = 1,
                              tonalAdjust: Bool = false, ctx: BachKeyContext? = nil) -> [FugueNote] {
    var notes = subjectNotes
    if let axis = invertAround { notes = notes.map { var n = $0; n.midi = axis - (n.midi - axis); return n } }
    if retrograde {
        let lastN = notes[notes.count - 1]
        let total = lastN.startBeat + lastN.durBeat
        notes = notes.reversed().map { var n = $0; n.startBeat = total - (n.startBeat + n.durBeat); return n }
    }
    let factor = augment / diminish
    notes = notes.map { var n = $0; n.startBeat *= factor; n.durBeat *= factor; n.midi += transpose; return n }
    if tonalAdjust, let ctx {
        notes = notes.enumerated().map { (i, n0) in
            var n = n0
            var midi = n.midi
            let pc = pcNorm(midi)
            let dom = (ctx.tonicPc + 7) % 12
            if i < 3 && pc == (ctx.tonicPc + 7) % 12 { midi -= 1 }
            if pc == (dom + 5) % 12 { midi -= 1 }
            n.midi = fitToScale(ctx, midi)
            return n
        }
    } else if let ctx {
        notes = notes.map { var n = $0; n.midi = fitToScale(ctx, n.midi); return n }
    }
    return notes.sorted(by: byStart)
}

private func fragmentNotes(_ notes: [FugueNote], from: Double, to: Double) -> [FugueNote] {
    notes.filter { $0.startBeat >= from && $0.startBeat < to }.map { var n = $0; n.startBeat -= from; return n }
}

private func sequenceFragment(_ ctx: BachKeyContext, frag: [FugueNote], steps: Int, transposition: Int, durScale: Double) -> [FugueNote] {
    var out: [FugueNote] = []
    var beat = 0.0
    for i in 0..<steps {
        for n in frag {
            var m = n
            m.midi = fitToScale(ctx, n.midi + i * transposition)
            m.startBeat = beat + n.startBeat * durScale
            m.durBeat = n.durBeat * durScale
            m.role = "episode"
            out.append(m)
        }
        let fragDur = (frag.map { $0.startBeat + $0.durBeat }.max() ?? 0) * durScale
        beat += fragDur
    }
    return out
}

private func buildCountersubject(_ ctx: BachKeyContext, subject: [FugueNote], _ rng: BachRNG) -> [FugueNote] {
    var notes: [FugueNote] = []
    for s in subject {
        let dir = bCoin(rng, 0.5) ? -1 : 1
        let offset = bChoice(rng, [3, 4, 6, 8, 9])
        var midi = fitToScale(ctx, s.midi + dir * offset)
        if intervalClass(midi, s.midi) == 0 { midi = fitToScale(ctx, midi + dir * 2) }
        if s.durBeat >= 1 && bCoin(rng, 0.6) {
            notes.append(FugueNote(voice: 0, midi: midi, startBeat: s.startBeat, durBeat: s.durBeat / 2, role: "countersubject"))
            notes.append(FugueNote(voice: 0, midi: fitToScale(ctx, midi + dir * 2), startBeat: s.startBeat + s.durBeat / 2, durBeat: s.durBeat / 2, role: "countersubject"))
        } else {
            notes.append(FugueNote(voice: 0, midi: midi, startBeat: s.startBeat, durBeat: s.durBeat, role: "countersubject"))
        }
    }
    return notes.sorted(by: byStart)
}

// MARK: - Scoring (indices stand in for TS shared references)

/// Voice -> indices into `notes`, each sorted byStart (mirrors groupByVoice).
private func groupByVoiceIdx(_ notes: [FugueNote]) -> [Int: [Int]] {
    var g: [Int: [Int]] = [:]
    for (i, n) in notes.enumerated() { g[n.voice, default: []].append(i) }
    for k in g.keys { g[k] = g[k]!.sorted { byStart(notes[$0], notes[$1]) } }
    return g
}

private func expandTimeline(_ notes: [FugueNote], step: Double = 0.5) -> [(t: Double, pitches: [Int: Int])] {
    let end = max(notes.map { $0.startBeat + $0.durBeat }.max() ?? 0, 0)
    var voices: [Int] = []
    for n in notes where !voices.contains(n.voice) { voices.append(n.voice) }
    var grid: [(t: Double, pitches: [Int: Int])] = []
    var t = 0.0
    while t < end {
        var pitches: [Int: Int] = [:]
        for v in voices {
            if let note = notes.first(where: { $0.voice == v && $0.startBeat <= t + 1e-9 && $0.startBeat + $0.durBeat > t + 1e-9 }) {
                pitches[v] = note.midi
            }
        }
        grid.append((t, pitches))
        t += step
    }
    return grid
}

private func countParallels(_ notes: [FugueNote]) -> FuguePar {
    let grid = expandTimeline(notes, step: 0.5)
    var par = FuguePar()
    guard grid.count > 1 else { return par }
    for i in 1..<grid.count {
        let prev = grid[i - 1].pitches, curr = grid[i].pitches
        let voices = curr.keys.sorted()
        for a in 0..<voices.count { for b in (a + 1)..<voices.count {
            let va = voices[a], vb = voices[b]
            guard let pva = prev[va], let pvb = prev[vb], let cva = curr[va], let cvb = curr[vb] else { continue }
            let ip = intervalClass(pva, pvb), ic = intervalClass(cva, cvb)
            let ma = signum(cva - pva), mb = signum(cvb - pvb)
            if ma != 0 || mb != 0 { par.totalMotion += 1 }
            if ma == -mb && ma != 0 { par.contrary += 1 }
            if ic == 0 { par.unisons += 1 }
            if (ip == 7 || ip == 0) && ic == ip && ma == mb && ma != 0 {
                if ic == 7 { par.p5 += 1 } else { par.p8 += 1 }
            }
            if cva <= cvb && va > vb { par.overlaps += 1 }
        } }
    }
    return par
}

private func melodicLeapPenalty(_ notes: [FugueNote]) -> Int {
    var penalty = 0
    let byVoice = groupByVoiceIdx(notes)
    for k in byVoice.keys.sorted() {
        let arr = byVoice[k]!
        guard arr.count > 1 else { continue }
        for i in 1..<arr.count {
            let leap = abs(notes[arr[i]].midi - notes[arr[i - 1]].midi)
            if leap > 7 { penalty += leap - 7 }
            if i >= 2 {
                let prev = notes[arr[i - 1]].midi - notes[arr[i - 2]].midi
                let cur = notes[arr[i]].midi - notes[arr[i - 1]].midi
                if abs(prev) > 5 && signum(prev) == signum(cur) && abs(cur) > 2 { penalty += 3 }
            }
        }
    }
    return penalty
}

private func cadenceStrength(_ notes: [FugueNote], totalBeats: Double, ctx: BachKeyContext) -> Int {
    let tail = notes.filter { $0.startBeat >= totalBeats - 4 }
    let tonic = ctx.tonicPc, dom = (ctx.tonicPc + 7) % 12
    let bassVoice = tail.map { $0.voice }.max() ?? -1
    var tonicHits = 0, domHits = 0, bassCad = 0
    for n in tail {
        let pc = pcNorm(n.midi)
        if pc == tonic { tonicHits += 1 }
        if pc == dom { domHits += 1 }
        if n.voice == bassVoice && (pc == tonic || pc == dom) { bassCad += 1 }
    }
    return tonicHits * 2 + domHits + bassCad * 2
}

private func harmonicCoherence(_ notes: [FugueNote], plan: [HarmonicPlanMeasure], ctx: BachKeyContext) -> Double {
    var ok = 0, total = 0
    for measure in plan {
        let chord = chordPcsForFunction(ctx, measure.fn)
        for n in notes where n.startBeat >= Double(measure.measure) * 4 && n.startBeat < Double(measure.measure + 1) * 4 {
            total += 1
            if chord.contains(pcNorm(n.midi)) { ok += 1 }
        }
    }
    return total > 0 ? Double(ok) / Double(total) : 0
}

func scoreFugue(_ notes: [FugueNote], plan: [HarmonicPlanMeasure], ctx: BachKeyContext) -> FugueScore {
    let par = countParallels(notes)
    let leaps = melodicLeapPenalty(notes)
    let totalBeats = notes.map { $0.startBeat + $0.durBeat }.max() ?? 0
    let cad = cadenceStrength(notes, totalBeats: totalBeats, ctx: ctx)
    let harm = harmonicCoherence(notes, plan: plan, ctx: ctx)
    let subj = notes.filter { ["subject", "answer", "stretto"].contains($0.role) }.count
    let score = 100 - Double(par.p5) * 8 - Double(par.p8) * 10 - Double(leaps) * 1.2 - Double(par.overlaps) * 5
        - Double(par.unisons) * 0.3 + (par.totalMotion > 0 ? Double(par.contrary) / Double(par.totalMotion) * 18 : 0)
        + Double(cad) * 1.8 + harm * 25 + Double(min(subj, 70)) * 0.35
    return FugueScore(score: score, par: par, leaps: leaps, cad: cad, harm: harm, subj: subj)
}

private func noteAtIdx(_ notes: [FugueNote], arr: [Int], t: Double) -> Int? {
    arr.first { notes[$0].startBeat <= t + 1e-9 && notes[$0].startBeat + notes[$0].durBeat > t + 1e-9 }
}

private func repairScore(_ notes: inout [FugueNote], ctx: BachKeyContext, plan: [HarmonicPlanMeasure]) {
    let byVoice = groupByVoiceIdx(notes)
    let voices = byVoice.keys.sorted()
    for _ in 0..<3 {
        let grid = expandTimeline(notes, step: 0.5)
        if grid.count > 1 {
            for i in 1..<grid.count {
                for a in 0..<voices.count { for b in (a + 1)..<voices.count {
                    let va = voices[a], vb = voices[b]
                    guard let p0 = grid[i - 1].pitches[va], let q0 = grid[i - 1].pitches[vb],
                          let p1 = grid[i].pitches[va], let q1 = grid[i].pitches[vb] else { continue }
                    let ip = intervalClass(p0, q0), ic = intervalClass(p1, q1)
                    let ma = signum(p1 - p0), mb = signum(q1 - q0)
                    if (ip == 7 || ip == 0) && ic == ip && ma == mb && ma != 0 {
                        guard let ni = noteAtIdx(notes, arr: byVoice[vb] ?? [], t: grid[i].t) else { continue }
                        for d in [-2, 2, -1, 1, 3, -3] {
                            let cand = fitToScale(ctx, notes[ni].midi + d)
                            let old = notes[ni].midi
                            notes[ni].midi = cand
                            let scNew = scoreFugue(notes, plan: plan, ctx: ctx).score
                            notes[ni].midi = old
                            let scOld = scoreFugue(notes, plan: plan, ctx: ctx).score
                            if scNew > scOld { notes[ni].midi = cand; break }
                        }
                    }
                } }
            }
        }
        for v in voices {
            let arr = byVoice[v] ?? []
            guard arr.count > 1 else { continue }
            for i in 1..<arr.count {
                let leap = abs(notes[arr[i]].midi - notes[arr[i - 1]].midi)
                if leap > 9 { notes[arr[i]].midi = fitToScale(ctx, notes[arr[i - 1]].midi + signum(notes[arr[i]].midi - notes[arr[i - 1]].midi) * 7) }
            }
        }
    }
    notes.sort(by: byStart)
}

// MARK: - Structure

private func fitRegister(_ midi0: Int, voice: Int, voices: Int) -> Int {
    var midi = midi0
    let target = (voices == 3 ? [76, 64, 50] : [79, 69, 59, 47])[voice]
    while midi - target > 8 { midi -= 12 }
    while target - midi > 8 { midi += 12 }
    return midi
}

private func buildEpisodeForVoice(_ ctx: BachKeyContext, frag: [FugueNote], startBeat: Double, voice: Int, regBase: Int, _ rng: BachRNG) -> [FugueNote] {
    let seq = sequenceFragment(ctx, frag: frag, steps: 4, transposition: bChoice(rng, [-2, 2, -5, 5]), durScale: 0.75)
    return seq.map { var n = $0; n.voice = voice; n.startBeat += startBeat; n.midi = fitToScale(ctx, n.midi + regBase); n.role = "episode"; return n }
}

private func fillRestWithCounter(_ baseNotes: inout [FugueNote], voice: Int, startBeat: Double, endBeat: Double,
                                 counter: [FugueNote], ctx: BachKeyContext, voices: Int, _ rng: BachRNG, role: String = "free") {
    var t = startBeat
    var idx = 0
    while t < endBeat - 1e-9 {
        let slice = baseNotes.filter { $0.startBeat < t + 0.001 && $0.startBeat + $0.durBeat > t + 0.001 && $0.voice != voice }
        let src = counter.isEmpty ? FugueNote(voice: 0, midi: scaleMidi(ctx, 1, 4), startBeat: 0, durBeat: 1, role: "") : counter[idx % counter.count]
        let dur = min(src.durBeat, endBeat - t)
        if dur <= 0 { break }
        var midi = fitRegister(src.midi + bChoice(rng, [-12, 0, 12]), voice: voice, voices: voices)
        if !slice.isEmpty {
            let pcs = slice.map { $0.midi }
            for d in [0, 2, -2, 4, -4, 7, -7] {
                let cand = fitToScale(ctx, midi + d)
                if pcs.allSatisfy({ isConsonant(cand - $0) || dur <= 0.5 }) { midi = cand; break }
            }
        }
        baseNotes.append(FugueNote(voice: voice, midi: midi, startBeat: t, durBeat: dur, role: role))
        t += dur
        idx += 1
    }
}

private struct StructureEvent { var type: String; var voice: Int; var measure: Double; var label: String }

private func planStructure(totalMeasures: Int, voices: Int, character: String) -> [StructureEvent] {
    var events: [StructureEvent] = []
    let subjectGap = character == "stretto-driven fugue" ? 3 : 4
    for v in 0..<voices {
        events.append(StructureEvent(type: v % 2 == 0 ? "subject" : "answer", voice: v, measure: Double(v * subjectGap) / 2, label: "exposition"))
    }
    let base = (Double(voices * subjectGap) / 2).rounded(.up)
    events.append(StructureEvent(type: "episode", voice: 0, measure: base + 1, label: "episode1"))
    events.append(StructureEvent(type: "middleEntry", voice: voices - 1, measure: base + 3, label: "middle1"))
    events.append(StructureEvent(type: "middleEntry", voice: max(0, voices - 2), measure: base + 5, label: "middle2"))
    events.append(StructureEvent(type: "episode", voice: 0, measure: base + 7, label: "episode2"))
    events.append(StructureEvent(type: "middleEntry", voice: 0, measure: base + 9, label: "middle3"))
    if totalMeasures > 18 { events.append(StructureEvent(type: "episode", voice: 0, measure: floor(Double(totalMeasures) * 0.65), label: "episode3")) }
    let closeStart = Double(totalMeasures - 4)
    if character == "stretto-driven fugue" || character == "compact fugue" {
        for v in 0..<voices { events.append(StructureEvent(type: "stretto", voice: v, measure: closeStart + Double(v) * 0.5, label: "closing")) }
    } else {
        events.append(StructureEvent(type: "pedal", voice: voices - 1, measure: closeStart, label: "closing"))
        events.append(StructureEvent(type: "middleEntry", voice: 1, measure: closeStart, label: "closingEntry"))
    }
    return events
}

// MARK: - generateFugue

func generateFugue(_ config: BachFugueConfig) -> BachPiece {
    let ctx = bachKeyContext(config.key)
    let rng = BachRNG(seed: bachHashString(String(config.seed)))
    let plan = buildHarmonicPlan(ctx, length: config.length, character: config.character)
    let totalMeasures = plan.count
    let totalBeats = Double(totalMeasures * 4)
    let subjectObj = generateSubject(ctx, rng, character: config.character, complexity: config.complexity)
    let subject = subjectObj.notes.map { var n = $0; n.midi = fitRegister(n.midi, voice: 0, voices: config.voices); return n }
    let countersubject = buildCountersubject(ctx, subject: subject, rng)
    let fragment = fragmentNotes(subject, from: 0, to: min(subjectObj.totalBeats, 2))
    let structure = planStructure(totalMeasures: totalMeasures, voices: config.voices, character: config.character)
    var bestNotes: [FugueNote]? = nil
    var bestScore = -Double.infinity
    var bestMeta: (analysis: [String], score: FugueScore)? = nil

    for _ in 0..<max(1, config.attempts ?? 10) {
        var notes: [FugueNote] = []
        var analysis: [String] = []
        for ev in structure {
            let startBeat = ev.measure * 4
            if ev.type == "subject" || ev.type == "answer" || ev.type == "middleEntry" {
                var segment: [FugueNote]
                if ev.type == "answer" {
                    segment = transformSubject(subject, transpose: 7, tonalAdjust: true, ctx: ctx)
                } else if ev.type == "middleEntry" {
                    let style = bChoice(rng, ["subject", "answer", "inversion", "augmentation", "diminution"])
                    if style == "answer" { segment = transformSubject(subject, transpose: 7, tonalAdjust: true, ctx: ctx) }
                    else if style == "inversion" { segment = transformSubject(subject, invertAround: fitRegister(scaleMidi(ctx, 5, 5), voice: ev.voice, voices: config.voices), ctx: ctx) }
                    else if style == "augmentation" { segment = transformSubject(subject, augment: 2, ctx: ctx) }
                    else if style == "diminution" { segment = transformSubject(subject, diminish: 2, ctx: ctx) }
                    else { segment = transformSubject(subject, transpose: bChoice(rng, [0, 7, -5, 2]), ctx: ctx) }
                } else {
                    segment = transformSubject(subject, ctx: ctx)
                }
                segment = segment.map { var n = $0; n.voice = ev.voice; n.startBeat += startBeat; n.midi = fitRegister(n.midi, voice: ev.voice, voices: config.voices); n.role = ev.type == "answer" ? "answer" : "subject"; return n }
                notes += segment
                analysis.append("\(ev.label): \(ev.type) in voice \(ev.voice + 1) at m.\(String(format: "%.1f", startBeat / 4))")
                let segmentEnd = segment.map { $0.startBeat + $0.durBeat }.max() ?? startBeat
                for v in 0..<config.voices where v != ev.voice {
                    let role = startBeat < totalBeats * 0.4 ? "countersubject" : "free"
                    fillRestWithCounter(&notes, voice: v, startBeat: startBeat, endBeat: segmentEnd, counter: countersubject, ctx: ctx, voices: config.voices, rng, role: role)
                }
            }
            if ev.type == "episode" {
                for v in 0..<config.voices {
                    let reg = v == config.voices - 1 ? -12 : v * 2
                    let episode = buildEpisodeForVoice(ctx, frag: fragment, startBeat: startBeat + Double(v) * 0.25, voice: v, regBase: reg, rng)
                    notes += episode.map { var n = $0; n.midi = fitRegister(n.midi, voice: v, voices: config.voices); return n }
                }
                analysis.append("\(ev.label): sequential episode derived from subject head at m.\(String(format: "%.1f", startBeat / 4))")
            }
            if ev.type == "stretto" {
                var segment = transformSubject(subject, diminish: 2, ctx: ctx)
                segment = segment.map { var n = $0; n.voice = ev.voice; n.startBeat += startBeat; n.midi = fitRegister(n.midi, voice: ev.voice, voices: config.voices); n.role = "stretto"; return n }
                notes += segment
                analysis.append("closing stretto overlap in voice \(ev.voice + 1) at m.\(String(format: "%.1f", startBeat / 4))")
            }
            if ev.type == "pedal" {
                let bassPc = degreePc(ctx, 5)
                var t = startBeat
                while t < totalBeats {
                    notes.append(FugueNote(voice: ev.voice, midi: fitRegister(36 + (t >= totalBeats - 2 ? ctx.tonicPc - bassPc : 0) + bassPc, voice: ev.voice, voices: config.voices), startBeat: t, durBeat: 2, role: "pedal"))
                    t += 2
                }
                analysis.append("dominant pedal moving to tonic in bass from m.\(String(format: "%.1f", startBeat / 4))")
            }
        }

        // Gap fill: every voice sounds to the end of the piece.
        for v in 0..<config.voices {
            var arr = notes.indices.filter { notes[$0].voice == v }.sorted { byStart(notes[$0], notes[$1]) }
            var t = 0.0
            while t < totalBeats - 1e-9 {
                if let ci = arr.first(where: { notes[$0].startBeat <= t + 1e-9 && notes[$0].startBeat + notes[$0].durBeat > t + 1e-9 }) {
                    t = notes[ci].startBeat + notes[ci].durBeat
                    continue
                }
                let measure = Int(floor(t / 4))
                let fn = (measure >= 0 && measure < plan.count) ? plan[measure].fn : "T"
                let chord = chordPcsForFunction(ctx, fn)
                let dur = bCoin(rng, 0.65) ? 1.0 : 0.5
                var choices: [Int] = []
                for shift in -12...12 { for pc in chord { for oct in 2...7 {
                    let m0 = 12 * (oct + 1) + pc
                    let mm = fitRegister(m0 + shift, voice: v, voices: config.voices)
                    if mm >= 33 && mm <= 92 { choices.append(mm) }
                } } }
                var midi = choices.isEmpty
                    ? fitRegister(scaleMidi(ctx, 1 + (v * 2) % 7, 5 - Int(Double(v) * 0.8)), voice: v, voices: config.voices)
                    : bChoice(rng, choices)
                if !arr.isEmpty {
                    let prevIdx = arr.filter { notes[$0].startBeat < t }.sorted { byStart(notes[$0], notes[$1]) }.last
                    if let prevIdx, !choices.isEmpty {
                        choices.sort { abs($0 - notes[prevIdx].midi) < abs($1 - notes[prevIdx].midi) }
                        midi = choices[0]
                    }
                }
                notes.append(FugueNote(voice: v, midi: midi, startBeat: t, durBeat: min(dur, totalBeats - t), role: "free"))
                arr.append(notes.count - 1)
                arr.sort { byStart(notes[$0], notes[$1]) }
                t += dur
            }
        }

        for i in notes.indices { notes[i].midi = clampI(notes[i].midi, 33, 92) }
        repairScore(&notes, ctx: ctx, plan: plan)
        notes.sort(by: byStart)
        let score = scoreFugue(notes, plan: plan, ctx: ctx)
        if score.score.isFinite && score.score > bestScore {
            bestScore = score.score
            bestNotes = notes
            bestMeta = (analysis, score)
        }
    }

    guard let bestNotes, let bestMeta else {
        let empty: [FugueNote] = []
        return BachPiece(notes: empty, totalBeats: totalBeats, analysis: ["Generation fell back to an empty score."],
                         subject: subject, countersubject: countersubject, plan: plan, score: scoreFugue(empty, plan: plan, ctx: ctx), ctx: ctx)
    }
    return BachPiece(notes: bestNotes, totalBeats: totalBeats, analysis: bestMeta.analysis, subject: subject,
                     countersubject: countersubject, plan: plan, score: bestMeta.score, ctx: ctx)
}

// MARK: - SMF encoding (encodeFugueMidi)

private func vlqBytes(_ n0: Int) -> [UInt8] {
    var n = n0
    var bytes: [UInt8] = [UInt8(n & 0x7f)]
    while (n >> 7) != 0 { n >>= 7; bytes.insert(UInt8((n & 0x7f) | 0x80), at: 0) }
    return bytes
}
private func strBytes(_ s: String) -> [UInt8] { s.map { UInt8($0.asciiValue ?? 63) & 0x7f } }
private func u16b(_ n: Int) -> [UInt8] { [UInt8((n >> 8) & 0xff), UInt8(n & 0xff)] }
private func u32b(_ n: Int) -> [UInt8] { [UInt8((n >> 24) & 0xff), UInt8((n >> 16) & 0xff), UInt8((n >> 8) & 0xff), UInt8(n & 0xff)] }
private func metaText(_ type: UInt8, _ text: String) -> [UInt8] {
    let b = strBytes(text)
    return [0xff, type] + vlqBytes(b.count) + b
}

func encodeFugueMidi(_ piece: BachPiece, config: BachFugueConfig) -> Data {
    let voiceCount = max(config.voices, (piece.notes.map { $0.voice }.max() ?? -1) + 1)
    var tracks: [[UInt8]] = []
    for voice in 0..<voiceCount {
        let channel = voice & 0x0f
        var events: [(tick: Int, order: Int, bytes: [UInt8])] = []
        let label = voice < bachVoiceNames.count ? bachVoiceNames[voice] : "Voice \(voice + 1)"
        events.append((0, 0, metaText(0x03, "Generated Bach \(label)")))
        events.append((0, 1, metaText(0x04, "Harpsichord")))
        if voice == 0 {
            let mpqn = jsRound(60000000 / Double(config.tempo))
            events.append((0, 2, [0xff, 0x51, 0x03, UInt8((mpqn >> 16) & 0xff), UInt8((mpqn >> 8) & 0xff), UInt8(mpqn & 0xff)]))
            events.append((0, 3, [0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08]))
        }
        events.append((0, 10, [UInt8(0xb0 | channel), 0, 0]))
        events.append((0, 11, [UInt8(0xb0 | channel), 32, 0]))
        events.append((0, 12, [UInt8(0xc0 | channel), 6]))
        for note in piece.notes where note.voice == voice {
            let startTick = max(0, jsRound(note.startBeat * 480))
            let endTick = max(startTick + 1, jsRound((note.startBeat + note.durBeat) * 480))
            events.append((startTick, 20, [UInt8(0x90 | channel), UInt8(clampI(note.midi, 0, 127)), 82]))
            events.append((endTick, 18, [UInt8(0x80 | channel), UInt8(clampI(note.midi, 0, 127)), 64]))
        }
        events.sort { ($0.tick, $0.order, $0.bytes[0]) < ($1.tick, $1.order, $1.bytes[0]) }
        var previousTick = 0
        var body: [UInt8] = []
        for e in events { body += vlqBytes(e.tick - previousTick) + e.bytes; previousTick = e.tick }
        body += vlqBytes(0) + [0xff, 0x2f, 0x00]
        tracks.append(strBytes("MTrk") + u32b(body.count) + body)
    }
    var bytes = strBytes("MThd") + u32b(6) + u16b(1) + u16b(tracks.count) + u16b(480)
    for t in tracks { bytes += t }
    return Data(bytes)
}

func generateBachMidi(key: String? = nil, length: String? = nil, voices: Int? = nil, character: String? = nil,
                      complexity: Int? = nil, tempo: Int? = nil, seed: Int? = nil, attempts: Int? = nil) -> GeneratedBachMidi {
    let theSeed = seed ?? Int.random(in: 0..<1_000_000_000)
    let config = BachFugueConfig(key: key ?? "C", length: length ?? "medium", voices: voices ?? 4,
                                 character: character ?? "compact fugue", complexity: complexity ?? 3,
                                 tempo: tempo ?? 92, seed: theSeed, attempts: attempts)
    let piece = generateFugue(config)
    return GeneratedBachMidi(midiData: encodeFugueMidi(piece, config: config), fileName: "generated-bach-\(theSeed).mid",
                             seed: theSeed, piece: piece, config: config)
}
