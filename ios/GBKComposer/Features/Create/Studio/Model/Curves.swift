import Foundation

// Port of src/workstation/curves.ts — deterministic, frame-rate independent CC curve generation
// (pure function of args).

struct CurveSpec {
    var shape: String // crescendo | decrescendo | swell | linear | smoothstep | exponential | points
    var startTick: Int
    var endTick: Int
    var from: Double? = nil // 0..127 (default per shape)
    var to: Double? = nil
    var peak: Double? = nil // swell peak value
    var exponent: Double? = nil // exponential curvature (default 3)
    var points: [(tick: Int, value: Double)]? = nil // control points for "points"
    var stepTicks: Int? = nil // density (default ppq/8)
    var simplify: Bool? = nil // drop points that don't change the value (default true)
}

private func clampCurveValue(_ v: Double) -> Int { max(0, min(127, Int(v.rounded()))) }
private func smoothstepFn(_ t: Double) -> Double { t * t * (3 - 2 * t) }

func curveValueAt(_ spec: CurveSpec, tick: Int) -> Double {
    let len = Double(max(1, spec.endTick - spec.startTick))
    let t = max(0, min(1, Double(tick - spec.startTick) / len))
    let from = spec.from ?? (spec.shape == "decrescendo" ? 110 : 40)
    let to = spec.to ?? (spec.shape == "decrescendo" ? 40 : 110)
    switch spec.shape {
    case "linear": return from + (to - from) * t
    case "crescendo", "decrescendo", "smoothstep": return from + (to - from) * smoothstepFn(t)
    case "exponential":
        let k = spec.exponent ?? 3
        let e = (exp(k * t) - 1) / (exp(k) - 1)
        return from + (to - from) * e
    case "swell":
        let peak = spec.peak ?? 120
        let u = t < 0.5 ? smoothstepFn(t * 2) : smoothstepFn((1 - t) * 2)
        let base = t < 0.5 ? from : to
        return base + (peak - base) * u
    case "points":
        let pts = (spec.points ?? []).sorted { $0.tick < $1.tick }
        if pts.isEmpty { return from }
        if tick <= pts[0].tick { return pts[0].value }
        for i in 1..<pts.count where tick <= pts[i].tick {
            let a = pts[i - 1], b = pts[i]
            let f = Double(tick - a.tick) / Double(max(1, b.tick - a.tick))
            return a.value + (b.value - a.value) * f
        }
        return pts[pts.count - 1].value
    default: return from
    }
}

func generateCurve(_ spec: CurveSpec, ppq: Int) throws -> [(tick: Int, value: Int)] {
    guard spec.endTick > spec.startTick else { throw PlainToolError(message: "INVALID_RANGE") }
    let step = max(1, Int((Double(spec.stepTicks ?? ppq / 8)).rounded()))
    var out: [(tick: Int, value: Int)] = []
    var tick = spec.startTick
    while tick < spec.endTick {
        out.append((tick, clampCurveValue(curveValueAt(spec, tick: tick))))
        tick += step
    }
    out.append((spec.endTick, clampCurveValue(curveValueAt(spec, tick: spec.endTick))))
    if spec.simplify == false { return out }
    return out.enumerated().filter { i, p in i == 0 || i == out.count - 1 || p.value != out[i - 1].value }.map { $0.element }
}
