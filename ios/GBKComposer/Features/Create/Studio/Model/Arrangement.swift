import Foundation

/// Native port of src/music/arrangement.ts: project + plan -> ProjectOp batch (one transaction).
/// Strategies: "baroque" (Bach fugue generator + continuo) and chord-based classical/pop/jazz/ambient.

struct ArrangementFeatures: Equatable, Sendable {
    var counterpoint: Bool = true; var dynamicExpression: Bool = true; var articulation: Bool = true; var cadences: Bool = true
}
struct ArrangementPlan: Equatable, Sendable {
    var style: String; var key: KeyInfo; var bars: Int; var seed: Int
    var voices: Int = 4; var complexity: Int = 3; var features = ArrangementFeatures()
}
struct AssignedPart: Equatable, Sendable { var track: GTrack; var spec: InstrumentSpec }
struct ArrangementTrackResult: Equatable, Sendable { var trackId: String; var name: String; var notes: Int; var ccs: Int; var range: [Int]? }
struct ArrangementResult {
    var ops: [ProjectOp]; var perTrack: [ArrangementTrackResult]
    var metrics: (parallelPerfects: Int, voiceCrossings: Int, repeatedNoteRatio: Double)
    var analysis: [String]; var sections: [Section]; var totalNotes: Int; var totalCcs: Int; var durationSec: Double
}

func defaultSections(_ bars: Int) -> [Section] {
    if bars < 8 { return [Section(name: "Theme", startBar: 1, bars: bars, energy: 0.6)] }
    let intro = max(2, jsRound(Double(bars) / 6 / 2) * 2), coda = max(2, jsRound(Double(bars) / 6 / 2) * 2)
    let mid = bars - intro - coda
    let theme = jsRound(Double(mid) / 2 / 2) * 2
    return [
        Section(name: "Introduction", startBar: 1, bars: intro, energy: 0.35),
        Section(name: "Theme", startBar: 1 + intro, bars: theme, energy: 0.65),
        Section(name: "Development", startBar: 1 + intro + theme, bars: mid - theme, energy: 0.9),
        Section(name: "Coda", startBar: 1 + intro + mid, bars: coda, energy: 0.5),
    ]
}

func arrangementBarGrid(_ p: Project, _ n: Int) -> [BarGrid] {
    let spans = bars(p, upToTick: barBeatToTick(p, bar: n + 1) - 1)
    return spans.prefix(n).map { BarGrid(tick: $0.startTick, length: $0.endTick - $0.startTick, beats: $0.numerator, beatTicks: jsRound(ticksPerBeat(p, atTick: $0.startTick))) }
}

private func sustaining(_ s: InstrumentSpec) -> Bool { ["strings", "winds", "brass", "voice"].contains(s.family) }

private func baroqueStrategy(_ p: Project, plan: ArrangementPlan, parts: [AssignedPart], grid: [BarGrid], r: Rand, energyAt: (Int) -> Double, analysis: inout [String]) -> [String: [MNote]] {
    let total = grid.isEmpty ? 0 : grid[grid.count - 1].tick + grid[grid.count - 1].length
    var out: [String: [MNote]] = [:]
    let lineParts = parts.filter { $0.spec.family != "keys" && $0.spec.family != "drums" }
        .sorted { ($0.spec.lo + $0.spec.hi) > ($1.spec.lo + $1.spec.hi) }
    let keysParts = parts.filter { $0.spec.family == "keys" }
    let (lines, an) = baroqueVoices(key: plan.key, totalTicks: total, ppq: p.ppq, voices: plan.voices, complexity: plan.complexity, seed: plan.seed)
    analysis += an
    var used = Set<Int>()
    for (i, a) in lineParts.enumerated() {
        let li = i == lineParts.count - 1 ? lines.count - 1 : min(i, lines.count - 2)
        used.insert(li)
        out[a.track.id] = placeInRange(lines[li], lo: a.spec.lo, hi: a.spec.hi)
    }
    for k in keysParts {
        let inner = lines.indices.filter { !used.contains($0) }
        let rh = inner.isEmpty ? [] : placeInRange(lines[inner[0]], lo: 60, hi: 79)
        if !inner.isEmpty { used.insert(inner[0]) }
        let lh = lineParts.isEmpty ? placeInRange(lines[lines.count - 1], lo: k.spec.lo, hi: 55) : []
        let cont = continuo(lines: lines, grid: grid, key: plan.key, lo: 50, hi: 67)
        out[k.track.id] = rh + lh + cont
        analysis.append("\(k.track.name): continuo realization (chords from the sounding voices)\(rh.isEmpty ? "" : " + inner fugue voice")")
    }
    for d in parts where d.spec.family == "drums" { out[d.track.id] = composeDrumPattern(grid: grid, r: r, style: "march", energy: energyAt) }
    return out
}

typealias ArrangementStrategy = (Project, ArrangementPlan, [AssignedPart], [BarGrid], Rand, (Int) -> Double, inout [String]) -> [String: [MNote]]

private func chordBasedStrategy(flavor: String) -> ArrangementStrategy {
    return { p, plan, parts, grid, r, energyAt, analysis in
        var cad = Set<Int>()
        for s in p.meta?.sections ?? [] { cad.insert(s.startBar - 1 + s.bars - 1) }
        let chords = chordProgression(bars: grid.count, style: flavor == "ambient" ? "classical" : flavor, r: r, cadenceBars: plan.features.cadences ? cad : [])
        analysis.append("progression (scale degrees per bar): \(chords.prefix(16).map(String.init).joined(separator: " "))\(chords.count > 16 ? " ..." : "")")
        var out: [String: [MNote]] = [:]
        var lead: [MNote]? = nil
        let roleRank = ["melody", "bass", "harmony", "counterpoint", "accompaniment", "percussion"]
        let order = parts.sorted { (roleRank.firstIndex(of: $0.spec.role) ?? 99) < (roleRank.firstIndex(of: $1.spec.role) ?? 99) }
        for a in order {
            let role = a.track.role ?? a.spec.role
            let lo = a.spec.lo, hi = a.spec.hi
            var ns: [MNote]
            if role == "percussion" {
                ns = composeDrumPattern(grid: grid, r: r, style: flavor == "pop" ? "pop" : "rock", energy: energyAt)
            } else if role == "bass" {
                ns = composeBassLine(grid: grid, chords: chords, key: plan.key, lo: lo, hi: min(hi, 60), r: r, pattern: flavor == "jazz" ? "walking" : flavor == "pop" ? "roots" : "root-fifth")
            } else if role == "melody" && lead == nil {
                ns = composeMelody(grid: grid, chords: chords, key: plan.key, lo: max(lo, 60), hi: min(hi, 88), r: r, density: flavor == "ambient" ? 1 : 2)
                lead = ns
            } else if (role == "counterpoint" || (role == "melody" && lead != nil)) && lead != nil && plan.features.counterpoint {
                let total = grid.isEmpty ? 0 : grid[grid.count - 1].tick + grid[grid.count - 1].length
                ns = counterpoint(cantus: lead!, CounterpointOpts(lo: max(lo, 48), hi: min(hi, 76), rhythm: 1, seed: plan.seed + 7, startTick: 0, endTick: total, ppq: p.ppq, tonic: plan.key.tonic, mode: plan.key.mode, above: false)).notes
            } else {
                ns = composeAccompaniment(grid: grid, chords: chords, key: plan.key, lo: max(lo, 48), hi: min(hi, 76), r: r,
                                          style: flavor == "ambient" || sustaining(a.spec) ? "block" : flavor == "classical" ? "alberti" : "arpeggio")
            }
            out[a.track.id] = ns
        }
        return out
    }
}

func generateArrangement(_ p: Project, plan: ArrangementPlan, parts: [AssignedPart]) throws -> ArrangementResult {
    let strategies: [String: ArrangementStrategy] = [
        "baroque": { baroqueStrategy($0, plan: $1, parts: $2, grid: $3, r: $4, energyAt: $5, analysis: &$6) },
        "classical": chordBasedStrategy(flavor: "classical"),
        "pop": chordBasedStrategy(flavor: "pop"),
        "jazz": chordBasedStrategy(flavor: "jazz"),
        "ambient": chordBasedStrategy(flavor: "ambient"),
    ]
    guard let strategy = strategies[plan.style] else { throw ToolArgError("INVALID_ARGUMENT", "unknown style \(plan.style)") }
    let rng = SeededRNG(seed: plan.seed)
    let r: Rand = { rng.next() }
    let grid = arrangementBarGrid(p, plan.bars)
    let sections = (p.meta?.sections?.isEmpty == false) ? p.meta!.sections! : defaultSections(plan.bars)
    func energyAt(_ bar0: Int) -> Double { sections.first { bar0 + 1 >= $0.startBar && bar0 + 1 < $0.startBar + $0.bars }?.energy ?? 0.6 }
    func barOf(_ tick: Int) -> Int {
        var lo = 0, hi = grid.count - 1
        while lo < hi { let m = (lo + hi + 1) >> 1; if grid[m].tick <= tick { lo = m } else { hi = m - 1 } }
        return lo
    }
    var analysis: [String] = []
    let raw = strategy(p, plan, parts, grid, r, energyAt, &analysis)
    var ops: [ProjectOp] = []
    var perTrack: [ArrangementTrackResult] = []
    let total = grid.isEmpty ? 0 : grid[grid.count - 1].tick + grid[grid.count - 1].length
    let phrase = grid.count >= 4 ? grid[3].tick + grid[3].length - grid[0].tick : (total != 0 ? total : 1)
    var totalNotes = 0, totalCcs = 0
    for a in parts {
        var ns = (raw[a.track.id] ?? []).filter { $0.tick >= 0 && $0.tick < total }
        ns = ns.map { MNote(tick: $0.tick, duration: $0.duration, pitch: $0.pitch, velocity: jsRound(Double($0.velocity) * (0.72 + 0.4 * energyAt(barOf($0.tick))))) }
        if plan.features.dynamicExpression { ns = phraseDynamics(ns, phraseTicks: phrase, depth: 12) }
        ns = humanizeNotes(ns, r: r, velocity: 5, timing: 0)
        if plan.features.articulation && a.spec.family != "drums" {
            ns = articulateNotes(ns, kind: a.spec.family == "keys" ? "tenuto" : plan.style == "baroque" ? "detache" : "legato")
        }
        ns = ns.map { MNote(tick: $0.tick, duration: max(1, min($0.duration, total - $0.tick)), pitch: max(0, min(127, $0.pitch)), velocity: max(1, min(127, $0.velocity))) }
        totalNotes += ns.count
        ops.append(.addNotes(ns.map { GNote(id: newStudioId("n"), trackId: a.track.id, channel: a.track.channel, tick: $0.tick, duration: $0.duration, pitch: $0.pitch, velocity: $0.velocity) }))
        var ccs = 0
        if plan.features.dynamicExpression && a.spec.family != "drums" && total > 0 {
            var pts: [CCEvent] = []
            let step = sustaining(a.spec) ? jsRound(Double(p.ppq) / 2) : (grid.first?.length ?? p.ppq * 4)
            var t = 0
            while t < total {
                let b = barOf(t)
                let x = Double(jsMod(t - (grid.first?.tick ?? 0), phrase)) / Double(phrase)
                let arc = sin(Double.pi * x)
                let value = max(30, min(127, jsRound(48 + energyAt(b) * 62 + (sustaining(a.spec) ? arc * 14 : 0))))
                pts.append(CCEvent(id: newStudioId("cc"), trackId: a.track.id, channel: a.track.channel, controller: 11, tick: t, value: value))
                t += step
            }
            pts.append(CCEvent(id: newStudioId("cc"), trackId: a.track.id, channel: a.track.channel, controller: 11, tick: total, value: pts.last?.value ?? 100))
            ops.append(.setCC(trackId: a.track.id, controller: 11, points: pts, mode: "replace"))
            ccs += pts.count
            if a.spec.family == "strings" || a.spec.family == "voice" {
                let mod = grid.enumerated().map { (i, g) in CCEvent(id: newStudioId("cc"), trackId: a.track.id, channel: a.track.channel, controller: 1, tick: g.tick, value: jsRound(18 + energyAt(i) * 34)) }
                ops.append(.setCC(trackId: a.track.id, controller: 1, points: mod, mode: "replace"))
                ccs += mod.count
            }
        }
        ops.append(.setCC(trackId: a.track.id, controller: 91, points: [CCEvent(id: newStudioId("cc"), trackId: a.track.id, channel: a.track.channel, controller: 91, tick: 0, value: a.spec.family == "drums" ? 30 : 52)], mode: "replace"))
        ccs += 1
        totalCcs += ccs
        perTrack.append(ArrangementTrackResult(trackId: a.track.id, name: a.track.name, notes: ns.count, ccs: ccs,
                                               range: ns.isEmpty ? nil : [ns.map { $0.pitch }.min()!, ns.map { $0.pitch }.max()!]))
    }
    let lines = parts.filter { sustaining($0.spec) }.map { raw[$0.track.id] ?? [] }
    return ArrangementResult(ops: ops, perTrack: perTrack, metrics: voiceMetrics(lines), analysis: analysis, sections: sections,
                             totalNotes: totalNotes, totalCcs: totalCcs, durationSec: (tickToSec(p, total) * 1000).rounded() / 1000)
}
