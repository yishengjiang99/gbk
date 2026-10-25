// Feed audio switcher. One "current" voice plays; on a switch the new voice starts at once at full gain and the old
// voice fades out over FADE_MS (58 ms) on a cos(t·π/2) curve, matching GBK iOS. At most one voice is fading:
// a new switch while a fade runs stops the stale fading voice immediately, so fast scrolls never pile up audio.
// Gain goes through Web Audio (iOS ignores HTMLMediaElement.volume); without an AudioContext it falls back to volume.
export const FADE_MS = 58;
const STEPS = 33;
export const curve = (dir: "in" | "out") => Float32Array.from({ length: STEPS }, (_, i) => { const t = i / (STEPS - 1); return dir === "in" ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2); });

interface Voice { src: string; el: HTMLAudioElement; gain: GainNode | null; raf?: number; timer?: ReturnType<typeof setTimeout> }
export type FadeState = { current: string | null; fading: string | null };

export class Crossfader {
  private ctx: AudioContext | null = null;
  private pool = new Map<string, Voice>();
  private current: Voice | null = null; private fading: Voice | null = null;
  unlocked = false;
  constructor(private host: HTMLElement, private onChange: (s: FadeState) => void, private fadeMs = FADE_MS) {}

  private voice(src: string): Voice {
    let v = this.pool.get(src); if (v) return v;
    const el = document.createElement("audio"); el.preload = "auto"; el.loop = true; el.setAttribute("playsinline", ""); el.src = src; el.dataset.src = src; this.host.appendChild(el);
    v = { src, el, gain: null }; this.pool.set(src, v); this.wire(v); return v;
  }
  private wire(v: Voice) { if (!this.ctx || v.gain) return; try { const g = this.ctx.createGain(); this.ctx.createMediaElementSource(v.el).connect(g).connect(this.ctx.destination); v.gain = g; } catch { v.gain = null; } }
  private set(v: Voice, x: number) { if (v.gain) { v.gain.gain.cancelScheduledValues(0); v.gain.gain.value = x; } else v.el.volume = x; }
  private ramp(v: Voice, dir: "in" | "out", done?: () => void) {
    this.cancel(v); const c = curve(dir);
    if (v.gain && this.ctx) { const g = v.gain.gain; g.cancelScheduledValues(this.ctx.currentTime); g.setValueCurveAtTime(c, this.ctx.currentTime, this.fadeMs / 1000); }
    else { const t0 = performance.now(); const step = () => { const t = Math.min(1, (performance.now() - t0) / this.fadeMs); v.el.volume = c[Math.round(t * (STEPS - 1))]; if (t < 1) v.raf = requestAnimationFrame(step); }; v.raf = requestAnimationFrame(step); }
    if (done) v.timer = setTimeout(done, this.fadeMs + 20);
  }
  private cancel(v: Voice) { if (v.raf) cancelAnimationFrame(v.raf); if (v.timer) clearTimeout(v.timer); v.raf = v.timer = undefined; }
  private hard(v: Voice) { this.cancel(v); v.el.pause(); this.set(v, 0); }
  private emit() { this.onChange({ current: this.current && !this.current.el.paused ? this.current.src : null, fading: this.fading?.src ?? null }); }

  /** Call inside the first user gesture: creates/resumes the AudioContext (iOS unlock). */
  unlock() {
    if (!this.ctx) { const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext; if (AC) { try { this.ctx = new AC(); } catch { this.ctx = null; } } for (const v of this.pool.values()) this.wire(v); }
    void this.ctx?.resume().catch(() => undefined);
  }

  /** Crossfade to src (null = fade everything out). */
  async play(src: string | null): Promise<boolean> {
    if (this.fading) { const f = this.fading; this.fading = null; if (f !== this.current) this.hard(f); }
    const prev = this.current;
    if (src && prev?.src === src) { if (prev.el.paused) { this.set(prev, 1); try { await prev.el.play(); } catch { return false; } } this.emit(); return true; }
    if (prev) { this.fading = prev; this.ramp(prev, "out", () => { if (this.fading === prev) { prev.el.pause(); this.fading = null; this.emit(); } }); }
    this.current = null;
    if (!src) { this.emit(); return true; }
    const v = this.voice(src); this.current = v; this.set(v, 1);
    try { await v.el.play(); } catch { if (this.current === v) this.current = null; this.emit(); return false; }
    if (this.current !== v) return false;
    this.unlocked = true; this.emit(); return true;
  }
  /** Immediate stop of everything (tab hidden, filter change). */
  stop() { for (const v of this.pool.values()) this.hard(v); this.current = this.fading = null; this.emit(); }
  /** Keep only these sources (plus current/fading) warm; start loading them. */
  preload(srcs: (string | null | undefined)[]) {
    const keep = new Set(srcs.filter((s): s is string => !!s)); for (const s of keep) this.voice(s);
    for (const [s, v] of this.pool) if (!keep.has(s) && v !== this.current && v !== this.fading) { this.hard(v); v.el.removeAttribute("src"); v.el.remove(); this.pool.delete(s); }
  }
  get playingCount() { let n = 0; for (const v of this.pool.values()) if (!v.el.paused) n++; return n; }
  dispose() { this.stop(); for (const v of this.pool.values()) { v.el.removeAttribute("src"); v.el.remove(); } this.pool.clear(); void this.ctx?.close().catch(() => undefined); }
}
