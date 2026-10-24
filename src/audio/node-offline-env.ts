// Node OfflineAudioContext + AudioWorkletNode (Node has no Web Audio). Runs the app's own sf2-processor core per
// 128-frame quantum and implements exactly the node types the offline renderer wires (splitter, gain, merger,
// destination), suspend()/resume() and startRendering(). Used by the server's headless render worker and the unit
// tests; browsers use their real OfflineAudioContext (browserOfflineEnv in offline-context.ts).
import { Sf2ProcessorCore } from "../sf2-processor-core.ts";
import type { SynthEvent } from "../sf2-renderer.ts";
import type { OfflineEnv, OfflineCtx } from "./offline-context.ts";

const Q = 128;
type Buf = Float32Array[];
interface Edge { src: NodeBase; out: number; dst: NodeBase; inp: number }

abstract class NodeBase {
  constructor(readonly context: NodeOfflineAudioContext) {}
  connect(dst: NodeBase, out = 0, inp = 0) { this.context.edges.push({ src: this, out, dst, inp }); return dst; }
  disconnect() { this.context.edges = this.context.edges.filter((e) => e.src !== this); }
  private cacheBlock = -1; private cache: Buf[] = [];
  output(i: number, block: number): Buf { if (this.cacheBlock !== block) { this.cache = this.compute(block); this.cacheBlock = block; } return this.cache[i] ?? []; }
  protected input(i: number, block: number): Buf {
    const acc: Buf = [];
    for (const e of this.context.edges) if (e.dst === this && e.inp === i) {
      const b = e.src.output(e.out, block);
      b.forEach((ch, c) => { const a = (acc[c] ??= new Float32Array(Q)); for (let k = 0; k < Q; k++) a[k] += ch[k]; });
    }
    return acc;
  }
  protected abstract compute(block: number): Buf[];
}
class Dest extends NodeBase { protected compute(b: number) { return [this.input(0, b)]; } }
class Splitter extends NodeBase { protected compute(b: number) { const x = this.input(0, b); return [[x[0] ?? new Float32Array(Q)], [x[1] ?? new Float32Array(Q)]]; } }
class Merger extends NodeBase { protected compute(b: number) { return [[this.input(0, b)[0] ?? new Float32Array(Q), this.input(1, b)[0] ?? new Float32Array(Q)]]; } }
class Gain extends NodeBase { gain = { value: 1 }; protected compute(b: number) { return [this.input(0, b).map((ch) => ch.map((v) => v * this.gain.value))]; } }

export class NodeAudioWorkletNode extends NodeBase {
  private core: Sf2ProcessorCore;
  readonly port: { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown): void };
  constructor(ctx: NodeOfflineAudioContext, name: string) {
    super(ctx);
    if (name !== "sf2-processor" || !ctx.audioWorklet.loaded) throw new Error(`AudioWorkletNode: processor ${name} is not registered`);
    const port = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: (m: unknown) => this.core.onMsg(m as SynthEvent) };
    this.port = port;
    this.core = new Sf2ProcessorCore(ctx.sampleRate, (m) => setTimeout(() => port.onmessage?.({ data: m } as MessageEvent), 0));
  }
  protected compute() { const L = new Float32Array(Q), R = new Float32Array(Q); this.core.process(L, R); return [[L, R]]; }
}

export class NodeOfflineAudioContext {
  static created = 0;
  edges: Edge[] = [];
  readonly destination: NodeBase = new Dest(this);
  readonly audioWorklet = { loaded: false, addModule: async (_url: string) => { this.audioWorklet.loaded = true; } };
  private suspends = new Map<number, () => void>();
  private resumeWait: (() => void) | null = null;
  state = "suspended";
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) { NodeOfflineAudioContext.created++; }
  createChannelSplitter() { return new Splitter(this); }
  createChannelMerger() { return new Merger(this); }
  createGain() { return new Gain(this); }
  suspend(t: number) { const f = Math.round((t * this.sampleRate) / Q) * Q; return new Promise<void>((res) => this.suspends.set(f, res)); }
  resume() { const r = this.resumeWait; this.resumeWait = null; r?.(); return Promise.resolve(); }
  async startRendering() {
    this.state = "running";
    const out = Array.from({ length: this.numberOfChannels }, () => new Float32Array(this.length));
    for (let f = 0, b = 0; f < this.length; f += Q, b++) {
      const s = this.suspends.get(f);
      if (s) { this.suspends.delete(f); this.state = "suspended"; await new Promise<void>((res) => { this.resumeWait = res; s(); }); this.state = "running"; }
      const x = this.destination.output(0, b); const n = Math.min(Q, this.length - f);
      for (let c = 0; c < out.length; c++) if (x[c]) out[c].set(x[c].subarray(0, n), f);
      if ((b & 255) === 255) await new Promise((r) => setTimeout(r, 0));
    }
    this.state = "closed";
    return { numberOfChannels: this.numberOfChannels, length: this.length, sampleRate: this.sampleRate, getChannelData: (c: number) => out[c] } as unknown as AudioBuffer;
  }
}


/** OfflineEnv backed by the Node implementation above (no globals touched). */
export function nodeOfflineEnv(): OfflineEnv {
  return {
    createContext: (c, l, sr) => { const ctx = new NodeOfflineAudioContext(c, l, sr); ctx.audioWorklet.loaded = true; return ctx as unknown as OfflineCtx; },
    createWorkletNode: (ctx, name) => new NodeAudioWorkletNode(ctx as unknown as NodeOfflineAudioContext, name) as unknown as AudioWorkletNode,
    workletUrl: async () => "node:sf2-processor",
  };
}
