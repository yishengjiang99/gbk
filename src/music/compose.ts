// Rule-based, seeded composition strategies and primitives. Everything returns real MIDI notes / CC points.
// Not a trained model: explicit rules (Bach generator for baroque counterpoint, diatonic progressions, chord-tone
// melodies, root/fifth bass, GM drum grids). Higher-level musical decisions are left to the calling agent.
import { generateBachMidi, type BachKey } from "../bach-generator.ts";
import { counterpoint, fitRange, invert, parallelPerfects, retrograde, rng, scalePcs, sequence, transpose, type MNote } from "./theory.ts";
import type { KeyInfo } from "./keys.ts";

export type Rand = () => number;
export interface Span { startTick: number; endTick: number }

// ---- instruments -----------------------------------------------------------------------------------------
export interface InstrumentSpec { name: string; program: number; lo: number; hi: number; role: "melody" | "harmony" | "bass" | "accompaniment" | "percussion" | "counterpoint"; family: "strings" | "keys" | "winds" | "brass" | "plucked" | "drums" | "voice"; pan: number }
export const INSTRUMENTS: Record<string, InstrumentSpec> = {
  violin: { name: "Violin", program: 40, lo: 55, hi: 96, role: "melody", family: "strings", pan: 40 },
  viola: { name: "Viola", program: 41, lo: 48, hi: 84, role: "harmony", family: "strings", pan: 56 },
  cello: { name: "Cello", program: 42, lo: 36, hi: 72, role: "bass", family: "strings", pan: 84 },
  contrabass: { name: "Contrabass", program: 43, lo: 28, hi: 60, role: "bass", family: "strings", pan: 72 },
  strings: { name: "Strings", program: 48, lo: 36, hi: 96, role: "harmony", family: "strings", pan: 64 },
  harpsichord: { name: "Harpsichord", program: 6, lo: 29, hi: 89, role: "accompaniment", family: "keys", pan: 64 },
  piano: { name: "Piano", program: 0, lo: 21, hi: 108, role: "accompaniment", family: "keys", pan: 64 },
  organ: { name: "Organ", program: 19, lo: 36, hi: 96, role: "accompaniment", family: "keys", pan: 64 },
  flute: { name: "Flute", program: 73, lo: 60, hi: 96, role: "melody", family: "winds", pan: 52 },
  oboe: { name: "Oboe", program: 68, lo: 58, hi: 91, role: "melody", family: "winds", pan: 58 },
  clarinet: { name: "Clarinet", program: 71, lo: 50, hi: 91, role: "harmony", family: "winds", pan: 70 },
  bassoon: { name: "Bassoon", program: 70, lo: 34, hi: 72, role: "bass", family: "winds", pan: 76 },
  horn: { name: "Horn", program: 60, lo: 41, hi: 77, role: "harmony", family: "brass", pan: 70 },
  trumpet: { name: "Trumpet", program: 56, lo: 55, hi: 82, role: "melody", family: "brass", pan: 60 },
  guitar: { name: "Guitar", program: 24, lo: 40, hi: 84, role: "accompaniment", family: "plucked", pan: 50 },
  bass: { name: "Bass", program: 32, lo: 28, hi: 55, role: "bass", family: "plucked", pan: 64 },
  choir: { name: "Choir", program: 52, lo: 48, hi: 81, role: "harmony", family: "voice", pan: 64 },
  drums: { name: "Drums", program: 0, lo: 35, hi: 81, role: "percussion", family: "drums", pan: 64 },
};
export function instrumentSpec(name: string): InstrumentSpec {
  const k = name.toLowerCase().replace(/s$/, "").replace(/[^a-z]/g, "");
  return INSTRUMENTS[k] ?? INSTRUMENTS[name.toLowerCase()] ?? { name, program: 0, lo: 36, hi: 96, role: "harmony", family: "keys", pan: 64 };
}

// ---- harmony ----------------------------------------------------------------------------------------------
const DEG_MAJOR = [0, 2, 4, 5, 7, 9, 11], DEG_MINOR = [0, 2, 3, 5, 7, 8, 10];
/** Diatonic triad (pitch classes) on scale degree 1..7; minor-key V and vii use the raised leading tone. */
export function triad(key: KeyInfo, degree: number): number[] {
  const sc = key.mode === "major" ? DEG_MAJOR : DEG_MINOR;
  const d = (degree - 1) % 7;
  const pcs = [0, 2, 4].map((k) => (key.tonic + sc[(d + k) % 7]) % 12);
  if (key.mode === "minor" && (degree === 5 || degree === 7)) { const lt = (key.tonic + 11) % 12, sub = (key.tonic + 10) % 12; return pcs.map((p) => (p === sub ? lt : p)); }
  return pcs;
}
const PROGRESSIONS: Record<string, number[][]> = {
  baroque: [[1, 4, 5, 1], [1, 6, 2, 5], [1, 4, 7, 3], [6, 2, 5, 1]],
  classical: [[1, 4, 5, 1], [1, 2, 5, 1], [1, 6, 4, 5], [4, 5, 3, 6]],
  pop: [[1, 5, 6, 4], [6, 4, 1, 5], [1, 6, 4, 5], [4, 1, 5, 6]],
  jazz: [[2, 5, 1, 6], [1, 6, 2, 5], [3, 6, 2, 5]],
};
/** One chord degree per bar; phrases of 4 bars end with a cadence (V-I) at section ends. */
export function chordProgression(bars: number, style: string, r: Rand, cadenceBars: Set<number> = new Set()): number[] {
  const pool = PROGRESSIONS[style] ?? PROGRESSIONS.classical;
  const out: number[] = [];
  for (let b = 0; b < bars; b += 4) out.push(...pool[Math.floor(r() * pool.length)]);
  out.length = bars;
  for (const cb of cadenceBars) if (cb >= 1 && cb < bars) { out[cb - 1] = 5; out[cb] = 1; }
  if (bars >= 2) { out[bars - 2] = 5; out[bars - 1] = 1; }
  return out;
}
const near = (pcs: number[], target: number, lo: number, hi: number) => {
  let best = target, bd = 1e9;
  for (let p = lo; p <= hi; p++) if (pcs.includes(((p % 12) + 12) % 12) && Math.abs(p - target) < bd) { bd = Math.abs(p - target); best = p; }
  return best;
};

export interface BarGrid { tick: number; length: number; beats: number; beatTicks: number }

/** Melody from chord tones on strong beats + stepwise passing tones, phrase arcs, seeded. */
export function melody(grid: BarGrid[], chords: number[], key: KeyInfo, lo: number, hi: number, r: Rand, density = 2): MNote[] {
  const sc = scalePcs(key.tonic, key.mode); const out: MNote[] = []; let prev = Math.round((lo + hi) / 2);
  grid.forEach((g, bi) => {
    const ch = triad(key, chords[bi]); const step = g.beatTicks / density;
    const phrasePos = (bi % 4) / 3; const contour = Math.round(Math.sin(phrasePos * Math.PI) * 5);
    for (let t = 0; t < g.length; t += step) {
      const strong = t % g.beatTicks === 0;
      if (!strong && r() < 0.25) continue; // rests / longer values
      const target = prev + (r() < 0.5 ? -2 : 2) + Math.round((contour - (prev - (lo + hi) / 2) / 4) * 0.3);
      let p = strong ? near(ch, target, lo, hi) : near(sc, target, lo, hi);
      if (p === prev && r() < 0.7) p = near(sc, p + (r() < 0.5 ? 1 : -1) * 2, lo, hi);
      out.push({ tick: g.tick + t, duration: step, pitch: p, velocity: strong ? 84 : 72 });
      prev = p;
    }
  });
  // extend notes into following rests
  for (let i = 0; i < out.length - 1; i++) out[i].duration = Math.min(out[i + 1].tick - out[i].tick, out[i].duration * 2);
  return out;
}

export function bassLine(grid: BarGrid[], chords: number[], key: KeyInfo, lo: number, hi: number, r: Rand, pattern: "roots" | "walking" | "root-fifth" = "root-fifth"): MNote[] {
  const out: MNote[] = []; let prev = Math.round(lo + (hi - lo) * 0.35);
  const sc = scalePcs(key.tonic, key.mode);
  grid.forEach((g, bi) => {
    const ch = triad(key, chords[bi]); const nextRoot = triad(key, chords[bi + 1] ?? chords[bi])[0];
    for (let b = 0; b < g.beats; b++) {
      let pc: number[];
      if (pattern === "roots" || b === 0) pc = [ch[0]];
      else if (pattern === "root-fifth") pc = b % 2 ? [ch[2]] : [ch[0]];
      else pc = b === g.beats - 1 ? [(nextRoot + 11) % 12, (nextRoot + 1) % 12, (nextRoot + 2) % 12].filter((x) => sc.includes(x)) : ch;
      if (!pc.length) pc = [ch[0]];
      const p = near(pc, prev + (r() < 0.5 ? -1 : 1), lo, hi);
      out.push({ tick: g.tick + b * g.beatTicks, duration: g.beatTicks, pitch: p, velocity: b === 0 ? 88 : 76 });
      prev = p;
    }
  });
  return out;
}

/** Block / arpeggiated accompaniment from the chord of each bar (close position, smooth voice leading). */
export function accompaniment(grid: BarGrid[], chords: number[], key: KeyInfo, lo: number, hi: number, r: Rand, style: "block" | "arpeggio" | "alberti" = "block"): MNote[] {
  const out: MNote[] = []; let center = Math.round((lo + hi) / 2);
  grid.forEach((g, bi) => {
    const pcs = triad(key, chords[bi]);
    const voicing = pcs.map((pc) => near([pc], center, lo, hi)).sort((a, b) => a - b);
    center = voicing[1];
    if (style === "block") {
      const hits = g.beats % 3 === 0 ? [0, 3].filter((b) => b < g.beats) : [0, 2].filter((b) => b < g.beats);
      hits.forEach((b, i) => { for (const p of voicing) out.push({ tick: g.tick + b * g.beatTicks, duration: Math.round(g.beatTicks * (i === hits.length - 1 ? g.beats - b : hits[i + 1] - b) * 0.92), pitch: p, velocity: b === 0 ? 70 : 62 }); });
    } else {
      const order = style === "alberti" ? [0, 2, 1, 2] : [0, 1, 2, 1];
      const step = g.beatTicks / 2;
      for (let k = 0; k * step < g.length; k++) out.push({ tick: g.tick + k * step, duration: step, pitch: voicing[order[k % 4]], velocity: k % 2 ? 58 : 66 });
    }
  });
  return out;
}

/** GM drum grid: kick 36, snare 38, closed hat 42, open hat 46, crash 49. */
export function drumPattern(grid: BarGrid[], r: Rand, style: "rock" | "pop" | "march" | "waltz" = "pop", energy: (bar: number) => number = () => 0.6): MNote[] {
  const out: MNote[] = [];
  grid.forEach((g, bi) => {
    const e = energy(bi);
    const sub = g.beatTicks / 2;
    for (let k = 0; k < g.beats * 2; k++) {
      const t = g.tick + k * sub; const beat = k / 2;
      if (k % 2 === 0 && (beat === 0 || (style !== "waltz" && beat === Math.floor(g.beats / 2) + (g.beats % 2 ? 0 : 0) && style === "rock"))) out.push({ tick: t, duration: sub, pitch: 36, velocity: 100 });
      if (style !== "waltz" && k % 2 === 0 && beat % 2 === 1) out.push({ tick: t, duration: sub, pitch: 38, velocity: 92 });
      if (style === "waltz" && k % 2 === 0 && beat > 0) out.push({ tick: t, duration: sub, pitch: 42, velocity: 70 });
      if (style !== "waltz" && (e > 0.4 || k % 2 === 0)) out.push({ tick: t, duration: sub, pitch: e > 0.85 && k % 4 === 3 ? 46 : 42, velocity: k % 2 ? 58 : 74 });
      if (k === 1 && r() < 0.15 * e) out.push({ tick: t, duration: sub, pitch: 36, velocity: 80 });
    }
    if (bi % 8 === 0 && e > 0.5) out.push({ tick: g.tick, duration: g.beatTicks * 2, pitch: 49, velocity: 96 });
  });
  return out;
}

// ---- transforms -------------------------------------------------------------------------------------------
export function quantize(ns: MNote[], grid: number, strength = 1): MNote[] {
  return ns.map((n) => { const q = Math.round(n.tick / grid) * grid; return { ...n, tick: Math.round(n.tick + (q - n.tick) * strength), duration: Math.max(1, Math.round(n.duration / grid) * grid || grid) }; });
}
export function humanize(ns: MNote[], r: Rand, velocity = 6, timing = 0): MNote[] {
  return ns.map((n) => ({ ...n, velocity: Math.max(1, Math.min(127, Math.round(n.velocity + (r() * 2 - 1) * velocity))), tick: Math.max(0, n.tick + Math.round((r() * 2 - 1) * timing)) }));
}
export function articulate(ns: MNote[], kind: "legato" | "detache" | "staccato" | "tenuto" | "marcato"): MNote[] {
  const f = { legato: 1.02, detache: 0.88, staccato: 0.45, tenuto: 1, marcato: 0.75 }[kind];
  const accent = kind === "marcato" ? 12 : 0;
  return ns.map((n) => ({ ...n, duration: Math.max(1, Math.round(n.duration * f)), velocity: Math.min(127, n.velocity + accent) }));
}
/** Velocity arc over each phrase (rise to 60 % then fall), scaled by energy. */
export function phraseDynamics(ns: MNote[], phraseTicks: number, depth = 14, start = 0): MNote[] {
  return ns.map((n) => { const x = ((n.tick - start) % phraseTicks) / phraseTicks; const arc = x < 0.6 ? x / 0.6 : (1 - x) / 0.4; return { ...n, velocity: Math.max(1, Math.min(127, Math.round(n.velocity - depth / 2 + arc * depth))) }; });
}
/** Variation: ornament (neighbor tones), rhythmic diminution of long notes, or melodic inversion of intervals. */
export function variation(ns: MNote[], key: KeyInfo, r: Rand, kind: "ornament" | "diminution" | "inversion" = "ornament"): MNote[] {
  const sc = scalePcs(key.tonic, key.mode);
  const up = (p: number) => { for (let k = 1; k < 4; k++) if (sc.includes((p + k) % 12)) return p + k; return p + 2; };
  if (kind === "inversion" && ns.length) return invert(ns, ns[0].pitch).map((n) => ({ ...n, pitch: near(sc, n.pitch, n.pitch - 1, n.pitch + 1) }));
  const out: MNote[] = [];
  for (const n of ns) {
    if (kind === "diminution" && n.duration >= 480 && r() < 0.7) { const h = Math.round(n.duration / 2); out.push({ ...n, duration: h }, { ...n, tick: n.tick + h, duration: n.duration - h, pitch: up(n.pitch) }); }
    else if (kind === "ornament" && n.duration >= 240 && r() < 0.35) { const q = Math.round(n.duration / 4); out.push({ ...n, duration: q }, { ...n, tick: n.tick + q, duration: q, pitch: up(n.pitch), velocity: n.velocity - 8 }, { ...n, tick: n.tick + 2 * q, duration: n.duration - 2 * q }); }
    else out.push(n);
  }
  return out;
}
export { transpose, invert, retrograde, sequence, fitRange, counterpoint };

// ---- quality metrics --------------------------------------------------------------------------------------
export function voiceMetrics(voices: MNote[][]) {
  let crossings = 0, parallels = 0, repeated = 0, total = 0;
  for (let i = 0; i + 1 < voices.length; i++) {
    parallels += parallelPerfects(voices[i], voices[i + 1]).length;
    const lower = voices[i + 1];
    for (const n of voices[i]) { const l = lower.find((x) => x.tick <= n.tick && x.tick + x.duration > n.tick); if (l && l.pitch > n.pitch) crossings++; }
  }
  for (const v of voices) for (let i = 1; i < v.length; i++) { total++; if (v[i].pitch === v[i - 1].pitch) repeated++; }
  return { parallelPerfects: parallels, voiceCrossings: crossings, repeatedNoteRatio: total ? +(repeated / total).toFixed(3) : 0 };
}

// ---- baroque strategy (Bach generator) --------------------------------------------------------------------
const BACH_MINOR: BachKey[] = ["A minor", "E minor", "D minor", "G minor"]; const BACH_MAJOR: BachKey[] = ["C", "G", "D", "A", "E", "F", "Bb", "Eb"];
const KEY_PC: Record<string, number> = { C: 0, G: 7, D: 2, A: 9, E: 4, F: 5, Bb: 10, Eb: 3, "A minor": 9, "E minor": 4, "D minor": 2, "G minor": 7 };

/**
 * Baroque counterpoint from GBK's Bach fugue generator (seeded): generated in the nearest supported key and
 * transposed; tiled to the requested length with sequential transposition (tonic, relative, dominant), with
 * the generator's own cadential ending aligned to the final bar. Returns `voices` lines high -> low, in quarter
 * = ppq ticks starting at 0.
 */
export function baroqueVoices(key: KeyInfo, totalTicks: number, ppq: number, voices: 3 | 4, complexity: 1 | 2 | 3 | 4 | 5, seed: number): { lines: MNote[][]; analysis: string[] } {
  const pool = key.mode === "minor" ? BACH_MINOR : BACH_MAJOR;
  let src = pool[0], bestD = 99;
  for (const k of pool) { const d = Math.min((KEY_PC[k] - key.tonic + 12) % 12, (key.tonic - KEY_PC[k] + 12) % 12); if (d < bestD) { bestD = d; src = k; } }
  let shift = (key.tonic - KEY_PC[src] + 12) % 12; if (shift > 6) shift -= 12;
  const g = generateBachMidi({ key: src, voices, complexity, seed, length: "short", tempo: 100, attempts: 1 });
  const piece = g.piece;
  const spanBeats = Math.max(...piece.notes.map((n) => n.startBeat + n.durBeat));
  const spanTicks = Math.round(spanBeats * ppq);
  const toNotes = (beatOffset: number, semis: number, fromBeat = 0) => piece.notes.filter((n) => n.startBeat >= fromBeat).map((n) => ({ voice: n.voice, tick: Math.round((n.startBeat - fromBeat + beatOffset) * ppq), duration: Math.max(1, Math.round(n.durBeat * ppq)), pitch: n.midi + shift + semis, velocity: 80 }));
  const all: (MNote & { voice: number })[] = [];
  const plan = key.mode === "minor" ? [0, 3, 7, -2] : [0, 7, -3, 5];
  const analysis = [`fugue material: GBK Bach generator, seed ${seed}, ${voices} voices, generated in ${src} and transposed ${shift >= 0 ? "+" : ""}${shift}`];
  const totalBeats = totalTicks / ppq;
  if (spanBeats >= totalBeats) {
    all.push(...toNotes(0, 0, spanBeats - totalBeats));
  } else {
    let beat = 0, k = 0;
    while (totalBeats - beat > spanBeats) { const s = plan[k % plan.length]; all.push(...toNotes(beat, s).filter((n) => n.tick < totalTicks)); analysis.push(`statement ${k + 1} at beat ${beat} transposed ${s >= 0 ? "+" : ""}${s}`); beat += spanBeats; k++; if (k > 64) break; }
    const rem = totalBeats - beat;
    all.push(...toNotes(beat, 0, spanBeats - rem));
    analysis.push(`closing statement: final ${rem} beats of the fugue (its cadence) aligned to the last bar`);
  }
  const lines: MNote[][] = Array.from({ length: voices }, () => []);
  for (const n of all) if (n.tick >= 0 && n.tick < totalTicks) lines[n.voice].push({ tick: n.tick, duration: Math.min(n.duration, totalTicks - n.tick), pitch: n.pitch, velocity: n.velocity });
  for (const l of lines) l.sort((a, b) => a.tick - b.tick);
  lines.sort((a, b) => avg(b) - avg(a));
  void spanTicks;
  return { lines, analysis };
}
const avg = (ns: MNote[]) => (ns.length ? ns.reduce((s, n) => s + n.pitch, 0) / ns.length : 0);

/** Shift a whole line by octaves so its median sits inside [lo, hi], then fold outliers by octave. */
export function placeInRange(ns: MNote[], lo: number, hi: number): MNote[] {
  if (!ns.length) return ns;
  const med = [...ns].map((n) => n.pitch).sort((a, b) => a - b)[ns.length >> 1];
  const mid = (lo + hi) / 2; const oct = Math.round((mid - med) / 12) * 12;
  return fitRange(transpose(ns, oct), lo, hi);
}

/** Continuo realization: a close-position chord per half bar from the pitch classes sounding in the lines. */
export function continuo(lines: MNote[][], grid: BarGrid[], key: KeyInfo, lo: number, hi: number): MNote[] {
  const out: MNote[] = []; let center = Math.round((lo + hi) / 2);
  const sounding = (t: number) => lines.flatMap((l) => l.filter((n) => n.tick <= t && n.tick + n.duration > t).map((n) => n.pitch));
  for (const g of grid) {
    const halves = g.beats % 3 === 0 && g.beats > 3 ? 2 : g.beats >= 4 ? 2 : 1;
    const hl = Math.round(g.length / halves);
    for (let h = 0; h < halves; h++) {
      const t = g.tick + h * hl; const ps = sounding(t + 1);
      const bass = ps.length ? Math.min(...ps) : null;
      let pcs = [...new Set(ps.map((p) => p % 12))];
      if (pcs.length < 2 && bass !== null) { const deg = DEG_MINOR.concat(DEG_MAJOR); void deg; pcs = triad(key, 1 + [0, 2, 4, 5, 7, 9, 11].indexOf(((bass % 12) - key.tonic + 12) % 12) || 1); }
      if (!pcs.length) continue;
      const chord = pcs.slice(0, 3).map((pc) => near([pc], center, lo, hi)).sort((a, b) => a - b);
      center = chord[Math.floor(chord.length / 2)];
      for (const p of [...new Set(chord)]) out.push({ tick: t, duration: Math.round(hl * 0.9), pitch: p, velocity: h === 0 ? 68 : 60 });
    }
  }
  return out;
}

export { rng };
