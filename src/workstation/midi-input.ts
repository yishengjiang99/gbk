// Web MIDI input for the live keyboard: device selection, hot-plug, permission/unsupported messages.
// Every message from the chosen input (or all inputs) goes to onMessage; LiveInputSession routes it to the selected track.
import { isMidiPermissionDeniedError } from "../midi-driver.ts";

export type MidiInputStatus =
  | { kind: "off"; message: string }
  | { kind: "unsupported"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; message: string };
export interface MidiInputDevice { id: string; name: string; manufacturer: string; state: string }

interface InputLike { id: string; name?: string | null; manufacturer?: string | null; state?: string; addEventListener(t: "midimessage", f: (e: { data: Uint8Array | null; timeStamp?: number }) => void): void; removeEventListener(t: "midimessage", f: (e: { data: Uint8Array | null }) => void): void }
interface AccessLike { inputs: { values(): IterableIterator<InputLike> }; onstatechange: ((e: unknown) => void) | null }
export interface NavigatorLike { requestMIDIAccess?: (o?: { sysex?: boolean }) => Promise<AccessLike> }

export const MIDI_UNSUPPORTED_MESSAGE = "This browser has no Web MIDI (Safari and iOS do not support it). Use Chrome, Edge or Firefox for a MIDI keyboard; the on-screen and computer keyboard still work.";
export const MIDI_DENIED_MESSAGE = "MIDI permission was denied. Allow MIDI devices for this site in the browser's site settings, then press Enable MIDI again.";

export class MidiInputManager {
  status: MidiInputStatus = { kind: "off", message: "MIDI input off" };
  devices: MidiInputDevice[] = [];
  selectedId = "all";
  private access: AccessLike | null = null;
  private attached = new Map<string, { input: InputLike; fn: (e: { data: Uint8Array | null }) => void }>();
  private listeners = new Set<() => void>();
  constructor(private nav: NavigatorLike | undefined, private onMessage: (data: Uint8Array, deviceId: string) => void) {}
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { for (const l of this.listeners) l(); }
  get supported(): boolean { return typeof this.nav?.requestMIDIAccess === "function"; }

  async enable(): Promise<MidiInputStatus> {
    if (!this.supported) { this.status = { kind: "unsupported", message: MIDI_UNSUPPORTED_MESSAGE }; this.emit(); return this.status; }
    try {
      this.access = await this.nav!.requestMIDIAccess!({ sysex: false });
    } catch (e) {
      this.status = isMidiPermissionDeniedError(e) || (e as { name?: string })?.name === "SecurityError" ? { kind: "denied", message: MIDI_DENIED_MESSAGE } : { kind: "error", message: `MIDI unavailable: ${(e as Error)?.message ?? String(e)}` };
      this.emit(); return this.status;
    }
    this.access.onstatechange = () => this.refresh(); // hot-plug: devices appear / disappear live
    this.refresh();
    return this.status;
  }
  disable() {
    if (this.access) this.access.onstatechange = null;
    for (const id of [...this.attached.keys()]) this.detach(id);
    this.access = null; this.devices = []; this.status = { kind: "off", message: "MIDI input off" }; this.emit();
  }
  select(id: string) { this.selectedId = id || "all"; this.refresh(); }

  private detach(id: string) { const r = this.attached.get(id); if (!r) return; r.input.removeEventListener("midimessage", r.fn); this.attached.delete(id); }
  private refresh() {
    if (!this.access) return;
    const live = [...this.access.inputs.values()].filter((i) => i.state !== "disconnected");
    const ids = new Set(live.map((i) => i.id));
    for (const id of [...this.attached.keys()]) if (!ids.has(id)) this.detach(id);
    for (const input of live) if (!this.attached.has(input.id)) {
      const fn = (e: { data: Uint8Array | null }) => { if (e.data && (this.selectedId === "all" || this.selectedId === input.id)) this.onMessage(e.data, input.id); };
      input.addEventListener("midimessage", fn); this.attached.set(input.id, { input, fn });
    }
    this.devices = live.map((i) => ({ id: i.id, name: i.name || i.id, manufacturer: i.manufacturer ?? "", state: i.state ?? "connected" }));
    const sel = this.selectedId === "all" ? null : this.devices.find((d) => d.id === this.selectedId);
    const message = !this.devices.length ? "MIDI ready: no input devices. Plug one in (detected automatically)."
      : this.selectedId !== "all" && !sel ? "Selected MIDI device disconnected; reconnect it or choose another."
      : `MIDI ready: ${sel ? sel.name : `all inputs (${this.devices.length})`}`;
    this.status = { kind: "ready", message };
    this.emit();
  }
}
