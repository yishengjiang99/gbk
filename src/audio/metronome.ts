// Studio metronome: a short click on every beat while the transport plays (accent on the bar's first beat).
// Follows the workstation playhead (ticks + the project's meter), so tempo changes, seeks and loops just work.
import type { WorkstationController } from "../workstation/controller.ts";
import { tickToBarBeat } from "../workstation/timing.ts";

export class Metronome {
  private ctx: AudioContext | null = null; private raf = 0; private last = ""; on = false; /** Clicks played (tests + diagnostics). */ clicks = 0; /** Playhead tick of recent clicks (tests + diagnostics). */ clickTicks: number[] = [];
  constructor(private c: WorkstationController) {}
  /** Must run inside the click that enables it (autoplay policy). */
  setOn(on: boolean) {
    this.on = on; cancelAnimationFrame(this.raf); this.last = "";
    if (!on) return;
    try { this.ctx ??= new AudioContext(); void this.ctx.resume(); } catch { this.on = false; return; }
    const loop = () => {
      const t = this.c.getState().transport;
      if (t.playing) {
        const bb = tickToBarBeat(this.c.project, t.positionTick); const key = `${bb.bar}:${Math.floor(bb.beat)}`;
        // First frame after Play: click if the start is on (or just past) a beat, so the downbeat is heard;
        // a start mid-beat waits for the next beat. Afterwards every beat change clicks.
        if (key !== this.last) { if (this.last || bb.beat - Math.floor(bb.beat) < 0.3) { this.click(Math.floor(bb.beat) === 0); this.clickTicks = [...this.clickTicks.slice(-31), t.positionTick]; } this.last = key; }
      } else this.last = "";
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  private click(accent: boolean) {
    const a = this.ctx; if (!a) return; this.clicks++;
    const o = a.createOscillator(), g = a.createGain(), t0 = a.currentTime;
    o.frequency.value = accent ? 1760 : 1175; g.gain.setValueAtTime(accent ? 0.35 : 0.22, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);
    o.connect(g).connect(a.destination); o.start(t0); o.stop(t0 + 0.07);
  }
}
