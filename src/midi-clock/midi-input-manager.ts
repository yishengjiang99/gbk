// Web MIDI input wiring with explicit listener bookkeeping, so hot-plugging never leaves duplicate listeners.
// Structural types only: runs against the real Web MIDI API or the fakes used in tests.

export interface MidiInputLike {
  id: string;
  name?: string | null;
  state?: string;
  addEventListener(type: "midimessage", fn: (e: MidiMessageEventLike) => void): void;
  removeEventListener(type: "midimessage", fn: (e: MidiMessageEventLike) => void): void;
}
export interface MidiMessageEventLike {
  data: Uint8Array | ArrayLike<number> | null;
  timeStamp: number;
}
export interface MidiAccessLike {
  inputs: { forEach(cb: (input: MidiInputLike) => void): void };
  addEventListener(type: "statechange", fn: () => void): void;
  removeEventListener(type: "statechange", fn: () => void): void;
}

export interface MidiInputManagerOptions {
  /** Receives every real-time message (status 0xF8..0xFF) with the event timestamp. */
  onRealtime(status: number, timeStampMs: number): void;
  /** The currently selected input disappeared (unplugged / disconnected). */
  onInputLost(id: string): void;
  onInputsChanged?(inputs: { id: string; name: string }[]): void;
  /** Used when an event carries timeStamp 0/undefined. */
  now(): number;
}

export class MidiInputManager {
  private access: MidiAccessLike | null = null;
  private selectedId: string | null = null;
  private attached: MidiInputLike | null = null;
  private readonly handler = (e: MidiMessageEventLike) => {
    const d = e.data;
    if (!d || d.length === 0) return;
    const status = d[0];
    if (status >= 0xf8) this.opts.onRealtime(status, e.timeStamp > 0 ? e.timeStamp : this.opts.now());
  };
  private readonly onState = () => this.refresh();

  constructor(private readonly opts: MidiInputManagerOptions) {}

  get listenerCount(): number { return this.attached ? 1 : 0; }
  get selected(): string | null { return this.selectedId; }

  attach(access: MidiAccessLike): void {
    this.detachAccess();
    this.access = access;
    access.addEventListener("statechange", this.onState);
    this.refresh();
  }

  select(id: string | null): void {
    this.selectedId = id;
    this.refresh();
  }

  private connectedInputs(): MidiInputLike[] {
    const list: MidiInputLike[] = [];
    this.access?.inputs.forEach((i) => { if (i.state !== "disconnected") list.push(i); });
    return list;
  }

  /** Reconcile listeners with the current device list. Idempotent. */
  private refresh(): void {
    const inputs = this.connectedInputs();
    this.opts.onInputsChanged?.(inputs.map((i) => ({ id: i.id, name: i.name || i.id })));
    const wanted = this.selectedId ? inputs.find((i) => i.id === this.selectedId) ?? null : null;
    if (this.attached && this.attached !== wanted) {
      const lost = !wanted || wanted.id === this.attached.id;
      const lostId = this.attached.id;
      this.attached.removeEventListener("midimessage", this.handler);
      this.attached = null;
      if (lost && !wanted) this.opts.onInputLost(lostId);
    }
    // Same port id re-enumerated as a new object after replug: re-attach exactly once.
    if (wanted && this.attached !== wanted) {
      wanted.addEventListener("midimessage", this.handler);
      this.attached = wanted;
    }
  }

  private detachAccess(): void {
    if (this.attached) { this.attached.removeEventListener("midimessage", this.handler); this.attached = null; }
    if (this.access) { this.access.removeEventListener("statechange", this.onState); this.access = null; }
  }

  /** Remove every listener this manager added. */
  dispose(): void {
    this.detachAccess();
    this.selectedId = null;
  }
}
