// Entry for midi-clock.html: wires the DOM to MidiClockFollower. No framework.

import clickProcessorUrl from "./click-processor.ts?worker&url";
import { MidiClockFollower } from "./follower.ts";
import type { ClockStatus } from "./protocol.ts";
import type { MidiAccessLike } from "./midi-input-manager.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const follower = new MidiClockFollower({
  createWorker: () => new Worker(new URL("./midi-clock.worker.ts", import.meta.url), { type: "module" }),
  createAudioContext: () => new AudioContext({ latencyHint: "interactive" }),
  createClickNode: (ctx) =>
    new AudioWorkletNode(ctx as AudioContext, "midi-click", { numberOfInputs: 0, outputChannelCount: [2] }),
  clickProcessorUrl,
  now: () => performance.now(),
  timeOrigin: () => performance.timeOrigin,
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (h) => window.clearInterval(h as number),
  requestMidiAccess: () => navigator.requestMIDIAccess({ sysex: false }) as unknown as Promise<MidiAccessLike>,
  onStatus: render,
  onInputsChanged: (inputs) => {
    const sel = $<HTMLSelectElement>("source");
    const keep = sel.value;
    sel.innerHTML = '<option value="synthetic">Synthetic 120 BPM</option>';
    for (const i of inputs) {
      const o = document.createElement("option");
      o.value = i.id;
      o.textContent = i.name;
      sel.appendChild(o);
    }
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  },
});

let status: ClockStatus | null = null;
let rafId = 0;

function render(s: ClockStatus): void {
  status = s;
  const stateEl = $("state");
  stateEl.textContent = s.state === "lost" ? `sync lost (${s.lostReason})` : s.state;
  stateEl.dataset.state = s.state;
  $("bpm").textContent = s.bpm > 0 ? s.bpm.toFixed(1) : "--";
  $("phase-text").textContent = s.phase >= 0 ? `phase ${s.phase.toFixed(2)}` : "phase --";
  $("d-sync").textContent = s.synced ? "locked" : s.state === "lost" ? `lost (${s.lostReason})` : "no clock";
  $("d-beat").textContent = s.beat >= 0 ? `${s.beat} / ${s.songTick}` : "--";
  $("d-counts").textContent = `${s.resyncs} / ${s.duplicates} / ${s.gapTicks}`;
  $("d-clicks").textContent = String(follower.clickTotal);
  const ctx = follower.audioContext;
  $("d-audio").textContent = ctx ? `${ctx.state}, t=${ctx.currentTime.toFixed(2)}s, domain samples ${follower.domainMap.samples}` : "off";
}

// Smooth phase bar between ~20 Hz status messages (extrapolated from the last status).
function frame(): void {
  const s = status;
  const bar = $("phasebar");
  const dots = $("beats").children;
  if (s && s.running && s.phase >= 0 && s.beatPeriodMs > 0) {
    const elapsed = performance.now() - s.atMs;
    const pos = s.beat + s.phase + elapsed / s.beatPeriodMs;
    const beat = Math.floor(pos);
    bar.style.width = `${(pos - beat) * 100}%`;
    for (let i = 0; i < dots.length; i++) dots[i].classList.toggle("on", i === beat % 4);
  } else {
    bar.style.width = "0";
    for (let i = 0; i < dots.length; i++) dots[i].classList.remove("on");
  }
  rafId = requestAnimationFrame(frame);
}

async function ensureStarted(): Promise<void> {
  await follower.start();
  $<HTMLButtonElement>("power").textContent = "Audio on";
  $<HTMLButtonElement>("power").disabled = true;
}

$("power").addEventListener("click", () => { void ensureStarted(); });

$("source").addEventListener("change", () => {
  const v = $<HTMLSelectElement>("source").value;
  const synth = follower.syntheticSource();
  if (v === "synthetic") { follower.selectMidiInput(null); synth.connect(); }
  else { synth.disconnect(); follower.selectMidiInput(v); }
});

$("connect-midi").addEventListener("click", async () => {
  try {
    await follower.connectMidi();
  } catch (err) {
    $("connect-midi").textContent = `Web MIDI unavailable: ${(err as Error).message}`;
  }
});

function synthControls(): void {
  const synth = follower.syntheticSource();
  const bind = (id: string, apply: (v: number) => void): void => {
    const el = $<HTMLInputElement>(id);
    const out = $<HTMLOutputElement>(`${id}-out`);
    const update = (): void => { out.textContent = el.value; apply(Number(el.value)); };
    el.addEventListener("input", update);
    update();
  };
  bind("synth-bpm", (v) => synth.setBpm(v));
  bind("synth-jitter", (v) => { synth.jitterMs = v; });
  bind("synth-drop", (v) => { synth.dropProbability = v / 100; });
  const needsSource = (fn: () => void) => async () => { await ensureStarted(); synth.connect(); fn(); };
  $("synth-start").addEventListener("click", needsSource(() => synth.sendStart()));
  $("synth-continue").addEventListener("click", needsSource(() => synth.sendContinue()));
  $("synth-stop").addEventListener("click", needsSource(() => synth.sendStop()));
  $("synth-silent").addEventListener("click", () => synth.disconnect());
  $("synth-unplug").addEventListener("click", () => { synth.disconnect(); follower.feed(0x100, performance.now()); });
  $("synth-replug").addEventListener("click", () => synth.connect());
}
synthControls();

rafId = requestAnimationFrame(frame);

window.addEventListener("pagehide", () => {
  cancelAnimationFrame(rafId);
  void follower.dispose();
});

// Test/debug hook used by the headless verification script.
(window as unknown as { __midiClock: unknown }).__midiClock = {
  follower,
  ensureStarted,
  status: () => status,
  clicks: () => follower.clickLog.slice(),
};
