// Bridge between the headless WorkstationController and the existing player (MidiReader), so the
// workstation reuses the real worker + SF2 AudioWorklet pipeline instead of a second audio path.
import { WorkstationController, type TransportDriver } from "./controller.ts";
import { parseSmf, serializeSmf } from "./smf.ts";
import { secToTick, tickToSec } from "./timing.ts";
import type { Project, TrackMix } from "./model.ts";
import type { SF2Region } from "../sf2/soundfont.ts";
import { renderProjectOffline, setLivePresetOverridesProvider } from "../audio/offline-renderer.ts";
import { bindRendererSoundFont } from "../audio/renderer-host.ts";
import { normalizeEffects, type EffectsParams, type VoiceOverride } from "../sf2/voice-overrides.ts";

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
  /** Player track index -> SF2 generator overrides (applied at note-on; realtime ones also to sounding voices). */
  setTrackVoice?(trackIndex: number, overrides: VoiceOverride[]): void;
  /** Global reverb / chorus parameters for every track engine and the offline render. */
  setEffects?(params: EffectsParams): void;
  /** Resolved preset + zones of a player track. */
  /** Preset index the user pinned on this player track (track menu), or null. */
  getTrackPresetOverride?(trackIndex: number): number | null;
  getTrackRegions?(trackIndex: number): { presetName: string; presetIndex: number; regions: SF2Region[] } | null;
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
    if (isSessionRestore && this.ctrl.project.revision > 0 && (this.ctrl.project.name === nm || this.ctrl.project.meta?.owner === "agent")) return;
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
    return wait.then(() => this.applyMix(p));
  }
  /** Effective mix = temporary override ?? persisted default; serialized track i -> player track i+1. */
  applyMix(p?: Project) {
    const c = this.ctrl, h = this.handle; if (!c || !h) return;
    const { overrides } = c.getState();
    const project = p ?? c.getState().project;
    project.tracks.forEach((t, i) => h.setTrackMix(i + 1, { ...t.mix, ...(overrides[t.id] ?? {}) }));
    this.applySound(project);
  }
  /** Sound layer of `project` (committed, or a proposal candidate while previewing B) -> engines. */
  applySound(project: Project) {
    const h = this.handle; if (!h) return;
    project.tracks.forEach((t, i) => h.setTrackVoice?.(i + 1, project.sound?.tracks[t.id] ?? []));
    h.setEffects?.(normalizeEffects(project.sound?.effects));
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
    const key = JSON.stringify([s.project.tracks.map((t) => t.mix), s.overrides, s.project.sound ?? null]);
    if (key === lastMixKey) return; lastMixKey = key;
    if (playerBridge.loadedProjectId === s.project.id) playerBridge.applyMix();
  });
  c.attachDriver(driverFor(c));
  // Headless: no player, no AudioContext, no unlock. Same renderer as the player's Export WAV and gbk_render_wav.
  c.host.renderWav = async (project, signal, normalize) => (await renderProjectOffline(project, { sampleRate: 44100, channels: 2, format: "pcm16", tailSeconds: 3, normalize }, signal)).blob;
  c.host.checkpoint = async (project) => {
    if (typeof indexedDB === "undefined") throw new Error("IndexedDB unavailable");
    const { midiFileStore } = await import("../midi-file-store.ts");
    const { PROJECT_SCHEMA_VERSION } = await import("./model.ts");
    await midiFileStore.putProject({ id: project.id, schemaVersion: PROJECT_SCHEMA_VERSION, savedAt: Date.now(), project });
  };
  // Offline renders of the project the player has loaded use the player's pinned per-track presets (live parity).
  setLivePresetOverridesProvider((project) => {
    const h = playerBridge.handle;
    if (!h?.getTrackPresetOverride || playerBridge.loadedProjectId !== project.id) return undefined;
    const out: Record<string, number> = {};
    project.tracks.forEach((t, i) => { const ov = h.getTrackPresetOverride!(i + 1); if (ov != null) out[t.id] = ov; });
    return Object.keys(out).length ? out : undefined;
  });
  bindRendererSoundFont(c);
  c.host.download = (data, filename) => {
    const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: "audio/midi" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return true;
  };
}
