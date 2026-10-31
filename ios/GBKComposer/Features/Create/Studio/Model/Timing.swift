import Foundation

/// Port of src/workstation/timing.ts: tempo map + meter map conversions.

struct TempoSegment: Sendable { var startTick: Int; var microPerQuarter: Int; var startSec: Double }

func tempoSegments(_ p: Project) -> [TempoSegment] {
    let tempos = p.tempos.sorted { $0.tick < $1.tick }
    var segs: [TempoSegment] = [TempoSegment(startTick: 0, microPerQuarter: tempos.first(where: { $0.tick == 0 })?.microPerQuarter ?? 500000, startSec: 0)]
    for t in tempos where t.tick > 0 {
        let prev = segs[segs.count - 1]
        let sec = prev.startSec + Double(t.tick - prev.startTick) / Double(p.ppq) * (Double(prev.microPerQuarter) / 1e6)
        // Replace a zero-length segment at the same tick.
        if segs[segs.count - 1].startTick == t.tick { segs[segs.count - 1].microPerQuarter = t.microPerQuarter }
        else { segs.append(TempoSegment(startTick: t.tick, microPerQuarter: t.microPerQuarter, startSec: sec)) }
    }
    return segs
}

func tickToSec(_ p: Project, _ tick: Int) -> Double {
    let segs = tempoSegments(p)
    var seg = segs[0]
    for s in segs where s.startTick <= tick { seg = s }
    return seg.startSec + Double(tick - seg.startTick) / Double(p.ppq) * (Double(seg.microPerQuarter) / 1e6)
}

func secToTick(_ p: Project, _ sec: Double) -> Int {
    let segs = tempoSegments(p)
    var seg = segs[0]
    for s in segs where s.startSec <= sec { seg = s }
    return seg.startTick + Int((sec - seg.startSec) / (Double(seg.microPerQuarter) / 1e6) * Double(p.ppq))
}

func ticksPerBeat(_ p: Project, atTick: Int) -> Double {
    var denom = p.timeSigs.first?.denominator ?? 4
    for s in p.timeSigs.sorted(by: { $0.tick < $1.tick }) where s.tick <= atTick { denom = s.denominator }
    return Double(p.ppq) * 4.0 / Double(denom)
}

struct BarSpan: Sendable { var index: Int; var startTick: Int; var endTick: Int; var numerator: Int; var denominator: Int }

/// Bar boundaries from the meter map (bars counted from 0 here; tools use 1-based bars).
func bars(_ p: Project, upToTick: Int = .max) -> [BarSpan] {
    let sigs = p.timeSigs.sorted { $0.tick < $1.tick }
    var out: [BarSpan] = []
    var tick = 0, idx = 0, si = 0
    while tick < upToTick && idx < 1_000_000 {
        while si + 1 < sigs.count && sigs[si + 1].tick <= tick { si += 1 }
        let sig = sigs.isEmpty ? TimeSigEvent(tick: 0, numerator: 4, denominator: 4) : sigs[si]
        let barLen = max(1, Int((Double(p.ppq) * 4.0 / Double(sig.denominator) * Double(sig.numerator)).rounded()))
        out.append(BarSpan(index: idx, startTick: tick, endTick: tick + barLen, numerator: sig.numerator, denominator: sig.denominator))
        tick += barLen; idx += 1
        if upToTick == .max && tick >= p.endTick && out.count > 1 { break }
    }
    return out
}

/// 1-based bar, 0-based beat within the bar -> tick.
func barBeatToTick(_ p: Project, bar: Int, beat: Double = 0) -> Int {
    let bs = bars(p, upToTick: .max)
    let b = bs[min(max(bar - 1, 0), bs.count - 1)]
    return b.startTick + Int((beat * ticksPerBeat(p, atTick: b.startTick)).rounded())
}

/// Tick -> (1-based bar, 0-based beat).
func tickToBarBeat(_ p: Project, _ tick: Int) -> (bar: Int, beat: Double) {
    let bs = bars(p, upToTick: max(tick + 1, p.endTick))
    var b = bs[0]
    for x in bs where x.startTick <= tick { b = x }
    return (b.index + 1, Double(tick - b.startTick) / ticksPerBeat(p, atTick: b.startTick))
}
