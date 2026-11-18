// Feed hook: start of the densest 8–12 s velocity-weighted note-on window, or the first
// return of a clearly repeated section. Null when the song has no notes. Contract: docs/social-api.md.
import { parseSmf } from "../workstation/smf.ts";
import { tickToSec } from "../workstation/timing.ts";
import type { Project, TempoEvent } from "../workstation/model.ts";

export interface Onset { tMs: number; vel: number; pitch: number }

export const MIN_WINDOW_MS = 8_000;
export const MAX_WINDOW_MS = 12_000;
const DENSE_WINDOW_MS = 10_000;
const STEP_MS = 500;
const REPEAT_CLEAR = 0.88;
const REPEAT_HAMMING = 0.2;

const vel = (v: unknown) => Math.max(1, Math.min(127, Math.round(Number(v) || 80)));

/** Hook start in ms from 0, or null when there are no note-ons. Short songs (< 8 s) with notes return 0. */
export function hookStartMs(onsets: Onset[], durationMs = 0): number | null {
  if (!onsets.length) return null;
  const ev = onsets.filter((o) => Number.isFinite(o.tMs) && o.tMs >= 0).map((o) => ({ tMs: o.tMs, vel: vel(o.vel), pitch: ((o.pitch % 12) + 12) % 12 })).sort((a, b) => a.tMs - b.tMs);
  if (!ev.length) return null;
  const dur = Math.max(durationMs, ev[ev.length - 1].tMs);
  if (dur < MIN_WINDOW_MS) return 0;
  const dense = densestWindow(ev, dur);
  const ret = firstReturnMs(ev, dur, dense.score / dense.w);
  if (ret != null) return ret;
  return dense.t;
}

export function hookStartMsFromProject(p: Pick<Project, "notes" | "tempos" | "ppq" | "endTick">): number | null {
  const { onsets, durationMs } = onsetsFromProject(p);
  return hookStartMs(onsets, durationMs);
}

export function hookStartMsFromShare(projectJson: string | null | undefined, midi?: Uint8Array | null): number | null {
  try {
    if (projectJson) {
      const p = JSON.parse(projectJson) as Pick<Project, "notes" | "tempos" | "ppq" | "endTick">;
      if (p && Array.isArray(p.notes) && p.notes.length) return hookStartMsFromProject(p);
    }
  } catch { /* fall through to MIDI */ }
  if (midi && midi.byteLength) {
    try { return hookStartMsFromProject(parseSmf(midi)); } catch { return null; }
  }
  try {
    if (projectJson) {
      const p = JSON.parse(projectJson) as Pick<Project, "notes" | "tempos" | "ppq" | "endTick">;
      if (p && Array.isArray(p.notes)) return hookStartMsFromProject(p);
    }
  } catch { /* ignore */ }
  return null;
}

export function onsetsFromProject(p: Pick<Project, "notes" | "tempos" | "ppq" | "endTick">): { onsets: Onset[]; durationMs: number } {
  const ppq = p.ppq > 0 ? p.ppq : 480;
  const tempos: TempoEvent[] = p.tempos?.length ? p.tempos : [{ tick: 0, microPerQuarter: 500_000 }];
  const timing = { tempos, ppq };
  const ms = (tick: number) => Math.round(tickToSec(timing, tick) * 1000);
  const onsets: Onset[] = [];
  let endTick = Math.max(0, p.endTick ?? 0);
  for (const n of p.notes ?? []) {
    if (!Number.isFinite(n.tick)) continue;
    onsets.push({ tMs: ms(n.tick), vel: vel(n.velocity), pitch: n.pitch ?? 60 });
    endTick = Math.max(endTick, n.tick + Math.max(0, n.duration ?? 0));
  }
  return { onsets, durationMs: ms(endTick) };
}

function densestWindow(ev: Onset[], durationMs: number): { t: number; score: number; w: number } {
  const w = durationMs < DENSE_WINDOW_MS ? MIN_WINDOW_MS : Math.min(DENSE_WINDOW_MS, durationMs);
  const maxT = Math.max(0, durationMs - w);
  const starts: number[] = [0];
  for (const o of ev) if (o.tMs <= maxT) starts.push(o.tMs);
  const cand = [...new Set(starts)].sort((a, b) => a - b);
  let best = -1, bestT = 0, lo = 0, hi = 0, sum = 0;
  for (const t of cand) {
    while (hi < ev.length && ev[hi].tMs < t + w) { sum += ev[hi].vel; hi++; }
    while (lo < ev.length && ev[lo].tMs < t) { sum -= ev[lo].vel; lo++; }
    if (sum > best) { best = sum; bestT = t; }
  }
  return { t: bestT, score: Math.max(0, best), w };
}

function windowScore(ev: Onset[], t: number, w: number): number {
  let s = 0;
  for (const o of ev) { if (o.tMs >= t + w) break; if (o.tMs >= t) s += o.vel; }
  return s;
}

function firstReturnMs(ev: Onset[], durationMs: number, densePerMs: number): number | null {
  const n = Math.max(1, Math.ceil(durationMs / STEP_MS));
  const bins = Array.from({ length: n }, () => new Float64Array(12));
  for (const o of ev) {
    const i = Math.max(0, Math.min(n - 1, Math.floor(o.tMs / STEP_MS)));
    bins[i][o.pitch] += o.vel;
  }
  let bestSim = 0, bestReturn = 0;
  for (const winMs of [MIN_WINDOW_MS, DENSE_WINDOW_MS, MAX_WINDOW_MS]) {
    if (durationMs < winMs * 2) continue;
    const win = Math.round(winMs / STEP_MS);
    const fps: string[] = [];
    for (let t0 = 0; t0 + win <= n; t0++) fps.push(fingerprint(bins, t0, win));
    for (let t0 = 0; t0 + 2 * win <= n; t0++) {
      if (energy(bins, t0, win) < 40) continue;
      const a = fps[t0];
      for (let t1 = t0 + win; t1 + win <= n; t1++) {
        if (hamming(a, fps[t1]) > REPEAT_HAMMING) continue;
        if (energy(bins, t1, win) < 40) continue;
        const sim = sectionSim(bins, t0, t1, win);
        if (sim <= bestSim) continue;
        const perMs = windowScore(ev, t1 * STEP_MS, winMs) / winMs;
        if (perMs < densePerMs * 0.7) continue;
        bestSim = sim; bestReturn = t1 * STEP_MS;
      }
    }
  }
  return bestSim >= REPEAT_CLEAR ? bestReturn : null;
}

function fingerprint(bins: Float64Array[], t0: number, win: number): string {
  let s = "";
  for (let i = 0; i < win; i++) {
    const b = bins[t0 + i];
    let best = 0, bi = 0, e = 0;
    if (b) for (let p = 0; p < 12; p++) { e += b[p]; if (b[p] > best) { best = b[p]; bi = p; } }
    s += e < 1 ? "-" : "ABCDEFGHIJKL"[bi];
  }
  return s;
}

function hamming(a: string, b: string): number {
  if (a.length !== b.length || !a.length) return 1;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d / a.length;
}

function energy(bins: Float64Array[], t0: number, win: number): number {
  let e = 0;
  for (let i = 0; i < win; i++) { const b = bins[t0 + i]; if (b) for (const x of b) e += x; }
  return e;
}

function sectionSim(bins: Float64Array[], t0: number, t1: number, win: number): number {
  let s = 0, n = 0;
  for (let i = 0; i < win; i++) {
    const a = bins[t0 + i], b = bins[t1 + i];
    if (!a || !b) continue;
    const ea = a.reduce((x, y) => x + y, 0), eb = b.reduce((x, y) => x + y, 0);
    if (ea < 1 && eb < 1) continue;
    s += cosine(a, b); n++;
  }
  return n ? s / n : 0;
}

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
