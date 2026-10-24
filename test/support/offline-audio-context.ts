// Test-only stand-in for the browser's OfflineAudioContext + AudioWorkletNode (Node has no Web Audio). It runs the
// real sf2-processor core per 128-frame quantum and implements exactly the node types the renderer wires
// (splitter, gain, merger, destination), suspend()/resume() and startRendering(). Installed with --import for the
// unit tests; production code only ever sees the browser's real OfflineAudioContext.
import { Sf2ProcessorCore } from "../../src/sf2-processor-core.ts";
import type { SynthEvent } from "../../src/sf2-renderer.ts";

const Q = 128;
type Buf = Float32Array[];
interface Edge { src: FakeNode; out: number; dst: FakeNode; inp: number }

abstract class FakeNode {
  constructor(readonly context: FakeOfflineAudioContext) {}
  connect(dst: FakeNode, out = 0, inp = 0) { this.context.edges.push({ src: this, out, dst, inp }); return dst; }
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
class Dest extends FakeNode { protected compute(b: number) { return [this.input(0, b)]; } }
class Splitter extends FakeNode { protected compute(b: number) { const x = this.input(0, b); return [[x[0] ?? new Float32Array(Q)], [x[1] ?? new Float32Array(Q)]]; } }
class Merger extends FakeNode { protected compute(b: number) { return [[this.input(0, b)[0] ?? new Float32Array(Q), this.input(1, b)[0] ?? new Float32Array(Q)]]; } }
class Gain extends FakeNode { gain = { value: 1 }; protected compute(b: number) { return [this.input(0, b).map((ch) => ch.map((v) => v * this.gain.value))]; } }

export class FakeAudioWorkletNode extends FakeNode {
  private core: Sf2ProcessorCore;
  readonly port: { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown): void };
  constructor(ctx: FakeOfflineAudioContext, name: string) {
    super(ctx);
    if (name !== "sf2-processor" || !ctx.audioWorklet.loaded) throw new Error(`AudioWorkletNode: processor ${name} is not registered`);
    const port = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: (m: unknown) => this.core.onMsg(m as SynthEvent) };
    this.port = port;
    this.core = new Sf2ProcessorCore(ctx.sampleRate, (m) => setTimeout(() => port.onmessage?.({ data: m } as MessageEvent), 0));
  }
  protected compute() { const L = new Float32Array(Q), R = new Float32Array(Q); this.core.process(L, R); return [[L, R]]; }
}

export class FakeOfflineAudioContext {
  static created = 0;
  edges: Edge[] = [];
  readonly destination: FakeNode = new Dest(this);
  readonly audioWorklet = { loaded: false, addModule: async (_url: string) => { this.audioWorklet.loaded = true; } };
  private suspends = new Map<number, () => void>();
  private resumeWait: (() => void) | null = null;
  state = "suspended";
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) { FakeOfflineAudioContext.created++; }
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
      if ((b & 255) === 255) await new Promise((r) => setImmediate(r));
    }
    this.state = "closed";
    return { numberOfChannels: this.numberOfChannels, length: this.length, sampleRate: this.sampleRate, getChannelData: (c: number) => out[c] } as unknown as AudioBuffer;
  }
}

const g = globalThis as Record<string, unknown>;
g.OfflineAudioContext ??= FakeOfflineAudioContext;
g.AudioWorkletNode ??= FakeAudioWorkletNode;
g.__gbkSf2WorkletUrl ??= "test:sf2-processor";
