// Bridge between the headless WorkstationController and the existing player (MidiReader), so the
// workstation reuses the real worker + SF2 AudioWorklet pipeline instead of a second audio path.
import { WorkstationController, type TransportDriver } from "./controller.ts";
import { parseSmf, serializeSmf } from "./smf.ts";
import { secToTick, tickToSec } from "./timing.ts";
import type { Project, TrackMix } from "./model.ts";

export interface PlayerHandle {
  /** Load SMF bytes into the player (does not persist into the playlist). */
  loadBuffer(buf: ArrayBuffer, name: string, opts: { autoplay: boolean; restoreSec: number }): void;
  unlockAudio(): Promise<void>;
  pause(): void;
  seek(sec: number): void;
  isReady(): boolean;
  exportWav(onBlob: (b: Blob) => void): Promise<void>;
  /** Player track index (SMF order; 0 = conductor) -> mix (base layer). */
  setTrackMix(trackIndex: number, mix: TrackMix): void;
  /** Kick the default SoundFont download if none is loaded/loading. */
  requestSf2(): void;
}

type Listener = () => void;
class PlayerBridge {
  handle: PlayerHandle | null = null;
  /** Revision of the project currently loaded in the player (null = player holds a non-project song). */
  loadedRevision: number | null = null;
  loadedProjectId: string | null = null;
  private songWaiters: Listener[] = [];
  private suppressNextImport = false;
  /** Set when an edited project was restored from IndexedDB; the player's startup re-load of the same song must not clobber it. */
  restored = false;
  ctrl: WorkstationController | null = null;

  attach(h: PlayerHandle | null) { this.handle = h; this.ctrl?.attachDriver(this.ctrl ? driverFor(this.ctrl) : null); }
  /** Player loaded a song the user picked (playlist/upload/Bach/sheet). Mirror it into the workstation. */
  onPlayerLoadedBuffer(buf: ArrayBuffer, name: string, isSessionRestore = false) {
    if (this.suppressNextImport) { this.suppressNextImport = false; return; }
    if (!this.ctrl) return;
    const nm = name.replace(/\.(mid|midi)$/i, "");
    // Player re-opening its last song on startup must not clobber the edited project restored from IndexedDB.
    if (isSessionRestore && this.ctrl.project.revision > 0 && this.ctrl.project.name === nm) return;
    try {
      const p = parseSmf(buf, name.replace(/\.(mid|midi)$/i, ""));
      this.ctrl.load(p);
      this.loadedRevision = p.revision; this.loadedProjectId = p.id;
    } catch { /* unsupported file: leave project unchanged */ }
  }
  onSongLoaded() { const w = this.songWaiters; this.songWaiters = []; w.forEach((f) => f()); }
  onTime(sec: number) { const c = this.ctrl; if (!c) return; c.updateTransport({ positionTick: secToTick(c.project, sec) }); }
  onPlaying(playing: boolean) { this.ctrl?.updateTransport({ playing, audioReady: !!this.handle?.isReady() }); }
  onReady() { this.ctrl?.updateTransport({ audioReady: !!this.handle?.isReady() }); }

  waitSong(): Promise<void> { return new Promise((r) => this.songWaiters.push(r)); }
  loadProject(p: Project, autoplay: boolean, startSec: number): Promise<void> {
    const h = this.handle!;
    const bytes = serializeSmf(p);
    const wait = this.waitSong();
    this.suppressNextImport = true;
    h.loadBuffer(bytes.buffer.slice(0) as ArrayBuffer, `${p.name}.mid`, { autoplay, restoreSec: startSec });
    this.loadedRevision = p.revision; this.loadedProjectId = p.id;
    return wait.then(() => this.applyMix());
  }
  /** Effective mix = temporary override ?? persisted default; serialized track i -> player track i+1. */
  applyMix() {
    const c = this.ctrl, h = this.handle; if (!c || !h) return;
    const { project, overrides } = c.getState();
    project.tracks.forEach((t, i) => h.setTrackMix(i + 1, { ...t.mix, ...(overrides[t.id] ?? {}) }));
  }
  inSync(p: Project) { return this.loadedProjectId === p.id && this.loadedRevision === p.revision; }
}
export const playerBridge = new PlayerBridge();

export function driverFor(c: WorkstationController): TransportDriver {
  const b = playerBridge;
  return {
    isAudioReady: () => !!b.handle?.isReady(),
    async prepare() {
      const h = b.handle; if (!h) return false;
      try { await h.unlockAudio(); } catch { return false; }
      h.requestSf2();
      for (let i = 0; i < 240 && !h.isReady(); i++) await new Promise((r) => setTimeout(r, 250));
      return h.isReady();
    },
    async play(fromTick) {
      const h = b.handle!; await h.unlockAudio();
      const sec = tickToSec(c.project, fromTick);
      // Same project+revision already in the worker: just seek+play; otherwise re-sync from the model.
      await b.loadProject(c.project, true, sec);
    },
    pause: () => b.handle?.pause(),
    stop: () => { b.handle?.pause(); b.handle?.seek(0); },
    seek: (tick) => b.handle?.seek(tickToSec(c.project, tick)),
    async preview(project, startTick, endTick, signal) {
      const h = b.handle!; await h.unlockAudio();
      const startSec = tickToSec(project, startTick);
      const lenMs = Math.min(30_000, Math.max(250, (tickToSec(project, endTick) - startSec) * 1000));
      await b.loadProject({ ...project, name: `${c.project.name}` }, true, startSec);
      await new Promise<void>((res) => { const t = setTimeout(res, lenMs); signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true }); });
      h.pause();
      await b.loadProject(c.project, false, startSec); // restore the committed project in the player
    },
  };
}

export function bindController(c: WorkstationController) {
  playerBridge.ctrl = c;
  let lastMixKey = "";
  c.subscribe((s) => {
    const key = JSON.stringify([s.project.tracks.map((t) => t.mix), s.overrides]);
    if (key === lastMixKey) return; lastMixKey = key;
    if (playerBridge.loadedProjectId === s.project.id) playerBridge.applyMix();
  });
  c.attachDriver(driverFor(c));
  c.host.renderWav = async (project) => {
    const h = playerBridge.handle;
    if (!h) throw new Error("player not mounted");
    if (!h.isReady() && !(await driverFor(c).prepare!())) throw Object.assign(new Error("Load a SoundFont first"), { code: "AUDIO_NOT_READY" });
    if (!playerBridge.inSync(project)) await playerBridge.loadProject(project, false, 0);
    await new Promise((r) => setTimeout(r, 0));
    let blob: Blob | null = null;
    await playerBridge.handle!.exportWav((b) => { blob = b; });
    if (!blob) throw new Error("WAV export failed");
    return blob;
  };
  c.host.download = (data, filename) => {
    const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: "audio/midi" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}
