// Deterministic arrangement generator: project + plan -> real note / CC ops (thousands of notes, applied as one
// transaction). Strategies: "baroque" (Bach fugue generator + continuo) and chord-based "classical" / "pop" /
// "jazz" / "ambient" (progression + melody + bass + accompaniment + drums). New strategies plug in via STRATEGIES.
import type { Project, Section, Track } from "../workstation/model.ts";
import type { Op } from "../workstation/ops.ts";
import { bars as barList, barBeatToTick, tickToSec } from "../workstation/timing.ts";
import type { KeyInfo } from "./keys.ts";
import {
  accompaniment, articulate, baroqueVoices, bassLine, chordProgression, continuo, counterpoint, drumPattern, humanize, instrumentSpec, melody,
  phraseDynamics, placeInRange, rng, voiceMetrics, type BarGrid, type InstrumentSpec, type Rand,
} from "./compose.ts";
import type { MNote } from "./theory.ts";

export interface ArrangementPlan {
  style: string; key: KeyInfo; bars: number; seed: number; voices: 3 | 4; complexity: 1 | 2 | 3 | 4 | 5;
  features: { counterpoint: boolean; dynamicExpression: boolean; articulation: boolean; cadences: boolean };
}
export interface Assigned { track: Track; spec: InstrumentSpec }
export interface ArrangementResult { ops: Op[]; perTrack: { trackId: string; name: string; notes: number; ccs: number; range: [number, number] | null }[]; metrics: ReturnType<typeof voiceMetrics>; analysis: string[]; sections: Section[]; totalNotes: number; totalCcs: number; durationSec: number }

export function defaultSections(bars: number): Section[] {
  if (bars < 8) return [{ name: "Theme", startBar: 1, bars, energy: 0.6 }];
  const intro = Math.max(2, Math.round(bars / 6 / 2) * 2), coda = Math.max(2, Math.round(bars / 6 / 2) * 2);
  const mid = bars - intro - coda; const theme = Math.round(mid / 2 / 2) * 2;
  return [
    { name: "Introduction", startBar: 1, bars: intro, energy: 0.35 }, { name: "Theme", startBar: 1 + intro, bars: theme, energy: 0.65 },
    { name: "Development", startBar: 1 + intro + theme, bars: mid - theme, energy: 0.9 }, { name: "Coda", startBar: 1 + intro + mid, bars: coda, energy: 0.5 },
  ];
}

export function barGrid(p: Pick<Project, "timeSigs" | "ppq">, n: number): BarGrid[] {
  return barList(p, barBeatToTick(p, n + 1) - 1).slice(0, n).map((b) => ({ tick: b.tick, length: b.length, beats: b.numerator, beatTicks: b.ticksPerBeat }));
}

const sustaining = (s: InstrumentSpec) => ["strings", "winds", "brass", "voice"].includes(s.family);

type Strategy = (p: Project, plan: ArrangementPlan, parts: Assigned[], grid: BarGrid[], r: Rand, energyAt: (bar: number) => number, analysis: string[]) => Map<string, MNote[]>;

const baroque: Strategy = (p, plan, parts, grid, _r, _e, analysis) => {
  const total = grid.length ? grid[grid.length - 1].tick + grid[grid.length - 1].length : 0;
  const out = new Map<string, MNote[]>();
  const lineParts = parts.filter((a) => a.spec.family !== "keys" && a.spec.family !== "drums").sort((a, b) => (b.spec.lo + b.spec.hi) - (a.spec.lo + a.spec.hi));
  const keys = parts.filter((a) => a.spec.family === "keys");
  const nVoices = plan.voices;
  const { lines, analysis: an } = baroqueVoices(plan.key, total, p.ppq, nVoices, plan.complexity, plan.seed);
  analysis.push(...an);
  // Assign lines high -> low to sustaining instruments; the bass line always goes to the lowest one.
  const used = new Set<number>();
  lineParts.forEach((a, i) => {
    const li = i === lineParts.length - 1 ? lines.length - 1 : Math.min(i, lines.length - 2);
    used.add(li);
    out.set(a.track.id, placeInRange(lines[li], a.spec.lo, a.spec.hi));
  });
  for (const k of keys) {
    const inner = lines.map((_, i) => i).filter((i) => !used.has(i));
    const rh = inner.length ? placeInRange(lines[inner[0]], 60, 79) : [];
    if (inner.length) used.add(inner[0]);
    const lh = lineParts.length ? [] : placeInRange(lines[lines.length - 1], k.spec.lo, 55);
    const cont = continuo(lines, grid, plan.key, 50, 67);
    out.set(k.track.id, [...rh, ...lh, ...cont]);
    analysis.push(`${k.track.name}: continuo realization (chords from the sounding voices)${rh.length ? " + inner fugue voice" : ""}`);
  }
  for (const d of parts.filter((a) => a.spec.family === "drums")) out.set(d.track.id, drumPattern(grid, _r, "march", _e));
  return out;
};

const chordBased = (flavor: "classical" | "pop" | "jazz" | "ambient"): Strategy => (p, plan, parts, grid, r, energyAt, analysis) => {
  const cad = new Set<number>(); for (const s of (p.meta?.sections ?? [])) cad.add(s.startBar - 1 + s.bars - 1);
  const chords = chordProgression(grid.length, flavor === "ambient" ? "classical" : flavor, r, plan.features.cadences ? cad : new Set());
  analysis.push(`progression (scale degrees per bar): ${chords.slice(0, 16).join(" ")}${chords.length > 16 ? " ..." : ""}`);
  const out = new Map<string, MNote[]>(); let lead: MNote[] | null = null;
  const order = [...parts].sort((a, b) => ["melody", "bass", "harmony", "counterpoint", "accompaniment", "percussion"].indexOf(a.spec.role) - ["melody", "bass", "harmony", "counterpoint", "accompaniment", "percussion"].indexOf(b.spec.role));
  for (const a of order) {
    const role = a.track.role ?? a.spec.role; const { lo, hi } = a.spec;
    let ns: MNote[];
    if (role === "percussion") ns = drumPattern(grid, r, flavor === "pop" ? "pop" : "rock", energyAt);
    else if (role === "bass") ns = bassLine(grid, chords, plan.key, lo, Math.min(hi, 60), r, flavor === "jazz" ? "walking" : flavor === "pop" ? "roots" : "root-fifth");
    else if (role === "melody" && !lead) { ns = melody(grid, chords, plan.key, Math.max(lo, 60), Math.min(hi, 88), r, flavor === "ambient" ? 1 : 2); lead = ns; }
    else if ((role === "counterpoint" || (role === "melody" && lead)) && lead && plan.features.counterpoint) {
      const total = grid[grid.length - 1].tick + grid[grid.length - 1].length;
      ns = counterpoint(lead, { lo: Math.max(lo, 48), hi: Math.min(hi, 76), rhythm: 1, seed: plan.seed + 7, startTick: 0, endTick: total, ppq: p.ppq, tonic: plan.key.tonic, mode: plan.key.mode, above: false }).notes;
    } else ns = accompaniment(grid, chords, plan.key, Math.max(lo, 48), Math.min(hi, 76), r, flavor === "ambient" || sustaining(a.spec) ? "block" : flavor === "classical" ? "alberti" : "arpeggio");
    out.set(a.track.id, ns);
  }
  return out;
};

export const STRATEGIES: Record<string, Strategy> = { baroque, classical: chordBased("classical"), pop: chordBased("pop"), jazz: chordBased("jazz"), ambient: chordBased("ambient") };

export function generateArrangement(p: Project, plan: ArrangementPlan, parts: Assigned[]): ArrangementResult {
  const strategy = STRATEGIES[plan.style];
  if (!strategy) throw new Error(`unknown style ${plan.style}`);
  const r = rng(plan.seed);
  const grid = barGrid(p, plan.bars);
  const sections = p.meta?.sections?.length ? p.meta.sections : defaultSections(plan.bars);
  const energyAt = (bar0: number) => sections.find((s) => bar0 + 1 >= s.startBar && bar0 + 1 < s.startBar + s.bars)?.energy ?? 0.6;
  const barOf = (tick: number) => { let lo = 0, hi = grid.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (grid[m].tick <= tick) lo = m; else hi = m - 1; } return lo; };
  const analysis: string[] = [];
  const raw = strategy(p, plan, parts, grid, r, energyAt, analysis);
  const ops: Op[] = []; const perTrack: ArrangementResult["perTrack"] = [];
  const total = grid.length ? grid[grid.length - 1].tick + grid[grid.length - 1].length : 0;
  const phrase = grid.length >= 4 ? grid[3].tick + grid[3].length - grid[0].tick : total || 1;
  let totalNotes = 0, totalCcs = 0;
  for (const a of parts) {
    let ns = (raw.get(a.track.id) ?? []).filter((n) => n.tick >= 0 && n.tick < total);
    // Dynamics: section energy scales velocity; phrase arcs; seeded humanization; articulation per family.
    ns = ns.map((n) => ({ ...n, velocity: Math.round(n.velocity * (0.72 + 0.4 * energyAt(barOf(n.tick)))) }));
    if (plan.features.dynamicExpression) ns = phraseDynamics(ns, phrase, 12);
    ns = humanize(ns, r, 5, 0);
    if (plan.features.articulation && a.spec.family !== "drums") ns = articulate(ns, a.spec.family === "keys" ? "tenuto" : plan.style === "baroque" ? "detache" : "legato");
    ns = ns.map((n) => ({ ...n, pitch: Math.max(0, Math.min(127, n.pitch)), velocity: Math.max(1, Math.min(127, n.velocity)), duration: Math.max(1, Math.min(n.duration, total - n.tick)) }));
    totalNotes += ns.length;
    ops.push({ op: "addNotes", notes: ns.map((n) => ({ trackId: a.track.id, channel: a.track.channel, tick: n.tick, duration: n.duration, pitch: n.pitch, velocity: n.velocity })) });
    let ccs = 0;
    if (plan.features.dynamicExpression && a.spec.family !== "drums" && total > 0) {
      const pts: { tick: number; value: number }[] = [];
      const step = sustaining(a.spec) ? Math.round(p.ppq / 2) : grid[0]?.length ?? p.ppq * 4;
      for (let t = 0; t < total; t += step) {
        const b = barOf(t); const x = ((t - grid[0].tick) % phrase) / phrase; const arc = Math.sin(Math.PI * x);
        pts.push({ tick: t, value: Math.max(30, Math.min(127, Math.round(48 + energyAt(b) * 62 + (sustaining(a.spec) ? arc * 14 : 0)))) });
      }
      pts.push({ tick: total, value: pts[pts.length - 1]?.value ?? 100 });
      ops.push({ op: "setCC", trackId: a.track.id, channel: a.track.channel, controller: 11, startTick: 0, endTick: total, mode: "replace", points: pts });
      ccs += pts.length;
      if (a.spec.family === "strings" || a.spec.family === "voice") {
        const mod = grid.map((g, i) => ({ tick: g.tick, value: Math.round(18 + energyAt(i) * 34) }));
        ops.push({ op: "setCC", trackId: a.track.id, channel: a.track.channel, controller: 1, startTick: 0, endTick: total, mode: "replace", points: mod });
        ccs += mod.length;
      }
    }
    ops.push({ op: "setCC", trackId: a.track.id, channel: a.track.channel, controller: 91, startTick: 0, endTick: 0, mode: "replace", points: [{ tick: 0, value: a.spec.family === "drums" ? 30 : 52 }] });
    ccs += 1; totalCcs += ccs;
    perTrack.push({ trackId: a.track.id, name: a.track.name, notes: ns.length, ccs, range: ns.length ? [Math.min(...ns.map((n) => n.pitch)), Math.max(...ns.map((n) => n.pitch))] : null });
  }
  const lines = parts.filter((a) => sustaining(a.spec)).map((a) => raw.get(a.track.id) ?? []);
  return { ops, perTrack, metrics: voiceMetrics(lines), analysis, sections, totalNotes, totalCcs, durationSec: +tickToSec(p, total).toFixed(3) };
}
export { instrumentSpec };
