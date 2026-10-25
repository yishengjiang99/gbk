// Live visuals for the active feed card, matching GBK iOS (docs/social-api.md "Client behavior").
// Row 1: piano roll windowed like Export video (shared drawRoll): the notes sounding now and those coming up scroll
// toward a fixed playhead at 25%, ~4 s visible, sounding notes lit with a brighter track color.
// Row 2: 48 log-spaced spectrum bars (instant attack, ~150 ms decay) beside a waveform oscilloscope, both from the
// shared AnalyserNode. One rAF loop, only while this card is active and playing and the tab is visible.
// Canvases are DPR-aware; colors come from the --so-* CSS vars so dark mode follows prefers-color-scheme.
import { useEffect, useMemo, useRef } from "react";
import type { PianoRollPreview } from "../../agent/piano-roll-preview.ts";
import { drawRoll, type RollPalette, type VideoModel } from "../../video/piano-roll-video.ts";

export const PLAYHEAD_X = 0.25, WINDOW_SEC = 4, BARS = 48, BAR_DECAY_MS = 150;
const F_LO = 40, F_HI = 16000;
export const brighten = (hex: string, k = 0.45) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return hex; const n = parseInt(m[1], 16); const c = (v: number) => Math.round(v + (255 - v) * k); return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`; };
export function barBins(sampleRate: number, fftSize: number, bars = BARS) {
  const hz = sampleRate / fftSize; const e = Array.from({ length: bars + 1 }, (_, i) => F_LO * Math.pow(F_HI / F_LO, i / bars));
  return e.slice(0, -1).map((f, i) => [Math.max(1, Math.floor(f / hz)), Math.max(Math.floor(f / hz) + 1, Math.ceil(e[i + 1] / hz))] as const);
}
/** Preview (0..1000 timeline) → video model in seconds, repeated before/after so the looping audio wraps seamlessly. */
export function previewModel(p: PianoRollPreview, dur: number): VideoModel {
  const notes = [-1, 0, 1].flatMap((k) => p.notes.map(([track, x, w, pitch]) => { const t0 = (x / 1000) * dur + k * dur; return { t0, t1: t0 + Math.max(0.05, (w / 1000) * dur), pitch, velocity: 100, track }; })).sort((a, b) => a.t0 - b.t0);
  return { title: "", subtitle: "", duration: dur, tracks: p.tracks.map((c) => ({ name: "", color: c })), notes, sections: [], barTimes: [], pitchLo: p.lo, pitchHi: p.hi };
}
function fit(c: HTMLCanvasElement) {
  const dpr = Math.min(3, window.devicePixelRatio || 1); const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } return { w, h, dpr };
}
const cssVar = (el: Element, n: string) => getComputedStyle(el).getPropertyValue(n).trim();
function palette(el: Element) {
  const v = (n: string) => cssVar(el, `--so-${n}`);
  const roll: RollPalette = { BG: v("roll-bg"), GRID: v("roll-grid"), BAR: v("roll-bar"), TEXT: v("text"), DIM: v("dim"), ROW: v("roll-row"), SECTION: v("star"), HEAD: v("playhead"), WHITE: v("key-white"), BLACK: v("key-black"), PROG: v("accent"), OUTLINE: v("note-outline") };
  return { roll, from: v("spec-from"), to: v("spec-to"), wave: v("wave"), surface: v("surface"), dark: matchMedia("(prefers-color-scheme: dark)").matches };
}

export function LiveRoll({ p, el, analyser, playing }: { p: PianoRollPreview | null; el: HTMLAudioElement | null; analyser: AnalyserNode | null; playing: boolean }) {
  const roll = useRef<HTMLCanvasElement | null>(null), spec = useRef<HTMLCanvasElement | null>(null), scope = useRef<HTMLCanvasElement | null>(null);
  const levels = useRef(new Float32Array(BARS)); const dur = useRef(0);
  const modelFor = useMemo(() => { let cache: { d: number; m: VideoModel } | null = null; return (d: number) => { if (!p) return null; if (!cache || cache.d !== d) cache = { d, m: previewModel(p, d) }; return cache.m; }; }, [p]);
  useEffect(() => {
    const rc = roll.current, sc = spec.current, oc = scope.current; if (!rc || !sc || !oc) return;
    let raf = 0, last = performance.now(), frames = Number(rc.dataset.frames ?? 0); let pal = palette(rc);
    const mq = matchMedia("(prefers-color-scheme: dark)"); const onScheme = () => { pal = palette(rc); if (!playing) draw(performance.now()); }; mq.addEventListener?.("change", onScheme);
    const fft = analyser ? new Uint8Array(analyser.frequencyBinCount) : null, wave = analyser ? new Uint8Array(analyser.fftSize) : null;
    const bins = analyser ? barBins(analyser.context.sampleRate, analyser.fftSize) : [];
    const draw = (now: number) => {
      const dt = now - last; last = now; frames++;
      const d = el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : dur.current || 1; dur.current = d;
      const t = el ? el.currentTime % d : 0;
      // row 1: roll
      const R = fit(rc), g = rc.getContext("2d")!; g.fillStyle = pal.roll.BG; g.fillRect(0, 0, R.w, R.h);
      const m = modelFor(d); let lit = 0;
      if (m) lit = drawRoll(g, m, t, { left: 0, top: 4 * R.dpr, width: R.w, bottom: R.h - 4 * R.dpr, keyboardW: 0, windowSeconds: WINDOW_SEC, playheadFrac: PLAYHEAD_X, sections: false, minRows: 12, litFill: (c) => brighten(c, pal.dark ? 0.35 : 0.45) }, pal.roll);
      // row 2a: spectrum
      const S = fit(sc), q = sc.getContext("2d")!; q.fillStyle = pal.surface; q.fillRect(0, 0, S.w, S.h);
      const L = levels.current, k = Math.exp(-dt / BAR_DECAY_MS);
      if (fft && analyser && playing) analyser.getByteFrequencyData(fft);
      const grad = q.createLinearGradient(0, 0, S.w, 0); grad.addColorStop(0, pal.from); grad.addColorStop(1, pal.to); q.fillStyle = grad;
      let energy = 0; const bw = S.w / BARS;
      for (let i = 0; i < BARS; i++) {
        let v = 0; if (fft && playing) { const [a, b] = bins[i]; for (let j = a; j < b && j < fft.length; j++) v = Math.max(v, fft[j] / 255); }
        L[i] = v >= L[i] ? v : L[i] * k; energy += L[i];
        const bh = Math.max(S.dpr, L[i] * (S.h - 2 * S.dpr)); q.fillRect(i * bw + bw * 0.15, S.h - bh, bw * 0.7, bh);
      }
      // row 2b: oscilloscope
      const O = fit(oc), o = oc.getContext("2d")!; o.fillStyle = pal.surface; o.fillRect(0, 0, O.w, O.h);
      o.strokeStyle = pal.wave; o.lineWidth = 1.5 * O.dpr; o.beginPath(); let amp = 0;
      if (wave && analyser && playing) { analyser.getByteTimeDomainData(wave); const n = wave.length; for (let i = 0; i < n; i += 4) { const y = (wave[i] / 255) * O.h; amp = Math.max(amp, Math.abs(wave[i] - 128)); if (i) o.lineTo((i / n) * O.w, y); else o.moveTo(0, y); } }
      else { o.moveTo(0, O.h / 2); o.lineTo(O.w, O.h / 2); }
      o.stroke();
      rc.dataset.frames = String(frames); rc.dataset.lit = String(lit); rc.dataset.t = t.toFixed(2); sc.dataset.energy = playing ? energy.toFixed(3) : "0"; oc.dataset.amp = playing ? String(amp) : "0";
      if (playing && !document.hidden) raf = requestAnimationFrame(draw); else L.fill(0);
    };
    raf = requestAnimationFrame(draw);
    const vis = () => { if (!document.hidden && playing) { cancelAnimationFrame(raf); last = performance.now(); raf = requestAnimationFrame(draw); } };
    document.addEventListener("visibilitychange", vis);
    return () => { cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", vis); mq.removeEventListener?.("change", onScheme); };
  }, [p, el, analyser, playing, modelFor]);
  return (
    <div className="so-live">
      <canvas ref={roll} className="so-liveroll" data-testid="card-liveroll" />
      <div className="so-liverow"><canvas ref={spec} className="so-spectrum" data-testid="card-spectrum" /><canvas ref={scope} className="so-scope" data-testid="card-scope" /></div>
    </div>
  );
}
