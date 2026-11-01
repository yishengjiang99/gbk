// Feed now-playing card visualization (issue #108). The piano roll fills the canvas: whole song when paused, windowed
// roll scrolling under a fixed playhead when playing, with log-spaced spectrum bars + waveform from the feed
// AnalyserNode overlaid semi-transparently on the bottom 38%. Only the playing card runs a rAF loop, and only while on screen.
// Constants are shared with GBK iOS; keep them in sync with issue #108.
import { useEffect, useRef } from "react";
import type { PianoRollPreview } from "../../agent/piano-roll-preview.ts";
import { VIZ, VIZ_PALETTE as DEF } from "./viz-constants.ts";
export { VIZ };

type Pal = Record<keyof typeof DEF.light, string>;
function palette(el: Element): Pal {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches; const d = dark ? DEF.dark : DEF.light;
  const cs = getComputedStyle(el); const v = (k: string, f: string) => cs.getPropertyValue(k).trim() || f;
  return { bg: v("--viz-bg", d.bg), grid: v("--viz-grid", d.grid), row: v("--viz-row", d.row), head: v("--viz-head", d.head), bar: v("--viz-bar", d.bar), wave: v("--viz-wave", d.wave), dim: v("--viz-dim", d.dim) };
}
const lighten = (hex: string, k: number) => { const h = hex.replace("#", ""); const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6); const c = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)); return `rgb(${c.map((x) => Math.round(x + (255 - x) * k)).join(",")})`; };
const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(p % 12);

export interface VizSource { el: HTMLAudioElement | null; analyser: AnalyserNode | null }

// win/ph default to the playing window; the paused overview passes dur = win = 1, ph = 0 (whole song, no playhead).
export function drawRoll(ctx: CanvasRenderingContext2D, p: PianoRollPreview, t: number, dur: number, W: number, H: number, pal: Pal, win: number = VIZ.windowSec, ph: number = VIZ.playheadFrac) {
  ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H);
  const ps = p.notes.map((n) => n[3]), pLo = ps.length ? Math.min(...ps) : p.lo, pHi = ps.length ? Math.max(...ps) : p.hi;
  const lo = pLo - VIZ.pitchPad, hi = Math.max(pHi + VIZ.pitchPad, lo + VIZ.minPitchSpan - 1), rows = hi - lo + 1, rh = H / rows;
  for (let q = lo; q <= hi; q++) if (isBlack(q)) { ctx.fillStyle = pal.row; ctx.fillRect(0, H - (q - lo + 1) * rh, W, rh); }
  const pps = W / win, hx = W * ph, u = dur / 1000; // preview units -> seconds
  for (const [tr, s, l, pitch] of p.notes) {
    const t0 = s * u, t1 = (s + l) * u, x0 = hx + (t0 - t) * pps, x1 = hx + (t1 - t) * pps;
    if (x1 < 0 || x0 > W) continue;
    const on = t0 <= t && t1 > t, col = p.tracks[tr] ?? "#90a4ae", y = H - (pitch - lo + 1) * rh + VIZ.noteGapPx / 2;
    const w = Math.max(VIZ.minNoteW, x1 - x0 - VIZ.noteGapPx), h = Math.max(VIZ.minNoteH, rh - VIZ.noteGapPx);
    ctx.globalAlpha = on ? 1 : t1 <= t ? VIZ.pastAlpha : VIZ.upcomingAlpha;
    ctx.fillStyle = on ? lighten(col, VIZ.activeLighten) : col; ctx.fillRect(x0, y, w, h);
    if (on) { ctx.strokeStyle = pal.head; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, y + 0.5, w - 1, h - 1); }
  }
  ctx.globalAlpha = 1; if (ph > 0) { ctx.fillStyle = pal.head; ctx.fillRect(Math.round(hx) - 1, 0, 2, H); }
}

export function LiveRoll({ p, playing, source }: { p: PianoRollPreview; playing: boolean; source: () => VizSource }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current!; const ctx = c.getContext("2d")!; let raf = 0, visible = true, last = performance.now();
    const levels = new Float32Array(VIZ.bars); let freq: Uint8Array<ArrayBuffer> | null = null; let wave: Float32Array<ArrayBuffer> | null = null;
    const size = () => { const r = c.getBoundingClientRect(), d = Math.min(3, devicePixelRatio || 1); const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d)); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } return { W: w, H: h }; };
    const frame = (now: number) => {
      const { W, H } = size(); const pal = palette(c);
      const sH = Math.round(H * VIZ.overlayFrac), mid = H - sH / 2;
      if (!playing) { // paused: whole-song overview at full height + faint idle line
        ctx.save(); drawRoll(ctx, p, 0, 1, W, H, pal, 1, 0); ctx.restore();
        ctx.globalAlpha = VIZ.idleAlpha; ctx.fillStyle = pal.dim; ctx.fillRect(0, Math.round(mid), W, 1); ctx.globalAlpha = 1; raf = 0; return;
      }
      const { el, analyser } = playing ? source() : { el: null, analyser: null };
      const dur = el && isFinite(el.duration) && el.duration > 0 ? el.duration : 30; const t = el ? el.currentTime : 0;
      ctx.save(); drawRoll(ctx, p, t, dur, W, H, pal); ctx.restore();
      const dt = Math.min(100, now - last); last = now; const fall = Math.exp(-dt / VIZ.decayMs);
      if (analyser) {
        if (!freq || freq.length !== analyser.frequencyBinCount) freq = new Uint8Array(analyser.frequencyBinCount);
        if (!wave || wave.length !== analyser.fftSize) wave = new Float32Array(analyser.fftSize);
        analyser.getByteFrequencyData(freq); analyser.getFloatTimeDomainData(wave);
        const ny = analyser.context.sampleRate / 2, n = freq.length;
        for (let b = 0; b < VIZ.bars; b++) {
          const f0 = VIZ.fMin * Math.pow(VIZ.fMax / VIZ.fMin, b / VIZ.bars), f1 = VIZ.fMin * Math.pow(VIZ.fMax / VIZ.fMin, (b + 1) / VIZ.bars);
          const i0 = Math.min(n - 1, Math.floor((f0 / ny) * n)), i1 = Math.min(n, Math.max(i0 + 1, Math.ceil((f1 / ny) * n)));
          let m = 0; for (let i = i0; i < i1; i++) m = Math.max(m, freq[i]); const v = m / 255;
          levels[b] = v >= levels[b] ? v : levels[b] * fall;
        }
      } else for (let b = 0; b < VIZ.bars; b++) levels[b] *= fall;
      const bw = W / VIZ.bars; ctx.fillStyle = analyser ? pal.bar : pal.dim; ctx.globalAlpha = VIZ.barAlpha;
      for (let b = 0; b < VIZ.bars; b++) { const h = Math.max(1, levels[b] * (sH - 4)); ctx.fillRect(b * bw + 1, H - h, Math.max(1, bw - 2), h); }
      ctx.globalAlpha = VIZ.waveAlpha; ctx.strokeStyle = analyser ? pal.wave : pal.dim; ctx.lineWidth = Math.max(1, H / 200); ctx.beginPath();
      for (let k = 0; k < VIZ.waveSamples; k++) { const s = wave && analyser ? wave[Math.floor((k / VIZ.waveSamples) * wave.length)] : 0; const x = (k / (VIZ.waveSamples - 1)) * W, y = mid - s * (sH / 2 - 2); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.stroke(); ctx.globalAlpha = 1;
      if (playing && visible) raf = requestAnimationFrame(frame); else raf = 0;
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) kick(); }); io.observe(c);
    const ro = new ResizeObserver(kick); ro.observe(c);
    const mq = matchMedia("(prefers-color-scheme: dark)"); mq.addEventListener("change", kick);
    kick();
    return () => { cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); mq.removeEventListener("change", kick); };
  }, [p, playing, source]);
  return <canvas ref={ref} className="so-liveroll" data-testid="card-pianoroll" data-live={playing ? "1" : "0"} role="img" aria-label="piano-roll and spectrum" />;
}
