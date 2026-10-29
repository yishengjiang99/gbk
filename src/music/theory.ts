// Deterministic music utilities. Anything labeled "heuristic" is an approximation, not ground truth.
export interface MNote { tick: number; duration: number; pitch: number; velocity: number }

export const transpose = (ns: MNote[], semis: number) => ns.map((n) => ({ ...n, pitch: n.pitch + semis }));
export const invert = (ns: MNote[], axis: number) => ns.map((n) => ({ ...n, pitch: 2 * axis - n.pitch }));
export function retrograde(ns: MNote[]): MNote[] {
  if (!ns.length) return [];
  const start = Math.min(...ns.map((n) => n.tick)), end = Math.max(...ns.map((n) => n.tick + n.duration));
  return ns.map((n) => ({ ...n, tick: start + (end - (n.tick + n.duration)) })).sort((a, b) => a.tick - b.tick);
}
export function scaleTime(ns: MNote[], factor: number, origin = ns[0]?.tick ?? 0): MNote[] { // augmentation (>1) / diminution (<1)
  return ns.map((n) => ({ ...n, tick: Math.round(origin + (n.tick - origin) * factor), duration: Math.max(1, Math.round(n.duration * factor)) }));
}
export function sequence(ns: MNote[], times: number, tickOffset: number, semis: number): MNote[] {
  const out: MNote[] = [];
  for (let k = 0; k < times; k++) out.push(...ns.map((n) => ({ ...n, tick: n.tick + k * tickOffset, pitch: n.pitch + k * semis })));
  return out;
}
export function fitRange(ns: MNote[], lo: number, hi: number): MNote[] {
  return ns.map((n) => { let p = n.pitch; while (p < lo) p += 12; while (p > hi) p -= 12; return { ...n, pitch: Math.max(lo, Math.min(hi, p)) }; });
}

export type Motion = "parallel" | "similar" | "contrary" | "oblique" | "static";
export function motion(a1: number, a2: number, b1: number, b2: number): Motion {
  const da = a2 - a1, db = b2 - b1;
  if (!da && !db) return "static";
  if (!da || !db) return "oblique";
  if (Math.sign(da) !== Math.sign(db)) return "contrary";
  return (a2 - b2) === (a1 - b1) ? "parallel" : "similar";
}
const PERFECT = new Set([0, 7]);
/** Parallel perfect 5ths/octaves (incl. compound) between two voices sampled at shared onsets. */
export function parallelPerfects(upper: MNote[], lower: MNote[]): { tick: number; interval: "P5" | "P8" }[] {
  const at = (ns: MNote[], t: number) => ns.find((n) => n.tick <= t && n.tick + n.duration > t)?.pitch;
  const ticks = [...new Set([...upper, ...lower].map((n) => n.tick))].sort((a, b) => a - b);
  const out: { tick: number; interval: "P5" | "P8" }[] = [];
  for (let i = 1; i < ticks.length; i++) {
    const a1 = at(upper, ticks[i - 1]), a2 = at(upper, ticks[i]), b1 = at(lower, ticks[i - 1]), b2 = at(lower, ticks[i]);
    if ([a1, a2, b1, b2].some((x) => x === undefined)) continue;
    const i1 = (a1! - b1!) % 12, i2 = (a2! - b2!) % 12;
    if (PERFECT.has(i1) && i1 === i2 && a1 !== a2 && motion(a1!, a2!, b1!, b2!) !== "contrary") out.push({ tick: ticks[i], interval: i2 === 7 ? "P5" : "P8" });
  }
  return out;
}

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const PCN = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
/** Best-fit chord label for a pitch-class set (e.g. [0,4,7] -> "C major"), used by the score digest.
 * Templates are scored by coverage minus foreign tones; null when fewer than 2 pitch classes or no fit. */
export function estimateChord(pcs: number[]): { root: number; rootName: string; quality: string; label: string } | null {
  const set = new Set(pcs.map((p) => ((p % 12) + 12) % 12));
  if (set.size < 2) return null;
  const templates: { quality: string; intervals: number[] }[] = [
    { quality: "major", intervals: [0, 4, 7] }, { quality: "minor", intervals: [0, 3, 7] },
    { quality: "diminished", intervals: [0, 3, 6] }, { quality: "augmented", intervals: [0, 4, 8] },
    { quality: "dominant 7th", intervals: [0, 4, 7, 10] }, { quality: "major 7th", intervals: [0, 4, 7, 11] },
    { quality: "minor 7th", intervals: [0, 3, 7, 10] }, { quality: "suspended 4th", intervals: [0, 5, 7] },
    { quality: "suspended 2nd", intervals: [0, 2, 7] }, { quality: "power", intervals: [0, 7] },
  ];
  let best: { root: number; quality: string; score: number } | null = null;
  for (let root = 0; root < 12; root++) for (const t of templates) {
    const tones = new Set(t.intervals.map((i) => (root + i) % 12));
    let hit = 0; for (const pc of set) if (tones.has(pc)) hit++;
    if (hit < 3 && hit < tones.size) continue; // a 2-pc set inside a 7th template is not a chord; a complete power chord is
    const score = hit * 2 - (set.size - hit) - (tones.size - hit) * 0.5;
    if (!best || score > best.score) best = { root, quality: t.quality, score };
  }
  if (!best) return null;
  return { root: best.root, rootName: PCN[best.root], quality: best.quality, label: `${PCN[best.root]} ${best.quality}` };
}
/** Resting-tone evidence for a candidate key: how well the tones a passage RESTS on — its longest
 * notes plus its final arrival (lowest voice) — fit the candidate tonic. Profile correlation reads
 * pitch COLLECTION, which leaves a minor key and its relative major nearly tied (a C-minor passage
 * "estimates" as Eb major); but music comes to rest on tonic-triad tones and essentially never on
 * the leading tone, so resting tones anchor the tonic where collection cannot. Returns [-0.5, 1]. */
export function restingAnchor(ns: MNote[], tonic: number, mode: "major" | "minor"): number {
  if (!ns.length) return 0;
  const durs = ns.map((n) => n.duration).sort((a, b) => a - b);
  const med = durs[Math.floor(durs.length / 2)] ?? 0;
  const endMax = Math.max(...ns.map((n) => n.tick + n.duration));
  const fin = ns.filter((n) => n.tick + n.duration === endMax).sort((a, b) => a.pitch - b.pitch)[0];
  const tones: { pc: number; w: number }[] = [];
  if (med > 0) for (const n of ns) if (n.duration >= 2 * med) tones.push({ pc: ((n.pitch % 12) + 12) % 12, w: n.duration });
  if (fin) tones.push({ pc: ((fin.pitch % 12) + 12) % 12, w: fin.duration * 2 });
  if (!tones.length) return 0;
  const stab = (rel: number) => rel === 0 ? 1 : rel === 7 ? 0.7 : rel === (mode === "major" ? 4 : 3) ? 0.7 : rel === 11 ? -0.5 : [2, 5, 8, 9, 10].includes(rel) ? 0.25 : 0;
  const tw = tones.reduce((a, t) => a + t.w, 0) || 1;
  return tones.reduce((a, t) => a + t.w * stab((((t.pc - tonic) % 12) + 12) % 12), 0) / tw;
}
/** Heuristic key estimate (Krumhansl–Schmuckler, duration weighted, resting-tone anchored). */
export function estimateKey(ns: MNote[]): { label: string; tonic: number; mode: "major" | "minor"; confidence: number; method: string } {
  const h = new Array(12).fill(0); for (const n of ns) h[((n.pitch % 12) + 12) % 12] += n.duration;
  const corr = (prof: number[], r: number) => {
    const x = h, y = prof.map((_, i) => prof[(i - r + 12) % 12]);
    const mx = x.reduce((a, b) => a + b, 0) / 12, my = y.reduce((a, b) => a + b, 0) / 12;
    let num = 0, dx = 0, dy = 0; for (let i = 0; i < 12; i++) { num += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
    return dx && dy ? num / Math.sqrt(dx * dy) : 0;
  };
  let best = { tonic: 0, mode: "major" as "major" | "minor", r: -2, score: -Infinity };
  for (let t = 0; t < 12; t++) for (const [mode, prof] of [["major", MAJOR], ["minor", MINOR]] as const) { const r = corr(prof as number[], t); const score = r + 0.3 * restingAnchor(ns, t, mode); if (score > best.score) best = { tonic: t, mode, r, score }; }
  return { label: `${PCN[best.tonic]} ${best.mode}`, tonic: best.tonic, mode: best.mode, confidence: +best.r.toFixed(3), method: "heuristic: Krumhansl-Schmuckler profile correlation + resting-tone anchor" };
}
export function scalePcs(tonic: number, mode: "major" | "minor"): number[] {
  const steps = mode === "major" ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10, 11]; // minor incl. raised 7th
  return steps.map((s) => (tonic + s) % 12);
}

export function analyze(ns: MNote[], ppq: number, ticksPerBar: number) {
  const sorted = [...ns].sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  const pcs = new Array(12).fill(0); for (const n of sorted) pcs[n.pitch % 12]++;
  const span = sorted.length ? Math.max(...sorted.map((n) => n.tick + n.duration)) - sorted[0].tick : 0;
  // melodic intervals on the top line (highest pitch at each onset)
  const top: MNote[] = []; for (const n of sorted) { const l = top[top.length - 1]; if (l && l.tick === n.tick) { if (n.pitch > l.pitch) top[top.length - 1] = n; } else top.push(n); }
  const ints: number[] = []; for (let i = 1; i < top.length; i++) ints.push(top[i].pitch - top[i - 1].pitch);
  const ih: Record<string, number> = {}; for (const i of ints) ih[i] = (ih[i] ?? 0) + 1;
  const motifs = new Map<string, number>(); for (let i = 0; i + 3 <= ints.length; i++) { const k = ints.slice(i, i + 3).join(","); motifs.set(k, (motifs.get(k) ?? 0) + 1); }
  return {
    noteCount: sorted.length,
    pitchRange: sorted.length ? { low: Math.min(...sorted.map((n) => n.pitch)), high: Math.max(...sorted.map((n) => n.pitch)) } : null,
    pitchClassHistogram: Object.fromEntries(PCN.map((n, i) => [n, pcs[i]])),
    key: estimateKey(sorted),
    densityNotesPerBar: span ? +(sorted.length / (span / ticksPerBar)).toFixed(2) : 0,
    averageDurationBeats: sorted.length ? +(sorted.reduce((s, n) => s + n.duration, 0) / sorted.length / ppq).toFixed(3) : 0,
    melodicIntervalHistogram: ih,
    recurringMotifs: [...motifs.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, c]) => ({ intervals: k.split(",").map(Number), count: c })),
  };
}

/** Seeded PRNG (mulberry32). */
export function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Heuristic cadence detection: V–I bass motion (falling 5th / rising 4th) onto a tonic pitch class at a bar line. */
export function cadences(bass: MNote[], tonic: number, ticksPerBar: number) {
  const out: { tick: number; type: "authentic (heuristic)" }[] = [];
  for (let i = 1; i < bass.length; i++) { const d = bass[i].pitch - bass[i - 1].pitch; if ((d === -7 || d === 5) && bass[i].pitch % 12 === tonic && bass[i].tick % ticksPerBar === 0) out.push({ tick: bass[i].tick, type: "authentic (heuristic)" }); }
  return out;
}

export interface CounterpointOpts { lo: number; hi: number; rhythm: 1 | 2 | 3; seed: number; startTick: number; endTick: number; ppq: number; velocity?: number; tonic: number; mode: "major" | "minor"; above?: boolean }
const CONSONANT = new Set([0, 3, 4, 7, 8, 9]);
/** First/second/fourth-species-flavored counterpoint against a cantus (heuristic, deterministic per seed). */
export function counterpoint(cantus: MNote[], o: CounterpointOpts): { notes: MNote[]; score: number; issues: string[] } {
  const r = rng(o.seed);
  const scale = scalePcs(o.tonic, o.mode);
  const sounding = (t: number) => cantus.filter((n) => n.tick <= t && n.tick + n.duration > t).map((n) => n.pitch);
  const slot = o.rhythm === 1 ? o.ppq : o.rhythm === 2 ? o.ppq / 2 : o.ppq / 4;
  const out: MNote[] = []; let prev = Math.round((o.lo + o.hi) / 2); let score = 0; const issues: string[] = [];
  let prevC: number | undefined;
  for (let t = o.startTick; t < o.endTick; t += slot) {
    const cs = sounding(t); const c = cs.length ? (o.above === false ? Math.min(...cs) : Math.max(...cs)) : undefined;
    const strong = (t - o.startTick) % o.ppq === 0;
    let best: { p: number; s: number } | null = null;
    for (let p = o.lo; p <= o.hi; p++) {
      if (!scale.includes(((p % 12) + 12) % 12)) continue;
      let s = -Math.abs(p - prev) * 0.6 + r() * 0.8; // prefer steps; seeded variety
      if (c !== undefined) {
        const iv = Math.abs(p - c) % 12;
        if (CONSONANT.has(iv)) s += strong ? 4 : 1.5; else s -= strong ? 6 : 0.5; // dissonance only as passing on weak slots
        if (o.above !== false ? p <= c : p >= c) s -= 3; // keep voice order
        if (prevC !== undefined) {
          const m = motion(prev, p, prevC, c);
          if (m === "contrary") s += 1.5; else if (m === "oblique") s += 0.5;
          if (PERFECT.has(iv) && PERFECT.has(Math.abs(prev - prevC) % 12) && m !== "contrary" && p !== prev) s -= 8;
        }
      }
      if (Math.abs(p - prev) > 9) s -= 4;
      if (!best || s > best.s) best = { p, s };
    }
    if (!best) continue;
    score += best.s; prev = best.p; prevC = c;
    const last = out[out.length - 1];
    if (last && last.pitch === best.p && o.rhythm === 1 && r() < 0.3) last.duration += slot; // occasional tie
    else out.push({ tick: t, duration: slot, pitch: best.p, velocity: o.velocity ?? 80 });
  }
  const par = parallelPerfects(o.above === false ? cantus : out, o.above === false ? out : cantus);
  if (par.length) issues.push(`${par.length} parallel perfect interval(s) at ticks ${par.slice(0, 5).map((x) => x.tick).join(", ")}`);
  return { notes: out, score: +(score / Math.max(1, out.length) - par.length).toFixed(3), issues };
}
