// Feed audio switcher. One "current" voice plays; on a switch the new voice starts at once at full gain and the old
// voice fades out over FADE_MS (58 ms) on a cos(t·π/2) curve, matching GBK iOS. At most one voice is fading:
// a new switch while a fade runs stops the stale fading voice immediately, so fast scrolls never pile up audio.
// Gain goes through Web Audio (iOS ignores HTMLMediaElement.volume); without an AudioContext it falls back to volume.
export const FADE_MS = 58;
const STEPS = 33;
export const curve = (dir: "in" | "out") => Float32Array.from({ length: STEPS }, (_, i) => { const t = i / (STEPS - 1); return dir === "in" ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2); });

import { startLive, type LiveVoice, type Prepared } from "./live-song.ts";

// A voice is either a media element (legacy audio-only songs) or a live SF2 engine voice (live-song.ts).
interface Voice { src: string; el: HTMLAudioElement; gain: GainNode | null; live?: LiveVoice; raf?: number; timer?: ReturnType<typeof setTimeout> }
const isPaused = (v: Voice) => v.live ? v.live.clock.paused : v.el.paused;
export type FadeState = { current: string | null; fading: string | null };

export class Crossfader {
  private ctx: AudioContext | null = null;
  private pool = new Map<string, Voice>();
  private spares: Voice[] = [];
  private current: Voice | null = null; private fading: Voice | null = null;
  unlocked = false;
  /** Shared analyser for the now-playing visualization (#108); every voice routes gain -> analyser -> destination. */
  analyser: AnalyserNode | null = null;
  /** Clock of the now-playing voice (an <audio>, or the live engine's currentTime/duration stand-in). */
  get currentEl() { return this.current?.el ?? null; }
  get audioContext() { return this.ctx; }
  private seq = 0;
  constructor(private host: HTMLElement, private onChange: (s: FadeState) => void, private fadeMs = FADE_MS) {}

  private voice(src: string): Voice {
    let v = this.pool.get(src); if (v) return v;
    // Reuse a gesture-blessed element when one is free: iOS lets an element that played inside a gesture play later
    // without one, even after its src changes; a fresh element would be blocked on scroll autoplay.
    const spare = this.spares.pop();
    if (spare) { spare.el.src = src; spare.el.dataset.src = src; spare.src = src; this.pool.set(src, spare); this.wire(spare); return spare; }
    const el = document.createElement("audio"); el.preload = "auto"; el.loop = true; el.setAttribute("playsinline", ""); el.src = src; el.dataset.src = src; this.host.appendChild(el);
    v = { src, el, gain: null }; this.pool.set(src, v); this.wire(v); return v;
  }
  private wire(v: Voice) { if (!this.ctx || v.gain) return; try { const g = this.ctx.createGain(); this.ctx.createMediaElementSource(v.el).connect(g).connect(this.analyser ?? this.ctx.destination); v.gain = g; } catch { v.gain = null; } }
  private set(v: Voice, x: number) { if (v.gain) { v.gain.gain.cancelScheduledValues(0); v.gain.gain.value = x; } else v.el.volume = x; }
  private ramp(v: Voice, dir: "in" | "out", done?: () => void) {
    this.cancel(v); const c = curve(dir);
    if (v.gain && this.ctx) { const g = v.gain.gain; g.cancelScheduledValues(this.ctx.currentTime); g.setValueCurveAtTime(c, this.ctx.currentTime, this.fadeMs / 1000); }
    else { const t0 = performance.now(); const step = () => { const t = Math.min(1, (performance.now() - t0) / this.fadeMs); v.el.volume = c[Math.round(t * (STEPS - 1))]; if (t < 1) v.raf = requestAnimationFrame(step); }; v.raf = requestAnimationFrame(step); }
    if (done) v.timer = setTimeout(done, this.fadeMs + 20);
  }
  private cancel(v: Voice) { if (v.raf) cancelAnimationFrame(v.raf); if (v.timer) clearTimeout(v.timer); v.raf = v.timer = undefined; }
  private hard(v: Voice) { this.cancel(v); if (v.live) { v.live.stop(); return; } v.el.pause(); this.set(v, 0); }
  private emit() { this.onChange({ current: this.current && !isPaused(this.current) ? this.current.src : null, fading: this.fading?.src ?? null }); }

  /** Call inside the first user gesture: creates/resumes the AudioContext (iOS unlock). */
  unlock() {
    if (!this.ctx) { const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext; if (AC) { try { this.ctx = new AC(); const a = this.ctx.createAnalyser(); a.fftSize = 2048; a.smoothingTimeConstant = 0; a.connect(this.ctx.destination); this.analyser = a; } catch { this.ctx = null; } } for (const v of this.pool.values()) this.wire(v); }
    void this.ctx?.resume().catch(() => undefined);
    // Bless every warm element now (silent play+pause inside the gesture) so later scroll switches can autoplay.
    for (const v of this.pool.values()) if (v !== this.current && v.el.paused) { this.set(v, 0); const p = v.el.play(); v.el.pause(); void p?.catch(() => undefined); }
  }

  /** Crossfade to src (null = fade everything out). */
  async play(src: string | null): Promise<boolean> {
    this.seq++;
    if (this.fading) { const f = this.fading; this.fading = null; if (f !== this.current) this.hard(f); }
    const prev = this.current;
    if (src && prev?.src === src) { if (prev.el.paused) { this.set(prev, 1); try { await prev.el.play(); } catch { return false; } } this.emit(); return true; }
    this.fadeOut(prev);
    this.current = null;
    if (!src) { this.emit(); return true; }
    const v = this.voice(src); this.current = v; this.set(v, 1);
    try { await v.el.play(); } catch { if (this.current === v) this.current = null; this.emit(); return false; }
    if (this.current !== v) return false;
    this.unlocked = true; this.emit(); return true;
  }
  private fadeOut(prev: Voice | null) {
    if (!prev) return;
    this.fading = prev; this.ramp(prev, "out", () => { if (this.fading === prev) { if (prev.live) prev.live.stop(); else prev.el.pause(); this.fading = null; this.emit(); } });
  }
  /** Crossfade to a live SF2 voice for the prepared song (same 58 ms fade, same shared analyser). */
  async playLive(key: string, p: Prepared): Promise<boolean> {
    if (!this.ctx) return false;
    const my = ++this.seq;
    if (this.fading) { const f = this.fading; this.fading = null; if (f !== this.current) this.hard(f); }
    const prev = this.current;
    if (prev?.src === key && prev.live && !prev.live.clock.paused) { this.emit(); return true; }
    this.fadeOut(prev); this.current = null;
    if (this.ctx.state !== "running") await this.ctx.resume().catch(() => undefined);
    let lv: LiveVoice;
    try { lv = await startLive(this.ctx, this.analyser ?? this.ctx.destination, p); } catch { this.emit(); return false; }
    if (my !== this.seq) { lv.stop(); return false; } // superseded while the engine started
    const clock = lv.clock as unknown as HTMLAudioElement;
    this.current = { src: key, el: clock, gain: lv.gain, live: lv }; this.unlocked = true; this.emit(); return true;
  }
  /** Immediate stop of everything (tab hidden, filter change). */
  stop() { this.seq++; for (const v of this.pool.values()) this.hard(v); for (const v of [this.current, this.fading]) if (v?.live) v.live.stop(); this.current = this.fading = null; this.emit(); }
  /** Keep only these sources (plus current/fading) warm; start loading them. */
  preload(srcs: (string | null | undefined)[]) {
    const keep = new Set(srcs.filter((s): s is string => !!s)); for (const s of keep) this.voice(s);
    for (const [s, v] of this.pool) if (!keep.has(s) && v !== this.current && v !== this.fading) { this.hard(v); v.el.removeAttribute("src"); v.el.load(); this.pool.delete(s); this.spares.push(v); }
  }
  get currentIsLive() { return !!this.current?.live; }
  get playingCount() { let n = 0; for (const v of this.pool.values()) if (!v.el.paused) n++; for (const v of [this.current, this.fading]) if (v?.live && !v.live.clock.paused) n++; return n; }
  dispose() { this.stop(); for (const v of [...this.pool.values(), ...this.spares]) { v.el.removeAttribute("src"); v.el.remove(); } this.pool.clear(); this.spares = []; void this.ctx?.close().catch(() => undefined); }
}
