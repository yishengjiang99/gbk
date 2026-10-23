import type { Project, TempoEvent, TimeSigEvent } from "./model.ts";

export interface TempoSeg { tick: number; sec: number; mpq: number }

export function tempoSegments(tempos: TempoEvent[], ppq: number): TempoSeg[] {
  const sorted = [...tempos].sort((a, b) => a.tick - b.tick);
  if (!sorted.length || sorted[0].tick > 0) sorted.unshift({ tick: 0, microPerQuarter: 500000 });
  const segs: TempoSeg[] = [];
  let sec = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) sec += ((sorted[i].tick - sorted[i - 1].tick) * sorted[i - 1].microPerQuarter) / 1e6 / ppq;
    if (segs.length && segs[segs.length - 1].tick === sorted[i].tick) segs.pop();
    segs.push({ tick: sorted[i].tick, sec, mpq: sorted[i].microPerQuarter });
  }
  return segs;
}

export function tickToSec(p: Pick<Project, "tempos" | "ppq">, tick: number, segs = tempoSegments(p.tempos, p.ppq)): number {
  let s = segs[0];
  for (const seg of segs) { if (seg.tick <= tick) s = seg; else break; }
  return s.sec + ((tick - s.tick) * s.mpq) / 1e6 / p.ppq;
}

export function secToTick(p: Pick<Project, "tempos" | "ppq">, sec: number, segs = tempoSegments(p.tempos, p.ppq)): number {
  let s = segs[0];
  for (const seg of segs) { if (seg.sec <= sec) s = seg; else break; }
  return Math.round(s.tick + ((sec - s.sec) * 1e6 * p.ppq) / s.mpq);
}

export interface Bar { index: number; tick: number; numerator: number; denominator: number; ticksPerBeat: number; length: number }

/** Bars (1-based index) from the meter map, through `endTick`. */
export function bars(p: Pick<Project, "timeSigs" | "ppq">, endTick: number): Bar[] {
  const sigs: TimeSigEvent[] = [...p.timeSigs].sort((a, b) => a.tick - b.tick);
  if (!sigs.length || sigs[0].tick > 0) sigs.unshift({ tick: 0, numerator: 4, denominator: 4 });
  const out: Bar[] = [];
  let tick = 0, si = 0, index = 1;
  do {
    while (si + 1 < sigs.length && sigs[si + 1].tick <= tick) si++;
    const s = sigs[si];
    const tpb = (p.ppq * 4) / s.denominator;
    const length = tpb * s.numerator;
    out.push({ index, tick, numerator: s.numerator, denominator: s.denominator, ticksPerBeat: tpb, length });
    tick += length; index++;
  } while (tick <= endTick && index < 100000);
  return out;
}

/** Tick at the start of 1-based bar `bar` (+ 0-based beat offset). Bars past the end extrapolate. */
export function barBeatToTick(p: Pick<Project, "timeSigs" | "ppq">, bar: number, beat = 0): number {
  const all = bars(p, Math.ceil(Math.max(1, bar) * p.ppq * 32));
  const b = all[Math.max(0, Math.min(all.length - 1, Math.floor(bar) - 1))];
  return Math.round(b.tick + beat * b.ticksPerBeat);
}

export function tickToBarBeat(p: Pick<Project, "timeSigs" | "ppq">, tick: number): { bar: number; beat: number } {
  const all = bars(p, tick);
  let b = all[0];
  for (const x of all) { if (x.tick <= tick) b = x; else break; }
  return { bar: b.index, beat: (tick - b.tick) / b.ticksPerBeat };
}
