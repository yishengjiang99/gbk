// Deterministic, frame-rate independent CC curve generation (pure function of args).
export type CurveShape = "crescendo" | "decrescendo" | "swell" | "linear" | "smoothstep" | "exponential" | "points";
export interface CurveSpec {
  shape: CurveShape;
  startTick: number;
  endTick: number;
  from?: number; // 0..127 (default per shape)
  to?: number;
  peak?: number; // swell peak value
  exponent?: number; // exponential curvature (default 3)
  points?: { tick: number; value: number }[]; // control points for "points"
  stepTicks?: number; // density (default ppq/8)
  simplify?: boolean; // drop points that don't change the value (default true)
}

const clamp = (v: number) => Math.max(0, Math.min(127, Math.round(v)));
const smooth = (t: number) => t * t * (3 - 2 * t);

export function curveValueAt(spec: CurveSpec, tick: number): number {
  const len = Math.max(1, spec.endTick - spec.startTick);
  const t = Math.max(0, Math.min(1, (tick - spec.startTick) / len));
  const from = spec.from ?? (spec.shape === "decrescendo" ? 110 : 40);
  const to = spec.to ?? (spec.shape === "decrescendo" ? 40 : 110);
  switch (spec.shape) {
    case "linear": return from + (to - from) * t;
    case "crescendo": case "decrescendo": case "smoothstep": return from + (to - from) * smooth(t);
    case "exponential": { const k = spec.exponent ?? 3; const e = (Math.exp(k * t) - 1) / (Math.exp(k) - 1); return from + (to - from) * e; }
    case "swell": { const peak = spec.peak ?? 120; const u = t < 0.5 ? smooth(t * 2) : smooth((1 - t) * 2); const base = t < 0.5 ? from : to; return base + (peak - base) * u; }
    case "points": {
      const pts = [...(spec.points ?? [])].sort((a, b) => a.tick - b.tick);
      if (!pts.length) return from;
      if (tick <= pts[0].tick) return pts[0].value;
      for (let i = 1; i < pts.length; i++) if (tick <= pts[i].tick) {
        const a = pts[i - 1], b = pts[i]; const f = (tick - a.tick) / Math.max(1, b.tick - a.tick); return a.value + (b.value - a.value) * f;
      }
      return pts[pts.length - 1].value;
    }
  }
}

export function generateCurve(spec: CurveSpec, ppq: number): { tick: number; value: number }[] {
  if (!(spec.endTick > spec.startTick)) throw new Error("INVALID_RANGE");
  const step = Math.max(1, Math.round(spec.stepTicks ?? ppq / 8));
  const out: { tick: number; value: number }[] = [];
  for (let tick = spec.startTick; tick < spec.endTick; tick += step) out.push({ tick, value: clamp(curveValueAt(spec, tick)) });
  out.push({ tick: spec.endTick, value: clamp(curveValueAt(spec, spec.endTick)) });
  if (spec.simplify === false) return out;
  return out.filter((p, i) => i === 0 || i === out.length - 1 || p.value !== out[i - 1].value);
}
