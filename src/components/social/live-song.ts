// Real-time feed playback: the song's project is synthesized live by the same SF2 engine and render plan as the
// studio's WAV export (buildRenderPlan -> planVoices -> one sf2-processor AudioWorklet per audible track, with the
// project's reverb/chorus/voice edits as setup events), but in the page's realtime AudioContext. No prerendered audio.
// Not real time (offline-only): LUFS loudness normalization (a fixed live headroom gain is used instead).
import { buildRenderPlan, type RenderPlan } from "../../audio/offline-renderer.ts";
import { planVoices } from "../../audio/offline-context.ts";
import type { PlanVoice } from "../../audio/parallel-render.ts";
import { loadSoundFont } from "../../audio/soundfont-loader.ts";
import { getShare } from "../../agent/share-client.ts";
import type { Project } from "../../workstation/model.ts";
import { reportError } from "../../telemetry/error-reporter.ts";

export const LIVE_HEADROOM = 0.8;
export interface Prepared { slug: string; plan: RenderPlan; voices: PlanVoice[]; seconds: number }
export interface LiveVoice { gain: GainNode; stop(): void; readonly clock: { currentTime: number; duration: number; paused: boolean } }

const projects = new Map<string, Promise<Project | null>>();
const plans = new Map<string, Promise<Prepared | null>>();
const worklets = new WeakMap<BaseAudioContext, Promise<void>>();

/** Project for a song (cached; null when the share has no playable project, e.g. legacy audio-only uploads). */
export function songProject(slug: string): Promise<Project | null> {
  let p = projects.get(slug);
  if (!p) { p = getShare(slug).then((s) => { const pr = s.project as Project | null; return pr && Array.isArray(pr.notes) && pr.notes.length ? pr : null; }).catch(() => null); projects.set(slug, p); }
  return p;
}
/** Start the SoundFont download early (feed mount); the engine needs it before the first note. */
export function warmSoundFont() { void loadSoundFont().catch((e) => reportError(e, { where: "live-song.warm" })); }

export function prepare(slug: string, sampleRate: number): Promise<Prepared | null> {
  const k = `${slug}@${sampleRate}`; let p = plans.get(k);
  if (!p) {
    p = (async () => {
      const [proj, sfl] = await Promise.all([songProject(slug), loadSoundFont()]);
      if (!proj) return null;
      const plan = buildRenderPlan(structuredClone(proj), sfl.sf, sampleRate);
      if (!plan.audibleNotes) return null;
      return { slug, plan, voices: planVoices(plan), seconds: plan.musicFrames / sampleRate };
    })().catch((e) => { reportError(e, { where: "live-song.prepare" }); plans.delete(k); return null; });
    plans.set(k, p);
    if (plans.size > 12) plans.delete(plans.keys().next().value!);
  }
  return p;
}
export const preparedCount = () => plans.size;
export function prepared(slug: string, sampleRate: number) { return plans.get(`${slug}@${sampleRate}`) ?? null; }

export function loadWorklet(ctx: BaseAudioContext): Promise<void> {
  let w = worklets.get(ctx);
  if (!w) {
    // @ts-ignore Vite query import
    w = (import("../../sf2-processor.ts?worker&url") as Promise<{ default: string }>).then((m) => ctx.audioWorklet.addModule(m.default));
    worklets.set(ctx, w);
  }
  return w;
}

/** Start the prepared song now on ctx -> out, looping at the end (with a short tail). */
export async function startLive(ctx: AudioContext, out: AudioNode, p: Prepared): Promise<LiveVoice> {
  await loadWorklet(ctx);
  const gain = ctx.createGain(); gain.gain.value = 1;
  const bus = ctx.createGain(); bus.gain.value = LIVE_HEADROOM; bus.connect(gain); gain.connect(out);
  const merger = ctx.createChannelMerger(2); merger.connect(bus);
  const nodes: AudioWorkletNode[] = [];
  for (const v of p.voices) {
    const node = new AudioWorkletNode(ctx, "sf2-processor", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.port.postMessage({ type: "setOfflineTracks", tracks: [v.t], maxVoices: 64 });
    const split = ctx.createChannelSplitter(2); node.connect(split);
    for (const [from, to, g] of v.gains) { const gn = ctx.createGain(); gn.gain.value = g; split.connect(gn, from); gn.connect(merger, 0, to); }
    nodes.push(node);
  }
  const loopSec = Math.max(1, p.seconds + 1.5);
  let t0 = ctx.currentTime; let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined;
  const kick = () => { if (stopped) return; t0 = ctx.currentTime; p.voices.forEach((v, i) => nodes[i].port.postMessage({ type: "setSequence", events: v.events })); timer = setTimeout(kick, loopSec * 1000); };
  kick();
  return {
    gain,
    stop: () => { if (stopped) return; stopped = true; clearTimeout(timer); for (const n of nodes) { n.port.postMessage({ type: "setSequence", events: [] }); n.disconnect(); } gain.disconnect(); },
    clock: { get currentTime() { return Math.max(0, ctx.currentTime - t0); }, duration: loopSec, get paused() { return stopped; } },
  };
}
