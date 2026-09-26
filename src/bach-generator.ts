export type BachKey =
  | "C"
  | "G"
  | "D"
  | "A"
  | "E"
  | "F"
  | "Bb"
  | "Eb"
  | "A minor"
  | "E minor"
  | "D minor"
  | "G minor";

export type BachLength = "short" | "medium" | "long";

export type BachCharacter =
  | "severe ricercar"
  | "compact fugue"
  | "lively fughetta"
  | "stretto-driven fugue"
  | "toccata + fugue hybrid";

export interface BachFugueConfig {
  key: BachKey;
  length: BachLength;
  voices: 3 | 4;
  character: BachCharacter;
  complexity: 1 | 2 | 3 | 4 | 5;
  tempo: number;
  seed: number;
}

interface KeyContext {
  key: BachKey;
  tonicPc: number;
  mode: "major" | "minor";
  scale: number[];
}

interface FugueNote {
  voice: number;
  midi: number;
  startBeat: number;
  durBeat: number;
  role: string;
  section?: string;
}

interface HarmonicPlanMeasure {
  measure: number;
  fn: "T" | "PD" | "D" | "CAD";
  region: string;
}

interface FugueScore {
  score: number;
  par: {
    p5: number;
    p8: number;
    contrary: number;
    totalMotion: number;
    unisons: number;
    overlaps: number;
  };
  leaps: number;
  cad: number;
  harm: number;
  subj: number;
}

export interface BachPiece {
  notes: FugueNote[];
  totalBeats: number;
  analysis: string[];
  subject: FugueNote[];
  countersubject: FugueNote[];
  plan: HarmonicPlanMeasure[];
  score: FugueScore;
  ctx: KeyContext;
}

export interface GeneratedBachMidi {
  midiData: ArrayBuffer;
  fileName: string;
  seed: number;
  piece: BachPiece;
  config: BachFugueConfig;
}

const KEY_TO_PC: Record<BachKey, number> = {
  C: 0,
  G: 7,
  D: 2,
  A: 9,
  E: 4,
  F: 5,
  Bb: 10,
  Eb: 3,
  "A minor": 9,
  "E minor": 4,
  "D minor": 2,
  "G minor": 7,
};

const SCALES: Record<"major" | "minor", number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

const DEFAULT_CONFIG: BachFugueConfig = {
  key: "C",
  length: "medium",
  voices: 4,
  character: "compact fugue",
  complexity: 3,
  tempo: 92,
  seed: 0,
};

export const BACH_KEY_OPTIONS: BachKey[] = ["C", "G", "D", "A", "E", "F", "Bb", "Eb", "A minor", "E minor", "D minor", "G minor"];
export const BACH_LENGTH_OPTIONS: BachLength[] = ["short", "medium", "long"];
export const BACH_VOICE_OPTIONS: Array<3 | 4> = [3, 4];
export const BACH_CHARACTER_OPTIONS: BachCharacter[] = [
  "severe ricercar",
  "compact fugue",
  "lively fughetta",
  "stretto-driven fugue",
  "toccata + fugue hybrid",
];
export const BACH_COMPLEXITY_OPTIONS: Array<1 | 2 | 3 | 4 | 5> = [1, 2, 3, 4, 5];
export const BACH_TEMPO_OPTIONS = [78, 92, 108, 126] as const;
export const DEFAULT_BACH_CONFIG: BachFugueConfig = { ...DEFAULT_CONFIG };

const VOICE_NAMES = ["Soprano", "Alto", "Tenor", "Bass"];
const DEFAULT_PROGRAM = 6; // General MIDI harpsichord, zero-indexed for MIDI program change bytes.
const TICKS_PER_QUARTER = 480;

const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));
const rnd = (rng: () => number, a = 1): number => rng() * a;
const choice = <T,>(rng: () => number, arr: T[]): T => arr[Math.floor(rng() * arr.length)];
const coin = (rng: () => number, p = 0.5): boolean => rng() < p;
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const byStart = (a: FugueNote, b: FugueNote): number =>
  a.startBeat - b.startBeat || a.voice - b.voice || a.midi - b.midi;
const deepCopy = <T,>(obj: T): T => JSON.parse(JSON.stringify(obj)) as T;

function mulberry32(seed: number): () => number {
  return function next() {
    let t = seed += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i += 1) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function modeOf(key: BachKey): "major" | "minor" {
  return key.includes("minor") ? "minor" : "major";
}

function makeKeyContext(key: BachKey): KeyContext {
  const tonicPc = KEY_TO_PC[key];
  const mode = modeOf(key);
  return { key, tonicPc, mode, scale: SCALES[mode] };
}

function degreePc(ctx: KeyContext, degree: number): number {
  return (ctx.tonicPc + ctx.scale[(degree - 1) % 7]) % 12;
}

function scaleMidi(ctx: KeyContext, degree: number, octave: number): number {
  return 12 * (octave + 1) + degreePc(ctx, degree);
}

function nearestInScale(ctx: KeyContext, midi: number): number {
  let best = midi;
  let bestDistance = 999;
  for (let oct = -1; oct <= 9; oct += 1) {
    for (let deg = 1; deg <= 7; deg += 1) {
      const m = scaleMidi(ctx, deg, oct);
      const distance = Math.abs(m - midi);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = m;
      }
    }
  }
  return best;
}

function fitToScale(ctx: KeyContext, midi: number): number {
  return nearestInScale(ctx, midi);
}

function chordPcsForFunction(ctx: KeyContext, fn: HarmonicPlanMeasure["fn"]): number[] {
  const map: Record<HarmonicPlanMeasure["fn"], number[]> = {
    T: [1, 3, 5],
    PD: [2, 4, 6],
    D: [5, 7, 2],
    CAD: [5, 1],
  };
  return map[fn].map((degree) => degreePc(ctx, degree));
}

function isConsonantInterval(semi: number): boolean {
  const x = Math.abs(semi) % 12;
  return [0, 3, 4, 7, 8, 9].includes(x);
}

function intervalClass(a: number, b: number): number {
  return Math.abs(a - b) % 12;
}

function buildHarmonicPlan(ctx: KeyContext, length: BachLength, character: BachCharacter): HarmonicPlanMeasure[] {
  const measures = length === "short" ? 14 : length === "medium" ? 20 : 28;
  const plan: HarmonicPlanMeasure[] = [];
  for (let i = 0; i < measures; i += 1) {
    let fn: HarmonicPlanMeasure["fn"] = "T";
    let region = "tonic";
    if (i >= 4 && i < 7) fn = "D";
    if (i === 7) fn = "CAD";
    if (i >= 8 && i < 11) {
      fn = (["T", "PD", "D"] as const)[i % 3];
      region = ctx.mode === "major" ? "dominant" : "relative";
    }
    if (i >= 11 && i < 14) {
      fn = (["PD", "D", "T"] as const)[i % 3];
      region = "sequence";
    }
    if (i >= 14 && i < measures - 4) {
      fn = (["T", "PD", "D", "T"] as const)[i % 4];
      region = i % 6 < 3 ? "medial" : "modulatory";
    }
    if (i >= measures - 4) {
      fn = i === measures - 1 ? "CAD" : i === measures - 2 ? "D" : "T";
      region = "closing";
    }
    if (character === "stretto-driven fugue" && i > measures - 6) region = "stretto";
    if (character === "toccata + fugue hybrid" && i < 2) region = "prelude";
    plan.push({ measure: i, fn, region });
  }
  return plan;
}

function generateSubject(
  ctx: KeyContext,
  rng: () => number,
  character: BachCharacter,
  complexity: number
): { notes: FugueNote[]; totalBeats: number } {
  const rhythmBanks: Record<BachCharacter, number[][]> = {
    "severe ricercar": [[1, 1, 1, 1, 1, 1], [2, 1, 1, 2, 2], [1, 0.5, 0.5, 1, 1, 2]],
    "compact fugue": [[1, 0.5, 0.5, 1, 1, 1, 1], [0.5, 0.5, 1, 1, 0.5, 0.5, 2, 1], [1, 1, 0.5, 0.5, 1, 2]],
    "lively fughetta": [[0.5, 0.5, 0.5, 0.5, 1, 1, 1, 1], [1, 0.5, 0.5, 0.5, 0.5, 1, 2], [0.5, 0.5, 1, 0.5, 0.5, 1, 1, 1]],
    "stretto-driven fugue": [[0.5, 0.5, 1, 0.5, 0.5, 1, 1, 1], [1, 0.5, 0.5, 1, 0.5, 0.5, 1, 1], [0.5, 0.5, 0.5, 0.5, 1, 1, 2]],
    "toccata + fugue hybrid": [[0.25, 0.25, 0.5, 0.5, 0.5, 0.5, 1, 1, 1], [0.5, 0.5, 0.5, 0.5, 1, 1, 1, 1], [1, 0.5, 0.5, 0.25, 0.25, 1, 2]],
  };
  const contourBanks = [
    [0, 2, 4, 3, 5, 4, 2, 1],
    [0, 1, 3, 5, 4, 2, 3, 1],
    [0, 4, 3, 1, 2, 5, 4, 2],
    [0, -1, 2, 4, 3, 1, 2, 0],
    [0, 3, 2, 4, 6, 5, 3, 2],
  ];
  const rhythm = choice(rng, rhythmBanks[character]).slice();
  while (rhythm.length < 6) rhythm.push(1);
  const contour = choice(rng, contourBanks);
  const len = clamp(Math.round(6 + complexity + rnd(rng, 3)), 6, 12);
  const startDegree = coin(rng, 0.6) ? 1 : choice(rng, [3, 5]);
  const startOct = ctx.mode === "major" ? 5 : 4;
  const baseMidi = scaleMidi(ctx, startDegree, startOct);
  let last = baseMidi;
  const notes: FugueNote[] = [];
  let beat = 0;

  for (let i = 0; i < len; i += 1) {
    const dur = rhythm[i % rhythm.length];
    const target = baseMidi + contour[i % contour.length] + (coin(rng, 0.2) ? choice(rng, [-2, 2]) : 0);
    let midi = fitToScale(ctx, target);
    if (Math.abs(midi - last) > 8) {
      midi = fitToScale(ctx, last + Math.sign(midi - last) * choice(rng, [2, 3, 4, 5]));
    }
    notes.push({ voice: 0, midi, startBeat: beat, durBeat: dur, role: "subject", section: "subject" });
    beat += dur;
    last = midi;
  }

  const lastNote = notes[notes.length - 1];
  lastNote.midi = fitToScale(ctx, scaleMidi(ctx, coin(rng, 0.5) ? 5 : 2, Math.floor(lastNote.midi / 12) - 1));
  return { notes, totalBeats: beat };
}

function transformSubject(
  subjectNotes: FugueNote[],
  opts: {
    transpose?: number;
    invertAround?: number | null;
    retrograde?: boolean;
    augment?: number;
    diminish?: number;
    tonalAdjust?: boolean;
    ctx?: KeyContext | null;
  } = {}
): FugueNote[] {
  const {
    transpose = 0,
    invertAround = null,
    retrograde = false,
    augment = 1,
    diminish = 1,
    tonalAdjust = false,
    ctx = null,
  } = opts;
  let notes = deepCopy(subjectNotes);
  if (invertAround != null) {
    notes = notes.map((n) => ({ ...n, midi: invertAround - (n.midi - invertAround) }));
  }
  if (retrograde) {
    const total = notes[notes.length - 1].startBeat + notes[notes.length - 1].durBeat;
    notes = notes.slice().reverse().map((n) => ({ ...n, startBeat: total - (n.startBeat + n.durBeat) }));
  }
  const factor = augment / diminish;
  notes = notes.map((n) => ({
    ...n,
    startBeat: n.startBeat * factor,
    durBeat: n.durBeat * factor,
    midi: n.midi + transpose,
  }));
  if (tonalAdjust && ctx) {
    notes = notes.map((n, i) => {
      let midi = n.midi;
      const pc = (midi % 12 + 12) % 12;
      const tonic = ctx.tonicPc;
      const dom = (ctx.tonicPc + 7) % 12;
      if (i < 3 && pc === (tonic + 7) % 12) midi -= 1;
      if (pc === (dom + 5) % 12) midi -= 1;
      return { ...n, midi: fitToScale(ctx, midi) };
    });
  } else if (ctx) {
    notes = notes.map((n) => ({ ...n, midi: fitToScale(ctx, n.midi) }));
  }
  return notes.sort(byStart);
}

function fragmentNotes(notes: FugueNote[], from: number, to: number): FugueNote[] {
  return notes
    .filter((n) => n.startBeat >= from && n.startBeat < to)
    .map((n) => ({ ...n, startBeat: n.startBeat - from }));
}

function sequenceFragment(
  ctx: KeyContext,
  frag: FugueNote[],
  steps: number,
  transposition: number,
  durScale: number
): FugueNote[] {
  const out: FugueNote[] = [];
  let beat = 0;
  for (let i = 0; i < steps; i += 1) {
    frag.forEach((n) => out.push({
      ...n,
      midi: fitToScale(ctx, n.midi + i * transposition),
      startBeat: beat + n.startBeat * durScale,
      durBeat: n.durBeat * durScale,
      role: "episode",
    }));
    const fragDur = Math.max(...frag.map((n) => n.startBeat + n.durBeat)) * durScale;
    beat += fragDur;
  }
  return out;
}

function buildCountersubject(ctx: KeyContext, subject: FugueNote[], rng: () => number): FugueNote[] {
  const notes: FugueNote[] = [];
  for (const s of subject) {
    const dir = coin(rng, 0.5) ? -1 : 1;
    const offset = choice(rng, [3, 4, 6, 8, 9]);
    let midi = fitToScale(ctx, s.midi + dir * offset);
    if (intervalClass(midi, s.midi) === 0) midi = fitToScale(ctx, midi + dir * 2);
    const dur = s.durBeat;
    if (dur >= 1 && coin(rng, 0.6)) {
      notes.push({ voice: 0, midi, startBeat: s.startBeat, durBeat: dur / 2, role: "countersubject" });
      notes.push({ voice: 0, midi: fitToScale(ctx, midi + dir * 2), startBeat: s.startBeat + dur / 2, durBeat: dur / 2, role: "countersubject" });
    } else {
      notes.push({ voice: 0, midi, startBeat: s.startBeat, durBeat: dur, role: "countersubject" });
    }
  }
  return notes.sort(byStart);
}

function groupByVoice(notes: FugueNote[]): Record<number, FugueNote[]> {
  const grouped: Record<number, FugueNote[]> = {};
  for (const note of notes) {
    (grouped[note.voice] ||= []).push(note);
  }
  Object.values(grouped).forEach((arr) => arr.sort(byStart));
  return grouped;
}

function expandTimeline(notes: FugueNote[], step = 0.5): Array<{ t: number; pitches: Record<number, number> }> {
  const end = Math.max(...notes.map((n) => n.startBeat + n.durBeat), 0);
  const voices = [...new Set(notes.map((n) => n.voice))];
  const grid: Array<{ t: number; pitches: Record<number, number> }> = [];
  for (let t = 0; t < end; t += step) {
    const frame: { t: number; pitches: Record<number, number> } = { t, pitches: {} };
    for (const v of voices) {
      const note = notes.find((x) => x.voice === v && x.startBeat <= t + 1e-9 && x.startBeat + x.durBeat > t + 1e-9);
      if (note) frame.pitches[v] = note.midi;
    }
    grid.push(frame);
  }
  return grid;
}

function countParallels(notes: FugueNote[]): FugueScore["par"] {
  const grid = expandTimeline(notes, 0.5);
  let p5 = 0;
  let p8 = 0;
  let contrary = 0;
  let totalMotion = 0;
  let unisons = 0;
  let overlaps = 0;
  for (let i = 1; i < grid.length; i += 1) {
    const prev = grid[i - 1].pitches;
    const curr = grid[i].pitches;
    const voices = Object.keys(curr).map(Number);
    for (let a = 0; a < voices.length; a += 1) {
      for (let b = a + 1; b < voices.length; b += 1) {
        const va = voices[a];
        const vb = voices[b];
        if (prev[va] == null || prev[vb] == null || curr[va] == null || curr[vb] == null) continue;
        const ip = intervalClass(prev[va], prev[vb]);
        const ic = intervalClass(curr[va], curr[vb]);
        const ma = Math.sign(curr[va] - prev[va]);
        const mb = Math.sign(curr[vb] - prev[vb]);
        if (ma !== 0 || mb !== 0) totalMotion += 1;
        if (ma === -mb && ma !== 0) contrary += 1;
        if (ic === 0) unisons += 1;
        if ((ip === 7 || ip === 0) && ic === ip && ma === mb && ma !== 0) {
          if (ic === 7) p5 += 1;
          else p8 += 1;
        }
        if (curr[va] <= curr[vb] && va > vb) overlaps += 1;
      }
    }
  }
  return { p5, p8, contrary, totalMotion, unisons, overlaps };
}

function melodicLeapPenalty(notes: FugueNote[]): number {
  let penalty = 0;
  const byVoice = groupByVoice(notes);
  for (const arr of Object.values(byVoice)) {
    for (let i = 1; i < arr.length; i += 1) {
      const leap = Math.abs(arr[i].midi - arr[i - 1].midi);
      if (leap > 7) penalty += leap - 7;
      if (i >= 2) {
        const prev = arr[i - 1].midi - arr[i - 2].midi;
        const cur = arr[i].midi - arr[i - 1].midi;
        if (Math.abs(prev) > 5 && Math.sign(prev) === Math.sign(cur) && Math.abs(cur) > 2) penalty += 3;
      }
    }
  }
  return penalty;
}

function cadenceStrength(notes: FugueNote[], totalBeats: number, ctx: KeyContext): number {
  const tail = notes.filter((n) => n.startBeat >= totalBeats - 4);
  const tonic = ctx.tonicPc;
  const dom = (ctx.tonicPc + 7) % 12;
  const bassVoice = Math.max(...tail.map((x) => x.voice), -1);
  let tonicHits = 0;
  let domHits = 0;
  let bassCad = 0;
  for (const n of tail) {
    const pc = (n.midi % 12 + 12) % 12;
    if (pc === tonic) tonicHits += 1;
    if (pc === dom) domHits += 1;
    if (n.voice === bassVoice && (pc === tonic || pc === dom)) bassCad += 1;
  }
  return tonicHits * 2 + domHits + bassCad * 2;
}

function harmonicCoherence(notes: FugueNote[], plan: HarmonicPlanMeasure[], ctx: KeyContext): number {
  let ok = 0;
  let total = 0;
  for (const measure of plan) {
    const chord = chordPcsForFunction(ctx, measure.fn);
    const span = notes.filter((n) => n.startBeat >= measure.measure * 4 && n.startBeat < (measure.measure + 1) * 4);
    for (const n of span) {
      total += 1;
      if (chord.includes((n.midi % 12 + 12) % 12)) ok += 1;
    }
  }
  return total ? ok / total : 0;
}

function subjectRecurrence(notes: FugueNote[]): number {
  return notes.filter((n) => ["subject", "answer", "stretto"].includes(n.role)).length;
}

function scoreFugue(notes: FugueNote[], plan: HarmonicPlanMeasure[], ctx: KeyContext): FugueScore {
  const par = countParallels(notes);
  const leaps = melodicLeapPenalty(notes);
  const totalBeats = Math.max(...notes.map((n) => n.startBeat + n.durBeat), 0);
  const cad = cadenceStrength(notes, totalBeats, ctx);
  const harm = harmonicCoherence(notes, plan, ctx);
  const subj = subjectRecurrence(notes);
  const score = 100
    - par.p5 * 8
    - par.p8 * 10
    - leaps * 1.2
    - par.overlaps * 5
    - par.unisons * 0.3
    + (par.totalMotion ? (par.contrary / par.totalMotion) * 18 : 0)
    + cad * 1.8
    + harm * 25
    + Math.min(subj, 70) * 0.35;
  return { score, par, leaps, cad, harm, subj };
}

function noteAt(arr: FugueNote[], t: number): FugueNote | undefined {
  return arr.find((n) => n.startBeat <= t + 1e-9 && n.startBeat + n.durBeat > t + 1e-9);
}

function repairScore(notes: FugueNote[], ctx: KeyContext, plan: HarmonicPlanMeasure[]): FugueNote[] {
  const byVoice = groupByVoice(notes);
  const voices = Object.keys(byVoice).map(Number).sort((a, b) => a - b);
  for (let pass = 0; pass < 3; pass += 1) {
    const grid = expandTimeline(notes, 0.5);
    for (let i = 1; i < grid.length; i += 1) {
      for (let a = 0; a < voices.length; a += 1) {
        for (let b = a + 1; b < voices.length; b += 1) {
          const va = voices[a];
          const vb = voices[b];
          const p0 = grid[i - 1].pitches[va];
          const q0 = grid[i - 1].pitches[vb];
          const p1 = grid[i].pitches[va];
          const q1 = grid[i].pitches[vb];
          if ([p0, q0, p1, q1].some((v) => v == null)) continue;
          const ip = intervalClass(p0, q0);
          const ic = intervalClass(p1, q1);
          const ma = Math.sign(p1 - p0);
          const mb = Math.sign(q1 - q0);
          if ((ip === 7 || ip === 0) && ic === ip && ma === mb && ma !== 0) {
            const note = noteAt(byVoice[vb], grid[i].t);
            if (!note) continue;
            for (const d of [-2, 2, -1, 1, 3, -3]) {
              const cand = fitToScale(ctx, note.midi + d);
              const old = note.midi;
              note.midi = cand;
              const scNew = scoreFugue(notes, plan, ctx).score;
              note.midi = old;
              const scOld = scoreFugue(notes, plan, ctx).score;
              if (scNew > scOld) {
                note.midi = cand;
                break;
              }
            }
          }
        }
      }
    }
    for (const v of voices) {
      const arr = byVoice[v];
      for (let i = 1; i < arr.length; i += 1) {
        const leap = Math.abs(arr[i].midi - arr[i - 1].midi);
        if (leap > 9) arr[i].midi = fitToScale(ctx, arr[i - 1].midi + Math.sign(arr[i].midi - arr[i - 1].midi) * 7);
      }
    }
  }
  return notes.sort(byStart);
}

function buildEpisodeForVoice(
  ctx: KeyContext,
  frag: FugueNote[],
  startBeat: number,
  voice: number,
  regBase: number,
  rng: () => number,
  label = "episode"
): FugueNote[] {
  const seq = sequenceFragment(ctx, frag, 4, choice(rng, [-2, 2, -5, 5]), 0.75);
  return seq.map((n) => ({ ...n, voice, startBeat: n.startBeat + startBeat, midi: fitToScale(ctx, n.midi + regBase), role: label }));
}

function fitRegister(midi: number, voice: number, voices: number): number {
  const registers3 = [76, 64, 50];
  const registers4 = [79, 69, 59, 47];
  const target = (voices === 3 ? registers3 : registers4)[voice];
  while (midi - target > 8) midi -= 12;
  while (target - midi > 8) midi += 12;
  return midi;
}

function overlaySegment(base: FugueNote[], segment: FugueNote[]): void {
  segment.forEach((n) => base.push(n));
}

function fillRestWithCounter(
  baseNotes: FugueNote[],
  occupied: FugueNote[],
  voice: number,
  startBeat: number,
  endBeat: number,
  counter: FugueNote[],
  ctx: KeyContext,
  voices: number,
  rng: () => number,
  role = "free"
): void {
  let t = startBeat;
  let idx = 0;
  while (t < endBeat - 1e-9) {
    const slice = occupied.filter((n) => n.startBeat < t + 0.001 && n.startBeat + n.durBeat > t + 0.001 && n.voice !== voice);
    const src = counter[idx % counter.length] || { midi: scaleMidi(ctx, 1, 4), durBeat: 1, startBeat: 0 };
    const dur = Math.min(src.durBeat, endBeat - t);
    if (dur <= 0) break;
    let midi = fitRegister(src.midi + choice(rng, [-12, 0, 12]), voice, voices);
    if (slice.length) {
      const pcs = slice.map((n) => n.midi);
      for (const d of [0, 2, -2, 4, -4, 7, -7]) {
        const cand = fitToScale(ctx, midi + d);
        if (pcs.every((p) => isConsonantInterval(cand - p) || dur <= 0.5)) {
          midi = cand;
          break;
        }
      }
    }
    baseNotes.push({ voice, midi, startBeat: t, durBeat: dur, role });
    t += dur;
    idx += 1;
  }
}

function planStructure(totalMeasures: number, voices: number, character: BachCharacter) {
  const events: Array<{ type: string; voice: number; measure: number; label: string }> = [];
  const subjectGap = character === "stretto-driven fugue" ? 3 : 4;
  for (let v = 0; v < voices; v += 1) {
    events.push({ type: v % 2 === 0 ? "subject" : "answer", voice: v, measure: (v * subjectGap) / 2, label: "exposition" });
  }
  events.push({ type: "episode", voice: 0, measure: Math.ceil((voices * subjectGap) / 2) + 1, label: "episode1" });
  events.push({ type: "middleEntry", voice: voices - 1, measure: Math.ceil((voices * subjectGap) / 2) + 3, label: "middle1" });
  events.push({ type: "middleEntry", voice: Math.max(0, voices - 2), measure: Math.ceil((voices * subjectGap) / 2) + 5, label: "middle2" });
  events.push({ type: "episode", voice: 0, measure: Math.ceil((voices * subjectGap) / 2) + 7, label: "episode2" });
  events.push({ type: "middleEntry", voice: 0, measure: Math.ceil((voices * subjectGap) / 2) + 9, label: "middle3" });
  if (totalMeasures > 18) events.push({ type: "episode", voice: 0, measure: Math.floor(totalMeasures * 0.65), label: "episode3" });
  const closeStart = totalMeasures - 4;
  if (character === "stretto-driven fugue" || character === "compact fugue") {
    for (let v = 0; v < voices; v += 1) events.push({ type: "stretto", voice: v, measure: closeStart + v * 0.5, label: "closing" });
  } else {
    events.push({ type: "pedal", voice: voices - 1, measure: closeStart, label: "closing" });
    events.push({ type: "middleEntry", voice: 1, measure: closeStart, label: "closingEntry" });
  }
  return events;
}

export function generateFugue(config: BachFugueConfig): BachPiece {
  const ctx = makeKeyContext(config.key);
  const rng = mulberry32(hashString(String(config.seed)));
  const plan = buildHarmonicPlan(ctx, config.length, config.character);
  const totalMeasures = plan.length;
  const totalBeats = totalMeasures * 4;
  const subjectObj = generateSubject(ctx, rng, config.character, config.complexity);
  const subject = subjectObj.notes.map((n) => ({ ...n, midi: fitRegister(n.midi, 0, config.voices) }));
  const countersubject = buildCountersubject(ctx, subject, rng);
  const fragment = fragmentNotes(subject, 0, Math.min(subjectObj.totalBeats, 2));
  const structure = planStructure(totalMeasures, config.voices, config.character);
  let bestNotes: FugueNote[] | null = null;
  let bestScore = -Infinity;
  let bestMeta: Omit<BachPiece, "notes" | "totalBeats"> | null = null;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const notes: FugueNote[] = [];
    const analysis: string[] = [];
    for (const ev of structure) {
      const startBeat = ev.measure * 4;
      if (ev.type === "subject" || ev.type === "answer" || ev.type === "middleEntry") {
        let segment: FugueNote[];
        if (ev.type === "answer") {
          segment = transformSubject(subject, { transpose: 7, tonalAdjust: true, ctx });
        } else if (ev.type === "middleEntry") {
          const style = choice(rng, ["subject", "answer", "inversion", "augmentation", "diminution"]);
          if (style === "answer") segment = transformSubject(subject, { transpose: 7, tonalAdjust: true, ctx });
          else if (style === "inversion") segment = transformSubject(subject, { invertAround: fitRegister(scaleMidi(ctx, 5, 5), ev.voice, config.voices), ctx });
          else if (style === "augmentation") segment = transformSubject(subject, { augment: 2, ctx });
          else if (style === "diminution") segment = transformSubject(subject, { diminish: 2, ctx });
          else segment = transformSubject(subject, { transpose: choice(rng, [0, 7, -5, 2]), ctx });
        } else {
          segment = transformSubject(subject, { ctx });
        }
        segment = segment.map((n) => ({
          ...n,
          voice: ev.voice,
          startBeat: n.startBeat + startBeat,
          midi: fitRegister(n.midi, ev.voice, config.voices),
          role: ev.type === "answer" ? "answer" : "subject",
        }));
        overlaySegment(notes, segment);
        analysis.push(`${ev.label}: ${ev.type} in voice ${ev.voice + 1} at m.${(startBeat / 4).toFixed(1)}`);

        for (let v = 0; v < config.voices; v += 1) {
          if (v === ev.voice) continue;
          const role = startBeat < totalBeats * 0.4 ? "countersubject" : "free";
          const segmentEnd = Math.max(...segment.map((n) => n.startBeat + n.durBeat));
          fillRestWithCounter(notes, notes, v, startBeat, segmentEnd, countersubject, ctx, config.voices, rng, role);
        }
      }
      if (ev.type === "episode") {
        for (let v = 0; v < config.voices; v += 1) {
          const reg = v === config.voices - 1 ? -12 : v * 2;
          const episode = buildEpisodeForVoice(ctx, fragment, startBeat + v * 0.25, v, reg, rng);
          overlaySegment(notes, episode.map((n) => ({ ...n, midi: fitRegister(n.midi, v, config.voices) })));
        }
        analysis.push(`${ev.label}: sequential episode derived from subject head at m.${(startBeat / 4).toFixed(1)}`);
      }
      if (ev.type === "stretto") {
        let segment = transformSubject(subject, { diminish: 2, ctx });
        segment = segment.map((n) => ({
          ...n,
          voice: ev.voice,
          startBeat: n.startBeat + startBeat,
          midi: fitRegister(n.midi, ev.voice, config.voices),
          role: "stretto",
        }));
        overlaySegment(notes, segment);
        analysis.push(`closing stretto overlap in voice ${ev.voice + 1} at m.${(startBeat / 4).toFixed(1)}`);
      }
      if (ev.type === "pedal") {
        const bassPc = degreePc(ctx, 5);
        for (let t = startBeat; t < totalBeats; t += 2) {
          notes.push({
            voice: ev.voice,
            midi: fitRegister(36 + (t >= totalBeats - 2 ? ctx.tonicPc - bassPc : 0) + bassPc, ev.voice, config.voices),
            startBeat: t,
            durBeat: 2,
            role: "pedal",
          });
        }
        analysis.push(`dominant pedal moving to tonic in bass from m.${(startBeat / 4).toFixed(1)}`);
      }
    }

    for (let v = 0; v < config.voices; v += 1) {
      const arr = notes.filter((n) => n.voice === v).sort(byStart);
      let t = 0;
      while (t < totalBeats - 1e-9) {
        const current = arr.find((x) => x.startBeat <= t + 1e-9 && x.startBeat + x.durBeat > t + 1e-9);
        if (current) {
          t = current.startBeat + current.durBeat;
          continue;
        }
        const measure = Math.floor(t / 4);
        const fn = plan[measure]?.fn || "T";
        const chord = chordPcsForFunction(ctx, fn);
        const dur = coin(rng, 0.65) ? 1 : 0.5;
        const choices: number[] = [];
        for (let shift = -12; shift <= 12; shift += 1) {
          for (const pc of chord) {
            for (let oct = 2; oct <= 7; oct += 1) {
              const m0 = 12 * (oct + 1) + pc;
              const mm = fitRegister(m0 + shift, v, config.voices);
              if (mm >= 33 && mm <= 92) choices.push(mm);
            }
          }
        }
        let midi = choices.length ? choice(rng, choices) : fitRegister(scaleMidi(ctx, 1 + (v * 2) % 7, 5 - Math.floor(v * 0.8)), v, config.voices);
        if (arr.length) {
          const prev = [...arr].filter((x) => x.startBeat < t).sort(byStart).pop();
          if (prev && choices.length) {
            choices.sort((a, b) => Math.abs(a - prev.midi) - Math.abs(b - prev.midi));
            midi = choices[0];
          }
        }
        notes.push({ voice: v, midi, startBeat: t, durBeat: Math.min(dur, totalBeats - t), role: "free" });
        arr.push(notes[notes.length - 1]);
        arr.sort(byStart);
        t += dur;
      }
    }

    notes.forEach((n) => {
      n.midi = clamp(n.midi, 33, 92);
    });
    repairScore(notes, ctx, plan);
    notes.sort(byStart);
    const score = scoreFugue(notes, plan, ctx);
    if (Number.isFinite(score.score) && score.score > bestScore) {
      bestScore = score.score;
      bestNotes = deepCopy(notes);
      bestMeta = { analysis, subject, countersubject, plan, score, ctx };
    }
  }

  if (!bestNotes || !bestMeta) {
    const notes: FugueNote[] = [];
    return {
      notes,
      totalBeats,
      analysis: ["Generation fell back to an empty score."],
      subject,
      countersubject,
      plan,
      score: scoreFugue(notes, plan, ctx),
      ctx,
    };
  }

  return { notes: bestNotes, totalBeats, ...bestMeta };
}

function vlq(n: number): Uint8Array {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return Uint8Array.from(bytes);
}

function strBytes(s: string): Uint8Array {
  return Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0x7f));
}

function concatBytes(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, item) => acc + item.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  arrays.forEach((item) => {
    out.set(item, offset);
    offset += item.length;
  });
  return out;
}

function u16(n: number): Uint8Array {
  return Uint8Array.from([(n >> 8) & 0xff, n & 0xff]);
}

function u32(n: number): Uint8Array {
  return Uint8Array.from([(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

function metaText(type: number, text: string): Uint8Array {
  const bytes = strBytes(text);
  return concatBytes([Uint8Array.from([0xff, type]), vlq(bytes.length), bytes]);
}

function tempoMeta(tempo: number): Uint8Array {
  const mpqn = Math.round(60000000 / tempo);
  return Uint8Array.from([0xff, 0x51, 0x03, (mpqn >> 16) & 0xff, (mpqn >> 8) & 0xff, mpqn & 0xff]);
}

function timeSigMeta(): Uint8Array {
  return Uint8Array.from([0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08]);
}

export function encodeFugueMidi(piece: BachPiece, config: BachFugueConfig): ArrayBuffer {
  const voiceCount = Math.max(config.voices, piece.notes.reduce((max, note) => Math.max(max, note.voice), -1) + 1);
  const tracks: Uint8Array[] = [];

  for (let voice = 0; voice < voiceCount; voice += 1) {
    const channel = voice & 0x0f;
    const events: Array<{ tick: number; order: number; bytes: Uint8Array }> = [];
    const label = VOICE_NAMES[voice] ?? `Voice ${voice + 1}`;
    events.push({ tick: 0, order: 0, bytes: metaText(0x03, `Generated Bach ${label}`) });
    events.push({ tick: 0, order: 1, bytes: metaText(0x04, "Harpsichord") });
    if (voice === 0) {
      events.push({ tick: 0, order: 2, bytes: tempoMeta(config.tempo) });
      events.push({ tick: 0, order: 3, bytes: timeSigMeta() });
    }
    events.push({ tick: 0, order: 10, bytes: Uint8Array.from([0xb0 | channel, 0, 0]) });
    events.push({ tick: 0, order: 11, bytes: Uint8Array.from([0xb0 | channel, 32, 0]) });
    events.push({ tick: 0, order: 12, bytes: Uint8Array.from([0xc0 | channel, DEFAULT_PROGRAM]) });

    for (const note of piece.notes.filter((n) => n.voice === voice)) {
      const startTick = Math.max(0, Math.round(note.startBeat * TICKS_PER_QUARTER));
      const endTick = Math.max(startTick + 1, Math.round((note.startBeat + note.durBeat) * TICKS_PER_QUARTER));
      events.push({ tick: startTick, order: 20, bytes: Uint8Array.from([0x90 | channel, clamp(note.midi, 0, 127), 82]) });
      events.push({ tick: endTick, order: 18, bytes: Uint8Array.from([0x80 | channel, clamp(note.midi, 0, 127), 64]) });
    }

    events.sort((a, b) => a.tick - b.tick || a.order - b.order || a.bytes[0] - b.bytes[0]);
    let previousTick = 0;
    const body: Uint8Array[] = [];
    for (const event of events) {
      body.push(vlq(event.tick - previousTick), event.bytes);
      previousTick = event.tick;
    }
    body.push(vlq(0), Uint8Array.from([0xff, 0x2f, 0x00]));
    const data = concatBytes(body);
    tracks.push(concatBytes([strBytes("MTrk"), u32(data.length), data]));
  }

  const header = concatBytes([strBytes("MThd"), u32(6), u16(1), u16(tracks.length), u16(TICKS_PER_QUARTER)]);
  const bytes = concatBytes([header, ...tracks]);
  const midiData = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(midiData).set(bytes);
  return midiData;
}

export function generateBachMidi(overrides: Partial<BachFugueConfig> = {}): GeneratedBachMidi {
  const seed = overrides.seed ?? Math.floor(Math.random() * 1_000_000_000);
  const config: BachFugueConfig = { ...DEFAULT_CONFIG, ...overrides, seed };
  const piece = generateFugue(config);
  const midiData = encodeFugueMidi(piece, config);
  return {
    midiData,
    fileName: `generated-bach-${seed}.mid`,
    seed,
    piece,
    config,
  };
}
