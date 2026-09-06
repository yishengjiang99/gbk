import { useEffect, useMemo, useRef, useState } from "react";
import type { SF2Region } from "../sf2-parser.ts";
import {
  BACH_CHARACTER_OPTIONS,
  BACH_COMPLEXITY_OPTIONS,
  BACH_KEY_OPTIONS,
  BACH_LENGTH_OPTIONS,
  BACH_TEMPO_OPTIONS,
  BACH_VOICE_OPTIONS,
  DEFAULT_BACH_CONFIG,
  generateBachMidi,
  type BachCharacter,
  type BachFugueConfig,
  type BachKey,
  type BachLength,
} from "./bach-generator.ts";
import { renderOfflineSequenceToAudioBufferIncremental } from "./sf2-renderer.ts";
import { isSupportedSheetMusicImageFile, parseSheetMusicToMidi } from "./sheet-music-reader.ts";
import { buildMidiSendEvents } from "./midi-output.ts";

// ---------------------------------------------------------------------------
// Local type definitions
// ---------------------------------------------------------------------------

interface NoteRecord {
  note: number;
  velocity: number;
  channel: number;
  startSec: number;
  durationSec: number;
}

interface PlayEvent {
  type: string;
  sec: number;
  seq?: number;
  channel?: number;
  note?: number;
  velocity?: number;
  program?: number;
  bank?: number;
}

interface SongTrack {
  index: number;
  name: string;
  instrumentName: string;
  notes: NoteRecord[];
  playEvents: PlayEvent[];
}

interface Song {
  format: number;
  division: number;
  durationSec: number;
  tracks: SongTrack[];
  totalBars: number;
  bpm: number;
  timeSig: string;
}

type TrackCc = { cc7Volume: number; cc10Pan: number; cc11Expression: number };
type TrackMix = { mute: boolean; solo: boolean };
type PresetOption = { index: number; bank: number; program: number; name: string };
type MidiOption = { name: string; path: string };
type MidiOutputOption = { id: string; name: string };
type TrackNode = { node: AudioWorkletNode; panner: StereoPannerNode; gain: GainNode };
type PlaybackDebugEvent = { type: "playbackDebug"; order: number; [key: string]: unknown };
type MidiSourceKind = "bundled" | "uploaded" | "generated";
type CurrentMidiSource = { kind: MidiSourceKind; name: string; path?: string };
type SheetMusicImageSource = "uploaded" | "sample";
type SelectedSheetMusicImage = { file: File; name: string; previewUrl: string; source: SheetMusicImageSource };
type ClearableMidiOutput = MIDIOutput & { clear?: () => void };
type PersistedMidiState = CurrentMidiSource & {
  version: 1;
  dataUrl?: string;
  currentSec?: number;
  savedAt: number;
};

declare global {
  interface Window {
    __sf2E2e?: {
      playbackEvents: PlaybackDebugEvent[];
    };
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function fmtTime(sec: number): string {
  const s = Math.max(0, sec | 0);
  const m = (s / 60) | 0;
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

const DEFAULT_TRACK_CC: TrackCc = { cc7Volume: 100, cc10Pan: 64, cc11Expression: 127 };
const CURRENT_MIDI_STORAGE_KEY = "sf2-current-midi";
const MAX_PERSISTED_MIDI_BYTES = 4 * 1024 * 1024;
const MIN_TIMELINE_ZOOM = 1;
const MAX_TIMELINE_ZOOM = 18;
const WHEEL_ZOOM_SENSITIVITY = 0.002;
const SWEDEN_SHEET_IMAGE_URL = new URL("../sweden.jpg", import.meta.url).href;

function clampCc(value: number): number {
  return Math.max(0, Math.min(127, Number(value) | 0));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function outputName(output: MIDIOutput): string {
  return output.name || output.manufacturer || output.id;
}

function readPersistedMidiState(): PersistedMidiState | null {
  try {
    const raw = window.localStorage.getItem(CURRENT_MIDI_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedMidiState>;
    if (parsed.version !== 1 || !parsed.name || !parsed.kind) return null;
    if (parsed.kind === "bundled" && !parsed.path) return null;
    if (parsed.kind !== "bundled" && !parsed.dataUrl) return null;
    return parsed as PersistedMidiState;
  } catch {
    return null;
  }
}

function writePersistedMidiState(next: Omit<PersistedMidiState, "version" | "savedAt">): void {
  try {
    window.localStorage.setItem(
      CURRENT_MIDI_STORAGE_KEY,
      JSON.stringify({ ...next, version: 1, savedAt: Date.now() })
    );
  } catch {
    // localStorage can reject larger uploaded MIDI files; playback should still work.
  }
}

function updatePersistedMidiTime(sec: number): void {
  try {
    const current = readPersistedMidiState();
    if (!current) return;
    writePersistedMidiState({ ...current, currentSec: Math.max(0, sec) });
  } catch {
    // no-op
  }
}

function arrayBufferToDataUrl(buffer: ArrayBuffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read MIDI data"));
    reader.readAsDataURL(new Blob([buffer], { type: "audio/midi" }));
  });
}

async function dataUrlToArrayBuffer(dataUrl: string): Promise<ArrayBuffer> {
  const res = await fetch(dataUrl);
  return res.arrayBuffer();
}

function encodeWav(audioBuffer: AudioBuffer): ArrayBuffer {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numSamples = audioBuffer.length;
  const bytesPerSample = 2;
  const dataSize = numChannels * numSamples * bytesPerSample;
  const channelData = Array.from({ length: numChannels }, (_, ch) => audioBuffer.getChannelData(ch));
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, channelData[ch][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return buffer;
}

async function encodeWavIncremental(
  audioBuffer: AudioBuffer,
  chunkSamples = 16384,
  onProgress?: (progress: number) => void
): Promise<ArrayBuffer> {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numSamples = audioBuffer.length;
  const bytesPerSample = 2;
  const dataSize = numChannels * numSamples * bytesPerSample;
  const channelData = Array.from({ length: numChannels }, (_, ch) => audioBuffer.getChannelData(ch));
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let start = 0; start < numSamples; start += chunkSamples) {
    const end = Math.min(numSamples, start + chunkSamples);
    for (let i = start; i < end; i += 1) {
      for (let ch = 0; ch < numChannels; ch += 1) {
        const s = Math.max(-1, Math.min(1, channelData[ch][i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
    }
    onProgress?.(end / numSamples);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// CcKnob component
// ---------------------------------------------------------------------------

interface CcKnobProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

function CcKnob({ label, value, onChange, disabled = false }: CcKnobProps) {
  const startRef = useRef<{ active: boolean; startY: number; startValue: number }>({
    active: false,
    startY: 0,
    startValue: value,
  });

  useEffect(() => {
    if (!startRef.current.active) startRef.current.startValue = value;
  }, [value]);

  const angle = -135 + (Math.max(0, Math.min(127, value)) / 127) * 270;
  const rad = (angle * Math.PI) / 180;
  const x2 = 20 + Math.cos(rad) * 11;
  const y2 = 20 + Math.sin(rad) * 11;

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.button !== 0) return;
    event.preventDefault();
    startRef.current = { active: true, startY: event.clientY, startValue: value };
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!startRef.current.active || disabled) return;
    event.preventDefault();
    const delta = startRef.current.startY - event.clientY;
    const next = clampCc(startRef.current.startValue + Math.round(delta * 0.8));
    onChange(next);
  };

  const onPointerUp = () => {
    if (!startRef.current.active) return;
    startRef.current.active = false;
  };

  useEffect(() => {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  });

  return (
    <button
      type="button"
      className="ccKnobBtn"
      onPointerDown={onPointerDown}
      disabled={disabled}
      title={`${label} ${value}`}
    >
      <svg viewBox="0 0 40 40" className="ccKnobSvg" aria-hidden="true">
        <circle cx="20" cy="20" r="15" className="ccKnobRing" />
        <line x1="20" y1="20" x2={x2} y2={y2} className="ccKnobNeedle" />
      </svg>
      <span className="ccKnobLabel">{label}</span>
      <span className="ccKnobValue">{value}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Orchestra pan heuristics
// ---------------------------------------------------------------------------

interface PanRule {
  test: RegExp;
  pan: number;
}

const ORCHESTRA_PAN_RULES: PanRule[] = [
  { test: /\bviolin\s*(?:ii|2)\b/i, pan: -0.35 },
  { test: /\bviolin\b/i, pan: -0.75 },
  { test: /\bviola\b/i, pan: 0.3 },
  { test: /\bcello\b/i, pan: 0.65 },
  { test: /\b(double\s*bass|contrabass|upright\s*bass)\b/i, pan: 0.8 },
  { test: /\b(piccolo|flute)\b/i, pan: -0.15 },
  { test: /\boboe\b/i, pan: -0.05 },
  { test: /\bclarinet\b/i, pan: 0.05 },
  { test: /\bbassoon\b/i, pan: 0.15 },
  { test: /\b(french\s*horn|horn)\b/i, pan: -0.5 },
  { test: /\btrumpet\b/i, pan: 0.25 },
  { test: /\b(trombone|tuba)\b/i, pan: 0.5 },
  { test: /\btimpani\b/i, pan: -0.1 },
];

function resolveOrchestraPan(...labels: (string | undefined)[]): number | null {
  const merged = labels
    .filter(Boolean)
    .join(" | ")
    .toLowerCase();
  if (!merged) return null;
  for (const rule of ORCHESTRA_PAN_RULES) {
    if (rule.test.test(merged)) return rule.pan;
  }
  return null;
}

// ---------------------------------------------------------------------------
// MidiReader props
// ---------------------------------------------------------------------------

interface MidiReaderProps {
  sf2Ready: boolean;
  sf2Name: string;
  sf2Loading: boolean;
  onUploadSf2: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onLoadDefaultSf2: () => void;
  activeTab: string;
  onSelectTab: (tab: string) => void;
  audioCtxState: string;
  onTogglePower: () => void;
  midiEnabled: boolean;
  onToggleMidi: () => void;
  selectedMidiInput: string;
  onSelectMidiInput: (id: string) => void;
  midiInputs?: { id: string; name: string }[];
  analyzerCollapsed: boolean;
  onToggleAnalyzer: () => void;
  ensureAudioInfrastructure: (
    opts?: { loadWorklet?: boolean }
  ) => Promise<{ ctx: AudioContext; analyser: AnalyserNode }>;
  getRegionsForPreset: (presetIndex: number) => SF2Region[];
  resolvePresetIndex: (program: number, bank: number) => number | null;
  fallbackPresetIndex: number;
  presetOptions?: PresetOption[];
  onError?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// MidiReader component
// ---------------------------------------------------------------------------

export default function MidiReader({
  sf2Ready,
  sf2Name,
  sf2Loading,
  onUploadSf2,
  onLoadDefaultSf2,
  activeTab,
  onSelectTab,
  audioCtxState,
  onTogglePower,
  midiEnabled,
  onToggleMidi,
  selectedMidiInput,
  onSelectMidiInput,
  midiInputs = [],
  analyzerCollapsed,
  onToggleAnalyzer,
  ensureAudioInfrastructure,
  getRegionsForPreset,
  resolvePresetIndex,
  fallbackPresetIndex,
  presetOptions = [],
  onError,
}: MidiReaderProps) {
  const [song, setSong] = useState<Song | null>(null);
  const [songName, setSongName] = useState<string>("");
  const [songError, setSongError] = useState<string>("");
  const [currentMidiSource, setCurrentMidiSource] = useState<CurrentMidiSource | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<number>(0);
  const [exportStage, setExportStage] = useState<string>("");
  const [songTime, setSongTime] = useState<number>(0);
  const [midiOptions, setMidiOptions] = useState<MidiOption[]>([]);
  const [selectedMidiPath, setSelectedMidiPath] = useState<string>("");
  const [midiOutputEnabled, setMidiOutputEnabled] = useState<boolean>(false);
  const [midiOutputs, setMidiOutputs] = useState<MidiOutputOption[]>([]);
  const [selectedMidiOutput, setSelectedMidiOutput] = useState<string>("");
  const [midiOutputStatus, setMidiOutputStatus] = useState<string>("Output disabled");
  const [isSendingMidi, setIsSendingMidi] = useState<boolean>(false);
  const [trackPresetOverrides, setTrackPresetOverrides] = useState<Record<number, number | null>>({});
  const [trackCcControls, setTrackCcControls] = useState<Record<number, TrackCc>>({});
  const [trackMixState, setTrackMixState] = useState<Record<number, TrackMix>>({});
  const [bachModuleOpen, setBachModuleOpen] = useState<boolean>(false);
  const [isGeneratingBach, setIsGeneratingBach] = useState<boolean>(false);
  const [isParsingSheetMusic, setIsParsingSheetMusic] = useState<boolean>(false);
  const [selectedSheetMusicImage, setSelectedSheetMusicImage] = useState<SelectedSheetMusicImage | null>(null);
  const [sheetMusicStage, setSheetMusicStage] = useState<string>("");
  const [sheetMusicNotice, setSheetMusicNotice] = useState<string>("");
  const [timelineZoom, setTimelineZoom] = useState<number>(MIN_TIMELINE_ZOOM);
  const [bachConfig, setBachConfig] = useState<BachFugueConfig>(() => ({
    ...DEFAULT_BACH_CONFIG,
    seed: Math.floor(Math.random() * 1_000_000_000),
  }));

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const midiAccessRef = useRef<MIDIAccess | null>(null);
  const midiSendTimerRef = useRef<number | null>(null);
  const midiSendOutputRef = useRef<MIDIOutput | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const trackNodesRef = useRef<TrackNode[]>([]);
  const portsAttachedRef = useRef<boolean>(false);
  const dragStateRef = useRef<{ active: boolean; startX: number; startLeft: number }>({
    active: false,
    startX: 0,
    startLeft: 0,
  });
  const isSeekingRef = useRef<boolean>(false);
  const onErrorRef = useRef<((msg: string) => void) | undefined>(onError);
  const trackPresetOverridesRef = useRef<Record<number, number | null>>({});
  const trackCcControlsRef = useRef<Record<number, TrackCc>>({});
  const trackMixStateRef = useRef<Record<number, TrackMix>>({});
  const resolvePresetRef = useRef<(program: number, bank: number) => number | null>(resolvePresetIndex);
  const getRegionsRef = useRef<(presetIndex: number) => SF2Region[]>(getRegionsForPreset);
  const fallbackPresetRef = useRef<number>(fallbackPresetIndex);
  const durationRef = useRef<number>(0.01);
  const contentWRef = useRef<number>(1000);
  const timelineZoomRef = useRef<number>(MIN_TIMELINE_ZOOM);
  const presetOptionMapRef = useRef<Map<number, PresetOption>>(new Map());
  const pendingRestoreSecRef = useRef<number | null>(null);
  const lastPersistedTimeRef = useRef<number>(0);

  const timelineW = 1000;
  const trackH = 108;
  const duration = Math.max(0.01, song?.durationSec ?? 0.01);
  const totalBars = Math.max(1, song?.totalBars ?? 1);
  const visibleBars = 30;
  const zoomFactor = (totalBars > visibleBars ? totalBars / visibleBars : 1) * timelineZoom;
  const contentW = Math.round(timelineW * zoomFactor);

  const visibleTracks = useMemo<SongTrack[]>(() => song?.tracks ?? [], [song]);
  const presetOptionMap = useMemo<Map<number, PresetOption>>(
    () => new Map((presetOptions ?? []).map((p) => [p.index, p])),
    [presetOptions]
  );
  const trackDefaultPresetMap = useMemo<Record<number, number>>(() => {
    const out: Record<number, number> = {};
    if (!song?.tracks?.length) return out;
    for (const track of song.tracks) {
      const programEvent = track.playEvents.find((e) => e.type === "program");
      if (!programEvent) continue;
      const presetIndex = resolvePresetIndex(programEvent.program ?? 0, programEvent.bank ?? 0);
      if (presetIndex != null && presetIndex >= 0) out[track.index] = presetIndex;
    }
    return out;
  }, [song, resolvePresetIndex]);
  const songMetadata = useMemo(() => {
    if (!song) return null;
    const noteCount = song.tracks.reduce((sum, track) => sum + track.notes.length, 0);
    const eventCount = song.tracks.reduce((sum, track) => sum + track.playEvents.length, 0);
    const namedTracks = song.tracks
      .map((track) => formatTrackInlineName(track) || track.instrumentName)
      .filter(Boolean);
    return {
      noteCount,
      eventCount,
      namedTrackPreview: namedTracks.slice(0, 3).join(", "),
    };
  }, [song]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    trackPresetOverridesRef.current = trackPresetOverrides;
  }, [trackPresetOverrides]);
  useEffect(() => {
    trackCcControlsRef.current = trackCcControls;
  }, [trackCcControls]);
  useEffect(() => {
    trackMixStateRef.current = trackMixState;
  }, [trackMixState]);
  useEffect(() => {
    resolvePresetRef.current = resolvePresetIndex;
  }, [resolvePresetIndex]);
  useEffect(() => {
    getRegionsRef.current = getRegionsForPreset;
  }, [getRegionsForPreset]);
  useEffect(() => {
    fallbackPresetRef.current = fallbackPresetIndex;
  }, [fallbackPresetIndex]);
  useEffect(() => {
    durationRef.current = duration;
    contentWRef.current = contentW;
  }, [duration, contentW]);
  useEffect(() => {
    timelineZoomRef.current = timelineZoom;
  }, [timelineZoom]);
  useEffect(() => {
    presetOptionMapRef.current = presetOptionMap;
  }, [presetOptionMap]);
  useEffect(() => {
    return () => {
      if (selectedSheetMusicImage?.previewUrl) URL.revokeObjectURL(selectedSheetMusicImage.previewUrl);
    };
  }, [selectedSheetMusicImage?.previewUrl]);

  const updatePlayhead = (sec: number) => {
    const line = playheadRef.current;
    if (!line) return;
    const safeDuration = Math.max(0.01, durationRef.current);
    const width = getTimelineWidth();
    const x = (Math.max(0, Math.min(safeDuration, sec)) / safeDuration) * width;
    line.style.transform = `translateX(${x}px)`;
  };

  const getTimelineWidth = (): number => {
    return Math.max(1, contentRef.current?.offsetWidth ?? contentWRef.current);
  };

  const scrollTimelineToSec = (sec: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const safeDuration = Math.max(0.01, durationRef.current);
    const progress = clampNumber(sec / safeDuration, 0, 1);
    const maxLeft = Math.max(0, getTimelineWidth() - viewport.clientWidth);
    viewport.scrollLeft = progress * maxLeft;
  };

  const seekToSec = (rawSec: number, opts: { scrollTimeline?: boolean } = {}): number => {
    const safeDuration = Math.max(0.01, durationRef.current);
    const sec = Math.max(0, Math.min(safeDuration, Number.isFinite(rawSec) ? rawSec : 0));
    updatePlayhead(sec);
    if (opts.scrollTimeline !== false) scrollTimelineToSec(sec);
    setSongTime(sec);
    workerRef.current?.postMessage({ type: "seek", sec });
    updatePersistedMidiTime(sec);
    return sec;
  };

  const seekToClientX = (clientX: number): number => {
    const content = contentRef.current;
    if (!content) return 0;
    const rect = content.getBoundingClientRect();
    const width = getTimelineWidth();
    const safeDuration = Math.max(0.01, durationRef.current);
    const xInContent = Math.max(0, Math.min(width, clientX - rect.left));
    const sec = (xInContent / width) * safeDuration;
    return seekToSec(sec, { scrollTimeline: false });
  };

  const refreshMidiOutputs = (access: MIDIAccess | null = midiAccessRef.current): MidiOutputOption[] => {
    const outputs = access ? [...access.outputs.values()].map((output) => ({ id: output.id, name: outputName(output) })) : [];
    setMidiOutputs(outputs);
    setSelectedMidiOutput((current) => (current && outputs.some((output) => output.id === current) ? current : outputs[0]?.id ?? ""));
    setMidiOutputStatus(outputs.length ? `Outputs: ${outputs.map((output) => output.name).join(", ")}` : "No MIDI outputs");
    return outputs;
  };

  const findMidiOutput = (outputId: string = selectedMidiOutput): MIDIOutput | null => {
    const access = midiAccessRef.current;
    if (!access || !outputId) return null;
    return access.outputs.get(outputId) ?? null;
  };

  const sendAllNotesOff = (output: MIDIOutput | null = midiSendOutputRef.current) => {
    if (!output) return;
    for (let channel = 0; channel < 16; channel += 1) {
      output.send([0xb0 | channel, 64, 0]);
      output.send([0xb0 | channel, 120, 0]);
      output.send([0xb0 | channel, 123, 0]);
    }
  };

  const stopMidiSend = (status = "Send stopped") => {
    if (midiSendTimerRef.current != null) {
      window.clearTimeout(midiSendTimerRef.current);
      midiSendTimerRef.current = null;
    }
    const output = midiSendOutputRef.current;
    (output as ClearableMidiOutput | null)?.clear?.();
    sendAllNotesOff(output);
    midiSendOutputRef.current = null;
    setIsSendingMidi(false);
    setMidiOutputStatus(status);
  };

  const disconnectTrackNodes = () => {
    for (const rec of trackNodesRef.current) {
      try {
        rec.node?.disconnect();
      } catch {
        // no-op
      }
      try {
        rec.gain?.disconnect();
      } catch {
        // no-op
      }
      try {
        rec.panner?.disconnect();
      } catch {
        // no-op
      }
    }
    trackNodesRef.current = [];
    portsAttachedRef.current = false;
  };

  const getTrackCc = (trackIndex: number, controls: Record<number, TrackCc> = trackCcControlsRef.current): TrackCc => {
    const cc = controls?.[trackIndex];
    return {
      cc7Volume: clampCc(cc?.cc7Volume ?? DEFAULT_TRACK_CC.cc7Volume),
      cc10Pan: clampCc(cc?.cc10Pan ?? DEFAULT_TRACK_CC.cc10Pan),
      cc11Expression: clampCc(cc?.cc11Expression ?? DEFAULT_TRACK_CC.cc11Expression),
    };
  };

  const applyTrackControllers = (songData: Song | null, controls: Record<number, TrackCc> = trackCcControlsRef.current) => {
    if (!songData?.tracks?.length) return;
    for (let i = 0; i < songData.tracks.length; i += 1) {
      const track = songData.tracks[i];
      const rec = trackNodesRef.current[i];
      if (!rec?.node) continue;
      const cc = getTrackCc(track.index, controls);
      rec.node.port.postMessage({ type: "setControllers", ...cc });
    }
  };

  const applyTrackMuteSolo = (songData: Song | null, mix: Record<number, TrackMix> = trackMixStateRef.current) => {
    if (!songData?.tracks?.length) return;
    const anySolo = songData.tracks.some((track) => !!mix?.[track.index]?.solo);
    for (let i = 0; i < songData.tracks.length; i += 1) {
      const track = songData.tracks[i];
      const rec = trackNodesRef.current[i];
      if (!rec?.gain) continue;
      const muted = !!mix?.[track.index]?.mute;
      const solo = !!mix?.[track.index]?.solo;
      const cc = getTrackCc(track.index);
      const ccSilent = cc.cc7Volume === 0 || cc.cc11Expression === 0;
      const audible = (anySolo ? solo : !muted) && !ccSilent;
      rec.gain.gain.setTargetAtTime(audible ? 1 : 0, rec.gain.context.currentTime, 0.01);
    }
  };

  const applyTrackPanning = (songData: Song | null, overrides: Record<number, number | null> | undefined) => {
    if (!songData?.tracks?.length) return;
    for (let i = 0; i < songData.tracks.length; i += 1) {
      const track = songData.tracks[i];
      const rec = trackNodesRef.current[i];
      if (!rec?.panner) continue;
      const overridePreset = overrides?.[track.index];
      const defaultPreset = trackDefaultPresetMap[track.index];
      const effectivePreset =
        overridePreset != null
          ? overridePreset
          : defaultPreset != null
            ? defaultPreset
            : fallbackPresetIndex;
      const preset = presetOptionMapRef.current.get(effectivePreset);
      const pan = resolveOrchestraPan(
        track.instrumentName,
        track.name,
        preset?.name
      );
      rec.panner.pan.setValueAtTime(pan ?? 0, rec.panner.context.currentTime);
    }
  };

  const enableMidiOutput = async () => {
    if (!navigator.requestMIDIAccess) {
      const msg = "Web MIDI output is not supported in this browser.";
      setMidiOutputStatus(msg);
      setSongError(msg);
      onErrorRef.current?.(msg);
      return;
    }
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      midiAccessRef.current = access;
      access.onstatechange = () => refreshMidiOutputs(access);
      const outputs = refreshMidiOutputs(access);
      setMidiOutputEnabled(true);
      setMidiOutputStatus(outputs.length ? "MIDI output ready" : "MIDI output ready (no outputs)");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMidiOutputStatus("MIDI output failed");
      setSongError(msg);
      onErrorRef.current?.(msg);
    }
  };

  const disableMidiOutput = () => {
    stopMidiSend("Output disabled");
    if (midiAccessRef.current) midiAccessRef.current.onstatechange = null;
    midiAccessRef.current = null;
    setMidiOutputEnabled(false);
    setMidiOutputs([]);
    setSelectedMidiOutput("");
    setMidiOutputStatus("Output disabled");
  };

  const toggleMidiOutput = () => {
    if (midiOutputEnabled) {
      disableMidiOutput();
    } else {
      void enableMidiOutput();
    }
  };

  const onRefreshMidiOutputs = () => {
    if (!midiAccessRef.current) {
      void enableMidiOutput();
      return;
    }
    refreshMidiOutputs();
  };

  const onSendMidiToOutput = () => {
    if (!song) return;
    const output = findMidiOutput();
    if (!output) {
      setMidiOutputStatus("Choose a MIDI output");
      return;
    }
    stopMidiSend("Preparing send");

    const startSec = clampNumber(songTime, 0, duration);
    const events = buildMidiSendEvents(song, startSec);
    if (!events.length) {
      setMidiOutputStatus("No MIDI events to send");
      return;
    }

    const startAt = performance.now() + 80;
    sendAllNotesOff(output);
    for (const event of events) {
      output.send(event.bytes, startAt + Math.max(0, event.sec - startSec) * 1000);
    }

    midiSendOutputRef.current = output;
    setIsSendingMidi(true);
    setMidiOutputStatus(`Sending to ${outputName(output)}`);
    const remainingMs = Math.max(100, (duration - startSec) * 1000 + 120);
    midiSendTimerRef.current = window.setTimeout(() => {
      midiSendTimerRef.current = null;
      sendAllNotesOff(output);
      midiSendOutputRef.current = null;
      setIsSendingMidi(false);
      setMidiOutputStatus(`Sent ${events.length} MIDI messages`);
    }, remainingMs);
  };

  useEffect(() => {
    const worker = new Worker(new URL("./midi-timer.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    const debugPlayback = window.localStorage.getItem("sf2-e2e-debug") === "1";
    if (debugPlayback) {
      window.__sf2E2e = { playbackEvents: [] };
      worker.postMessage({ type: "setDebugPlayback", enabled: true });
    }

    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type: string; [key: string]: unknown };
      if (msg.type === "playbackDebug") {
        window.__sf2E2e?.playbackEvents.push(msg as PlaybackDebugEvent);
        return;
      }
      if (msg.type === "songLoaded") {
        setSong(msg.song as Song);
        const restoreSec = pendingRestoreSecRef.current;
        pendingRestoreSecRef.current = null;
        const nextSec = restoreSec == null ? 0 : Math.max(0, Math.min((msg.song as Song).durationSec, restoreSec));
        setSongTime(nextSec);
        setIsPlaying(false);
        setSongError("");
        setTrackPresetOverrides({});
        setTrackCcControls({});
        setTrackMixState({});
        updatePlayhead(nextSec);
        if (nextSec > 0) worker.postMessage({ type: "seek", sec: nextSec });
        return;
      }
      if (msg.type === "tick") {
        if (!isSeekingRef.current) {
          const sec = (msg.sec as number) ?? 0;
          setSongTime(sec);
          updatePlayhead(sec);
          if (Math.abs(sec - lastPersistedTimeRef.current) >= 1) {
            lastPersistedTimeRef.current = sec;
            updatePersistedMidiTime(sec);
          }
        }
        const viewport = viewportRef.current;
        if (viewport && !isSeekingRef.current) {
          scrollTimelineToSec((msg.sec as number) ?? 0);
        }
        return;
      }
      if (msg.type === "paused") {
        const sec = (msg.sec as number) ?? 0;
        setSongTime(sec);
        updatePlayhead(sec);
        updatePersistedMidiTime(sec);
        setIsPlaying(false);
        return;
      }
      if (msg.type === "ended") {
        const sec = (msg.sec as number) ?? 0;
        setSongTime(sec);
        updatePlayhead(sec);
        updatePersistedMidiTime(sec);
        setIsPlaying(false);
        return;
      }
      if (msg.type === "programChangeRequest") {
        const trackIndex = msg.trackIndex as number;
        const presetIndex =
          trackPresetOverridesRef.current[trackIndex] != null
            ? (trackPresetOverridesRef.current[trackIndex] as number)
            : resolvePresetRef.current(msg.program as number, msg.bank as number) ?? fallbackPresetRef.current;
        const regions = getRegionsRef.current(presetIndex);
        worker.postMessage({
          type: "setTrackPreset",
          trackIndex,
          presetIndex,
          override: trackPresetOverridesRef.current[trackIndex] != null,
          regions,
        });
        return;
      }
      if (msg.type === "error") {
        setSongError((msg.message as string) || "Worker error");
        onErrorRef.current?.((msg.message as string) || "Worker error");
      }
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
      disconnectTrackNodes();
    };
  }, []);

  useEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollLeft = 0;
    setTimelineZoom(MIN_TIMELINE_ZOOM);
    updatePlayhead(0);
  }, [songName]);

  useEffect(() => {
    return () => {
      stopMidiSend("Output disabled");
      if (midiAccessRef.current) midiAccessRef.current.onstatechange = null;
    };
  }, []);

  useEffect(() => {
    if (isSendingMidi) stopMidiSend("Send stopped");
  }, [songName]);

  useEffect(() => {
    updatePlayhead(songTime);
  }, [contentW, songTime]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    viewport.classList.add("dragScroll");

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (event.target instanceof HTMLElement && event.target.closest("button, select, input, label")) return;
      dragStateRef.current.active = true;
      dragStateRef.current.startX = event.clientX;
      dragStateRef.current.startLeft = viewport.scrollLeft;
      viewport.classList.add("dragging");
      viewport.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!dragStateRef.current.active) return;
      const dx = event.clientX - dragStateRef.current.startX;
      viewport.scrollLeft = dragStateRef.current.startLeft - dx;
    };

    const endDrag = (event: PointerEvent) => {
      if (!dragStateRef.current.active) return;
      dragStateRef.current.active = false;
      viewport.classList.remove("dragging");
      viewport.releasePointerCapture?.(event.pointerId);
    };

    viewport.addEventListener("pointerdown", onPointerDown);
    viewport.addEventListener("pointermove", onPointerMove);
    viewport.addEventListener("pointerup", endDrag);
    viewport.addEventListener("pointercancel", endDrag);
    viewport.addEventListener("pointerleave", endDrag);
    return () => {
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.removeEventListener("pointermove", onPointerMove);
      viewport.removeEventListener("pointerup", endDrag);
      viewport.removeEventListener("pointercancel", endDrag);
      viewport.removeEventListener("pointerleave", endDrag);
    };
  }, [song]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const getWheelPixels = (event: WheelEvent) => {
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * viewport.clientHeight;
      return event.deltaY;
    };

    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault();

      const oldWidth = getTimelineWidth();
      const focusX = viewport.scrollLeft + event.clientX - viewport.getBoundingClientRect().left;
      const anchorRatio = clampNumber(focusX / oldWidth, 0, 1);
      const delta = getWheelPixels(event);
      const zoomChange = Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY);

      setTimelineZoom((currentZoom) => {
        const nextZoom = clampNumber(currentZoom * zoomChange, MIN_TIMELINE_ZOOM, MAX_TIMELINE_ZOOM);
        if (Math.abs(nextZoom - currentZoom) < 0.001) return currentZoom;
        const nextWidth = Math.max(1, oldWidth * (nextZoom / Math.max(0.001, currentZoom)));
        requestAnimationFrame(() => {
          const maxLeft = Math.max(0, nextWidth - viewport.clientWidth);
          viewport.scrollLeft = clampNumber(anchorRatio * nextWidth - (event.clientX - viewport.getBoundingClientRect().left), 0, maxLeft);
        });
        return nextZoom;
      });
    };

    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [song]);

  useEffect(() => {
    const line = playheadRef.current;
    if (!line) return;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      isSeekingRef.current = true;
      line.classList.add("seeking");
      line.setPointerCapture?.(event.pointerId);
      seekToClientX(event.clientX);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!isSeekingRef.current) return;
      seekToClientX(event.clientX);
    };

    const endSeek = (event: PointerEvent) => {
      if (!isSeekingRef.current) return;
      isSeekingRef.current = false;
      line.classList.remove("seeking");
      line.releasePointerCapture?.(event.pointerId);
      seekToClientX(event.clientX);
    };

    line.addEventListener("pointerdown", onPointerDown);
    line.addEventListener("pointermove", onPointerMove);
    line.addEventListener("pointerup", endSeek);
    line.addEventListener("pointercancel", endSeek);
    return () => {
      line.removeEventListener("pointerdown", onPointerDown);
      line.removeEventListener("pointermove", onPointerMove);
      line.removeEventListener("pointerup", endSeek);
      line.removeEventListener("pointercancel", endSeek);
    };
  }, [song]);

  useEffect(() => {
    if (!workerRef.current) return;
    (async () => {
      try {
        const manifestUrl = `${import.meta.env.BASE_URL}static/midi-manifest.json`;
        const res = await fetch(manifestUrl);
        if (!res.ok) throw new Error(`Failed to fetch ${manifestUrl}`);
        const list = await res.json() as unknown;
        const normalized: MidiOption[] = Array.isArray(list)
          ? (list as unknown[]).filter(
              (m): m is MidiOption =>
                m != null &&
                typeof m === "object" &&
                "path" in (m as object) &&
                "name" in (m as object)
            )
          : [];
        setMidiOptions(normalized);

        const persisted = readPersistedMidiState();
        if (persisted?.kind === "bundled" && persisted.path) {
          const restored = normalized.find((m) => m.path === persisted.path) ?? {
            name: persisted.name,
            path: persisted.path,
          };
          setSelectedMidiPath(restored.path);
          const midiRes = await fetch(`${import.meta.env.BASE_URL}${restored.path}`);
          if (!midiRes.ok) throw new Error(`Failed to fetch ${restored.path}`);
          const buf = await midiRes.arrayBuffer();
          loadMidiIntoTracks(buf, restored.name, {
            selectedPath: restored.path,
            sourceKind: "bundled",
            persist: false,
            restoreSec: persisted.currentSec,
          });
          return;
        }

        if (persisted && persisted.kind !== "bundled" && persisted.dataUrl) {
          const buf = await dataUrlToArrayBuffer(persisted.dataUrl);
          loadMidiIntoTracks(buf, persisted.name, {
            sourceKind: persisted.kind,
            dataUrl: persisted.dataUrl,
            persist: false,
            restoreSec: persisted.currentSec,
          });
          return;
        }

        const preferred = normalized.find((m) => m.name === "60884_Beethoven-Symphony-No51.mid");
        const first = preferred ?? normalized[0];
        if (first) {
          setSelectedMidiPath(first.path);
          const midiRes = await fetch(`${import.meta.env.BASE_URL}${first.path}`);
          if (!midiRes.ok) throw new Error(`Failed to fetch ${first.path}`);
          const buf = await midiRes.arrayBuffer();
          loadMidiIntoTracks(buf, first.name, {
            selectedPath: first.path,
            sourceKind: "bundled",
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setSongError(msg);
        onErrorRef.current?.(msg);
      }
    })();
  }, []);



  useEffect(() => {
    if (!workerRef.current || !song || !portsAttachedRef.current) return;
    for (const track of song.tracks) {
      const overridePreset = trackPresetOverrides[track.index];
      if (overridePreset == null) continue;
      const regions = getRegionsForPreset(overridePreset);
      workerRef.current.postMessage({
        type: "setTrackPreset",
        trackIndex: track.index,
        presetIndex: overridePreset,
        override: true,
        regions,
      });
    }
    applyTrackPanning(song, trackPresetOverrides);
  }, [trackPresetOverrides, song, getRegionsForPreset]);

  useEffect(() => {
    if (!song || !portsAttachedRef.current) return;
    applyTrackControllers(song, trackCcControls);
    applyTrackMuteSolo(song, trackMixStateRef.current);
  }, [trackCcControls, song]);

  useEffect(() => {
    if (!song || !portsAttachedRef.current) return;
    applyTrackMuteSolo(song, trackMixState);
  }, [trackMixState, song]);

  async function ensureTrackInfrastructure() {
    if (!song || !workerRef.current) return;
    if (portsAttachedRef.current) return;

    const { ctx, analyser } = await ensureAudioInfrastructure();
    const trackNodes: TrackNode[] = [];
    for (let i = 0; i < song.tracks.length; i += 1) {
      const node = new AudioWorkletNode(ctx, "sf2-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const panner = new StereoPannerNode(ctx, { pan: 0 });
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(1, ctx.currentTime);
      node.connect(panner);
      panner.connect(gain);
      gain.connect(analyser);
      trackNodes.push({ node, panner, gain });
    }
    trackNodesRef.current = trackNodes;

    const ports = trackNodes.map((rec, index) => ({ trackIndex: index, port: rec.node.port }));
    workerRef.current.postMessage({ type: "attachPorts", ports }, ports.map((p) => p.port));
    portsAttachedRef.current = true;

    for (const track of song.tracks) {
      const overridePreset = trackPresetOverrides[track.index];
      const defaultPreset = trackDefaultPresetMap[track.index];
      const presetIndex = overridePreset ?? defaultPreset ?? fallbackPresetIndex;
      const regions = getRegionsForPreset(presetIndex);
      workerRef.current.postMessage({
        type: "setTrackPreset",
        trackIndex: track.index,
        presetIndex,
        override: overridePreset != null,
        regions,
      });
    }
    applyTrackPanning(song, trackPresetOverrides);
    applyTrackControllers(song, trackCcControlsRef.current);
    applyTrackMuteSolo(song, trackMixStateRef.current);
  }

  async function onPlayPause() {
    if (!song || !sf2Ready || !workerRef.current) return;
    if (isPlaying) {
      workerRef.current.postMessage({ type: "pause" });
      return;
    }
    try {
      await ensureTrackInfrastructure();
      const { ctx } = await ensureAudioInfrastructure();
      if (ctx.state !== "running") {
        try {
          await ctx.resume();
        } catch (resumeErr) {
          const resumeMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
          throw new Error("Failed to resume audio: " + resumeMsg);
        }
      }
      workerRef.current.postMessage({ type: "play", startSec: songTime });
      setIsPlaying(true);
      setSongError("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSongError(msg);
      onError?.(msg);
    }
  }

  function onSeekSliderChange(event: React.ChangeEvent<HTMLInputElement>) {
    seekToSec(Number(event.target.value));
  }

  function onSeekSliderPointerDown(event: React.PointerEvent<HTMLInputElement>) {
    isSeekingRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onSeekSliderPointerUp(event: React.PointerEvent<HTMLInputElement>) {
    isSeekingRef.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    seekToSec(Number(event.currentTarget.value));
  }

  function seekBy(deltaSec: number) {
    if (!song) return;
    seekToSec(songTime + deltaSec);
  }

  async function onExportWav() {
    if (!song || !sf2Ready || isExporting) return;
    setIsExporting(true);
    setExportProgress(0);
    setExportStage("Preparing");
    setSongError("");
    try {
      const sampleRate = 44100;
      const numChannels = 2;
      const tailSec = 3;
      const durationSec = song.durationSec + tailSec;
      const offlineCtx = new OfflineAudioContext(
        numChannels,
        Math.ceil(durationSec * sampleRate),
        sampleRate
      );
      const audioBuffer = offlineCtx.createBuffer(
        numChannels,
        Math.ceil(durationSec * sampleRate),
        sampleRate
      );

      const anySolo = song.tracks.some((t) => !!trackMixStateRef.current[t.index]?.solo);
      const offlineTracks: {
        trackIndex: number;
        regions: SF2Region[];
        cc7Volume: number;
        cc10Pan: number;
        cc11Expression: number;
        pan: number;
        gain: number;
      }[] = [];
      const events: {
        frame: number;
        seq: number;
        type: string;
        trackIndex: number;
        channel?: number;
        note?: number;
        velocity?: number;
        regions?: SF2Region[];
      }[] = [];

      for (const track of song.tracks) {
        const overridePreset = trackPresetOverridesRef.current[track.index];
        const defaultPreset = trackDefaultPresetMap[track.index];
        const presetIndex = overridePreset ?? defaultPreset ?? fallbackPresetRef.current;
        const regions = getRegionsRef.current(presetIndex);
        const cc = getTrackCc(track.index);
        const preset = presetOptionMapRef.current.get(presetIndex);
        const pan = resolveOrchestraPan(track.instrumentName, track.name, preset?.name);

        const muted = !!trackMixStateRef.current[track.index]?.mute;
        const solo = !!trackMixStateRef.current[track.index]?.solo;
        const audible = anySolo ? solo : !muted;
        offlineTracks.push({
          trackIndex: track.index,
          regions,
          cc7Volume: cc.cc7Volume,
          cc10Pan: cc.cc10Pan,
          cc11Expression: cc.cc11Expression,
          pan: pan ?? 0,
          gain: audible ? 1 : 0,
        });
        for (const ev of track.playEvents) {
          const frame = Math.max(0, Math.round(ev.sec * sampleRate));
          if (ev.type === "noteOn") {
            events.push({
              frame,
              seq: ev.seq ?? 0,
              type: "noteOn",
              trackIndex: track.index,
              channel: ev.channel,
              note: ev.note,
              velocity: ev.velocity,
            });
          } else if (ev.type === "noteOff") {
            events.push({
              frame,
              seq: ev.seq ?? 0,
              type: "noteOff",
              trackIndex: track.index,
              channel: ev.channel,
              note: ev.note,
            });
          } else if (ev.type === "program" && overridePreset == null) {
            const pIdx = resolvePresetRef.current(ev.program ?? 0, ev.bank ?? 0) ?? fallbackPresetRef.current;
            events.push({
              frame,
              seq: ev.seq ?? 0,
              type: "setPreset",
              trackIndex: track.index,
              regions: getRegionsRef.current(pIdx),
            });
          }
        }
      }
      setExportStage("Rendering");
      await renderOfflineSequenceToAudioBufferIncremental({
        audioBuffer,
        tracks: offlineTracks,
        events,
        maxVoices: Math.max(96, song.tracks.length * 24),
        onProgress: (progress: number) => {
          setExportProgress(Math.max(0, Math.min(0.85, progress * 0.85)));
        },
      });
      setExportStage("Encoding WAV");
      const wavBuffer = await encodeWavIncremental(audioBuffer, 16384, (progress) => {
        setExportProgress(0.85 + Math.max(0, Math.min(0.15, progress * 0.15)));
      });
      setExportProgress(1);
      setExportStage("Saving");
      const blob = new Blob([wavBuffer], { type: "audio/wav" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(songName || "export").replace(/\.[^.]+$/, "")}.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSongError(msg);
      onError?.(msg);
    } finally {
      setExportStage("");
      setIsExporting(false);
    }
  }

  function loadMidiIntoTracks(
    buf: ArrayBuffer,
    name: string,
    opts: {
      selectedPath?: string;
      sourceKind?: MidiSourceKind;
      dataUrl?: string;
      persist?: boolean;
      restoreSec?: number;
    } = {}
  ) {
    if (!workerRef.current) return;
    const selectedPath = opts.selectedPath ?? "";
    const sourceKind = opts.sourceKind ?? (selectedPath ? "bundled" : "uploaded");
    const source: CurrentMidiSource = { kind: sourceKind, name, path: selectedPath || undefined };
    if (isPlaying) workerRef.current.postMessage({ type: "pause" });
    disconnectTrackNodes();
    pendingRestoreSecRef.current = opts.restoreSec ?? null;
    workerRef.current.postMessage({ type: "loadMidi", midiData: buf }, [buf]);
    setSelectedMidiPath(selectedPath);
    setCurrentMidiSource(source);
    setSongName(name);
    setSongTime(opts.restoreSec ?? 0);
    setSongError("");
    setSheetMusicNotice("");
    lastPersistedTimeRef.current = opts.restoreSec ?? 0;
    if (opts.persist !== false && (source.kind === "bundled" || opts.dataUrl)) {
      writePersistedMidiState({
        ...source,
        dataUrl: opts.dataUrl,
        currentSec: opts.restoreSec ?? 0,
      });
    }
  }

  async function onUploadMidi(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !workerRef.current) return;
    try {
      const buf = await file.arrayBuffer();
      let dataUrl: string | undefined;
      if (buf.byteLength <= MAX_PERSISTED_MIDI_BYTES) {
        dataUrl = await arrayBufferToDataUrl(buf.slice(0));
      }
      loadMidiIntoTracks(buf, file.name, {
        sourceKind: "uploaded",
        dataUrl,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSongError(msg);
      onError?.(msg);
      setSong(null);
    }
  }

  function selectSheetMusicImage(file: File, source: SheetMusicImageSource) {
    if (!isSupportedSheetMusicImageFile(file)) {
      setSongError("Choose a JPG or PNG image of sheet music.");
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    setSelectedSheetMusicImage({ file, name: file.name, previewUrl, source });
    setSheetMusicStage("");
    setSheetMusicNotice(`${file.name} is ready to convert to MIDI.`);
    setSongError("");
  }

  function onUploadSheetMusic(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || isParsingSheetMusic) return;
    selectSheetMusicImage(file, "uploaded");
  }

  async function onLoadSwedenSheetMusic() {
    if (isParsingSheetMusic) return;

    setSheetMusicStage("Loading Sweden sheet image...");
    setSheetMusicNotice("");
    setSongError("");
    try {
      const res = await fetch(SWEDEN_SHEET_IMAGE_URL);
      if (!res.ok) throw new Error(`Failed to fetch Sweden sheet image (${res.status})`);
      const blob = await res.blob();
      const file = new File([blob], "sweden.jpg", { type: blob.type || "image/jpeg" });
      selectSheetMusicImage(file, "sample");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSongError(msg);
      onError?.(msg);
    } finally {
      setSheetMusicStage("");
    }
  }

  async function onConvertSelectedSheetMusic() {
    if (!selectedSheetMusicImage || !workerRef.current || isParsingSheetMusic) return;

    setIsParsingSheetMusic(true);
    setSheetMusicStage("Reading sheet music image...");
    setSheetMusicNotice("");
    setSongError("");
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      setSheetMusicStage("Building MIDI from sheet music...");
      const parsed = await parseSheetMusicToMidi(selectedSheetMusicImage.file);
      let dataUrl: string | undefined;
      if (parsed.midiData.byteLength <= MAX_PERSISTED_MIDI_BYTES) {
        dataUrl = await arrayBufferToDataUrl(parsed.midiData.slice(0));
      }
      window.dispatchEvent(
        new CustomEvent("sheetmusicreader:generated-midi", {
          detail: {
            fileName: parsed.fileName,
            midiData: parsed.midiData.slice(0),
            warnings: parsed.warnings,
          },
        })
      );
      loadMidiIntoTracks(parsed.midiData, parsed.fileName, {
        sourceKind: "generated",
        dataUrl,
      });
      if (parsed.warnings?.length) setSheetMusicNotice(parsed.warnings.join(" "));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSongError(msg);
      onError?.(msg);
    } finally {
      setSheetMusicStage("");
      setIsParsingSheetMusic(false);
    }
  }

  async function onLoadSelectedMidi() {
    if (!selectedMidiPath || !workerRef.current) return;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}${selectedMidiPath}`);
      if (!res.ok) throw new Error(`Failed to fetch ${selectedMidiPath}`);
      const buf = await res.arrayBuffer();
      const selected = midiOptions.find((m) => m.path === selectedMidiPath);
      loadMidiIntoTracks(buf, selected?.name || selectedMidiPath, {
        selectedPath: selectedMidiPath,
        sourceKind: "bundled",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSongError(msg);
      onError?.(msg);
    }
  }

  async function onSelectMidiPath(nextPath: string) {
    setSelectedMidiPath(nextPath);
    if (!nextPath) return;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}${nextPath}`);
      if (!res.ok) throw new Error(`Failed to fetch ${nextPath}`);
      const buf = await res.arrayBuffer();
      const selected = midiOptions.find((m) => m.path === nextPath);
      loadMidiIntoTracks(buf, selected?.name || nextPath, {
        selectedPath: nextPath,
        sourceKind: "bundled",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSongError(msg);
      onError?.(msg);
    }
  }

  function onBachConfigChange<K extends keyof BachFugueConfig>(key: K, value: BachFugueConfig[K]) {
    setBachConfig((prev) => ({ ...prev, [key]: value }));
  }

  async function onGenerateBachMusic(useNewSeed = false) {
    if (!workerRef.current || isGeneratingBach) return;
    const seed = useNewSeed ? Math.floor(Math.random() * 1_000_000_000) : bachConfig.seed;
    const nextConfig = { ...bachConfig, seed };
    setBachConfig(nextConfig);
    setIsGeneratingBach(true);
    setSongError("");
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const generated = generateBachMidi(nextConfig);
      let dataUrl: string | undefined;
      if (generated.midiData.byteLength <= MAX_PERSISTED_MIDI_BYTES) {
        dataUrl = await arrayBufferToDataUrl(generated.midiData.slice(0));
      }
      loadMidiIntoTracks(generated.midiData, generated.fileName, {
        sourceKind: "generated",
        dataUrl,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSongError(msg);
      onError?.(msg);
    } finally {
      setIsGeneratingBach(false);
    }
  }

  function onTrackPresetChange(trackIndex: number, nextValue: string) {
    const parsed = Number(nextValue);
    const nextPreset: number | null = Number.isFinite(parsed) ? parsed : null;
    setTrackPresetOverrides((prev) => ({ ...prev, [trackIndex]: nextPreset }));
    if (!workerRef.current || !portsAttachedRef.current) return;
    const presetIndex = nextPreset ?? trackDefaultPresetMap[trackIndex] ?? fallbackPresetIndex;
    const regions = getRegionsForPreset(presetIndex);
    workerRef.current.postMessage({
      type: "setTrackPreset",
      trackIndex,
      presetIndex,
      override: nextPreset != null,
      regions,
    });
    applyTrackPanning(song, { ...trackPresetOverridesRef.current, [trackIndex]: nextPreset });
  }

  function onTrackCcChange(trackIndex: number, key: keyof TrackCc, rawValue: number) {
    const value = clampCc(rawValue);
    const current = getTrackCc(trackIndex);
    const nextTrack: TrackCc = { ...current, [key]: value };
    const nextAll = { ...trackCcControlsRef.current, [trackIndex]: nextTrack };
    trackCcControlsRef.current = nextAll;
    setTrackCcControls(nextAll);
    const rec = trackNodesRef.current[trackIndex];
    if (rec?.node) rec.node.port.postMessage({ type: "setControllers", ...nextTrack });
    applyTrackMuteSolo(song, trackMixStateRef.current);
  }

  function onToggleTrackMute(trackIndex: number) {
    const current = trackMixStateRef.current[trackIndex] ?? { mute: false, solo: false };
    const nextAll: Record<number, TrackMix> = {
      ...trackMixStateRef.current,
      [trackIndex]: { ...current, mute: !current.mute },
    };
    setTrackMixState(nextAll);
    applyTrackMuteSolo(song, nextAll);
  }

  function onToggleTrackSolo(trackIndex: number) {
    const current = trackMixStateRef.current[trackIndex] ?? { mute: false, solo: false };
    const nextAll: Record<number, TrackMix> = {
      ...trackMixStateRef.current,
      [trackIndex]: { ...current, solo: !current.solo },
    };
    setTrackMixState(nextAll);
    applyTrackMuteSolo(song, nextAll);
  }

  function formatTrackInlineName(track: SongTrack): string {
    const generic = /^track\s+\d+$/i.test(track?.name || "");
    return generic ? "" : (track?.name || "");
  }

  const transportStateLabel = !sf2Ready
    ? sf2Loading
      ? "Loading SoundFont..."
      : "Load SoundFont to enable playback/export"
    : !song
      ? "No song loaded"
      : isPlaying
        ? "Playing"
        : "Paused";

  return (
    <section className="card midiReader">
      <div className="midiTop">
        <div className="appHeaderToolbar midiUnifiedToolbar" aria-label="Main controls">
          <div className="toolbarGroup" aria-label="View">
            <span className="toolbarGroupLabel">View</span>
            <div className="toolbarButtonRow toolbarSegmented">
              <button
                type="button"
                className={`toolbarActionBtn ${activeTab === "midi" ? "active" : ""}`}
                onClick={() => onSelectTab("midi")}
                aria-pressed={activeTab === "midi"}
                aria-label="MIDI Explorer"
                title="MIDI Explorer"
              >
                <i className="fa-solid fa-music" aria-hidden="true" />
                <span>MIDI</span>
              </button>
              <button
                type="button"
                className={`toolbarActionBtn ${activeTab === "sf2" ? "active" : ""}`}
                onClick={() => onSelectTab("sf2")}
                aria-pressed={activeTab === "sf2"}
                aria-label="SF2 Explorer"
                title="SF2 Explorer"
              >
                <i className="fa-solid fa-wave-square" aria-hidden="true" />
                <span>SF2</span>
              </button>
            </div>
          </div>

          <div className="toolbarGroup" aria-label="Audio">
            <span className="toolbarGroupLabel">Audio</span>
            <div className="toolbarButtonRow">
              <button
                type="button"
                className={`toolbarActionBtn ${audioCtxState === "running" ? "active" : ""}`}
                onClick={onTogglePower}
                aria-pressed={audioCtxState === "running"}
                aria-label={audioCtxState === "running" ? "Power Off" : "Power On"}
                title={audioCtxState === "running" ? "Power Off" : "Power On"}
              >
                <i className="fa-solid fa-power-off" aria-hidden="true" />
                <span>{audioCtxState === "running" ? "Power Off" : "Power On"}</span>
              </button>
            </div>
          </div>

          <div className="toolbarGroup toolbarGroupInput" aria-label="MIDI Input">
            <span className="toolbarGroupLabel">MIDI Input</span>
            <div className="toolbarButtonRow">
              <button
                type="button"
                className={`toolbarActionBtn ${midiEnabled ? "active" : ""}`}
                onClick={onToggleMidi}
                disabled={!sf2Ready}
                aria-pressed={midiEnabled}
                aria-label={midiEnabled ? "Disable MIDI" : "Enable MIDI"}
                title={midiEnabled ? "Disable MIDI" : "Enable MIDI"}
              >
                <i className="fa-solid fa-plug" aria-hidden="true" />
                <span>{midiEnabled ? "Disable MIDI" : "Enable MIDI"}</span>
              </button>
              <select
                className="toolbarSelect"
                value={selectedMidiInput}
                onChange={(e) => onSelectMidiInput(e.target.value)}
                disabled={!midiEnabled}
                aria-label="MIDI input source"
                title="MIDI input source"
              >
                <option value="all">All MIDI Inputs</option>
                {midiInputs.map((input) => (
                  <option key={input.id} value={input.id}>
                    {input.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="toolbarGroup toolbarGroupMidiSend" aria-label="MIDI Send">
            <span className="toolbarGroupLabel">MIDI Send</span>
            <div className="toolbarButtonRow">
              <button
                type="button"
                className={`toolbarActionBtn ${midiOutputEnabled ? "active" : ""}`}
                onClick={toggleMidiOutput}
                aria-pressed={midiOutputEnabled}
                aria-label={midiOutputEnabled ? "Disable MIDI Output" : "Enable MIDI Output"}
                title={midiOutputEnabled ? "Disable MIDI Output" : "Enable MIDI Output"}
              >
                <i className="fa-solid fa-share-nodes" aria-hidden="true" />
                <span>{midiOutputEnabled ? "Output On" : "Output Off"}</span>
              </button>
              <select
                className="toolbarSelect"
                value={selectedMidiOutput}
                onChange={(e) => setSelectedMidiOutput(e.target.value)}
                disabled={!midiOutputEnabled || !midiOutputs.length || isSendingMidi}
                aria-label="MIDI output destination"
                title="MIDI output destination"
              >
                <option value="">Select Output</option>
                {midiOutputs.map((output) => (
                  <option key={output.id} value={output.id}>
                    {output.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="toolbarActionBtn toolbarCompactBtn"
                onClick={onRefreshMidiOutputs}
                disabled={isSendingMidi}
                aria-label="Refresh MIDI Outputs"
                title="Refresh MIDI Outputs"
              >
                <i className="fa-solid fa-arrows-rotate" aria-hidden="true" />
              </button>
              <button
                type="button"
                className={`toolbarActionBtn ${isSendingMidi ? "active" : ""}`}
                onClick={isSendingMidi ? () => stopMidiSend("Send stopped") : onSendMidiToOutput}
                disabled={!song || !midiOutputEnabled || !selectedMidiOutput}
                aria-label={isSendingMidi ? "Stop MIDI Send" : "Send MIDI File"}
                title={isSendingMidi ? "Stop MIDI Send" : "Send MIDI File"}
              >
                <i className={`fa-solid ${isSendingMidi ? "fa-stop" : "fa-paper-plane"}`} aria-hidden="true" />
                <span>{isSendingMidi ? "Stop" : "Send"}</span>
              </button>
              <span className="toolbarHoverText midiOutputStatus" title={midiOutputStatus}>
                {midiOutputStatus}
              </span>
            </div>
          </div>

          <div className="toolbarGroup toolbarGroupSong" aria-label="MIDI file">
            <span className="toolbarGroupLabel">MIDI File</span>
            <div className="toolbarButtonRow">
              <label className="fileInput toolbarActionBtn toolbarFileBtn">
                <i className="fa-solid fa-file-arrow-up" aria-hidden="true" />
                <span>Upload MIDI</span>
                <input
                  type="file"
                  accept=".mid,.midi"
                  onChange={onUploadMidi}
                  aria-label="Upload MIDI file"
                />
              </label>
              <label
                className={`fileInput toolbarActionBtn toolbarFileBtn ${isParsingSheetMusic ? "disabled" : ""}`}
                aria-label="Upload a sheet music JPG or PNG"
              >
                <i
                  className={`fa-solid ${isParsingSheetMusic ? "fa-spinner fa-spin" : "fa-image"}`}
                  aria-hidden="true"
                />
                <span>Upload Sheet</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png"
                  capture="environment"
                  onChange={onUploadSheetMusic}
                  disabled={isParsingSheetMusic}
                  aria-label="Scan or upload sheet music"
                />
              </label>
              <button
                type="button"
                className="toolbarActionBtn toolbarCompactBtn"
                onClick={onLoadSwedenSheetMusic}
                disabled={isParsingSheetMusic}
                aria-label="Show Sweden sheet music"
                title="Show Sweden sheet music"
              >
                <i className="fa-solid fa-music" aria-hidden="true" />
                <span>Sweden</span>
              </button>
              <button
                type="button"
                className={`toolbarActionBtn toolbarCompactBtn ${isParsingSheetMusic ? "active" : ""}`}
                onClick={() => void onConvertSelectedSheetMusic()}
                disabled={!selectedSheetMusicImage || isParsingSheetMusic}
                aria-label="Convert selected sheet music to MIDI"
                title="Convert displayed sheet music to MIDI"
              >
                <i
                  className={`fa-solid ${isParsingSheetMusic ? "fa-spinner fa-spin" : "fa-file-audio"}`}
                  aria-hidden="true"
                />
                <span>{isParsingSheetMusic ? "Converting" : "Convert"}</span>
              </button>
              <select
                className="toolbarSelect toolbarSelectWide"
                value={selectedMidiPath}
                onChange={(e) => onSelectMidiPath(e.target.value)}
                disabled={!midiOptions.length}
                aria-label="Select bundled MIDI file"
                title="MIDI files from public/static"
              >
                <option value="">Select MIDI</option>
                {midiOptions.map((midi) => (
                  <option key={midi.path} value={midi.path}>
                    {midi.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="toolbarActionBtn toolbarCompactBtn"
                onClick={onLoadSelectedMidi}
                disabled={!selectedMidiPath}
                aria-label="Reload MIDI"
                title="Reload MIDI"
              >
                <i className="fa-solid fa-rotate-right" aria-hidden="true" />
                <span>Reload</span>
              </button>
            </div>
          </div>

          <div className="toolbarGroup toolbarGroupSoundfont" aria-label="SoundFont">
            <span className="toolbarGroupLabel">SoundFont</span>
            <div className="toolbarButtonRow">
              <label className="fileInput toolbarActionBtn toolbarFileBtn">
                <i className="fa-solid fa-folder-open" aria-hidden="true" />
                <span>Upload SF2</span>
                <input type="file" accept=".sf2" onChange={onUploadSf2} aria-label="Upload SF2 file" />
              </label>
              <button
                type="button"
                className="toolbarActionBtn"
                onClick={onLoadDefaultSf2}
                disabled={sf2Loading}
                aria-label={sf2Loading ? "Loading default SF2" : "Load Default SF2"}
                title={sf2Loading ? "Loading default SF2" : "Load Default SF2"}
              >
                <i
                  className={`fa-solid ${sf2Loading ? "fa-spinner fa-spin" : "fa-database"}`}
                  aria-hidden="true"
                />
                <span>{sf2Loading ? "Loading" : "Default SF2"}</span>
              </button>
              <span className="toolbarStatusPill">
                <span className="toolbarStatusLabel">Loaded</span>
                <span className="toolbarStatusValue">{sf2Name || "No SoundFont"}</span>
              </span>
            </div>
          </div>

          <div className="toolbarGroup toolbarGroupTools" aria-label="Tools">
            <span className="toolbarGroupLabel">Tools</span>
            <div className="toolbarButtonRow">
              <button
                type="button"
                className={`toolbarActionBtn ${!analyzerCollapsed ? "active" : ""}`}
                onClick={onToggleAnalyzer}
                aria-pressed={!analyzerCollapsed}
                aria-label={analyzerCollapsed ? "Show Analyzer" : "Hide Analyzer"}
                title={analyzerCollapsed ? "Show Analyzer" : "Hide Analyzer"}
              >
                <i className="fa-solid fa-chart-column" aria-hidden="true" />
                <span>Analyzer</span>
              </button>
              <button
                type="button"
                className={`toolbarActionBtn ${bachModuleOpen ? "active" : ""}`}
                onClick={() => setBachModuleOpen((open) => !open)}
                aria-pressed={bachModuleOpen}
                aria-label={bachModuleOpen ? "Close Bach Composer" : "Open Bach Composer"}
                title={bachModuleOpen ? "Close Bach Composer" : "Open Bach Composer"}
              >
                <i
                  className={`fa-solid ${isGeneratingBach ? "fa-spinner fa-spin" : "fa-wand-magic-sparkles"}`}
                  aria-hidden="true"
                />
                <span>Bach Composer</span>
              </button>
            </div>
          </div>
        </div>
        {selectedSheetMusicImage ? (
          <div className="sheetMusicPreviewPanel" aria-label="Displayed sheet music">
            <div className="sheetMusicPreviewHeader">
              <span className="songChipLabel">Sheet Image</span>
              <strong>{selectedSheetMusicImage.name}</strong>
              <span className="chip">{selectedSheetMusicImage.source === "sample" ? "Sample" : "Uploaded"}</span>
              <button
                type="button"
                className="toolbarActionBtn sheetMusicConvertBtn"
                onClick={() => void onConvertSelectedSheetMusic()}
                disabled={isParsingSheetMusic}
                aria-label="Convert previewed sheet music to MIDI"
                title="Convert displayed sheet music to MIDI"
              >
                <i
                  className={`fa-solid ${isParsingSheetMusic ? "fa-spinner fa-spin" : "fa-file-audio"}`}
                  aria-hidden="true"
                />
                <span>{isParsingSheetMusic ? "Converting" : "Convert MIDI"}</span>
              </button>
            </div>
            <div className="sheetMusicPreviewFrame">
              <img src={selectedSheetMusicImage.previewUrl} alt={`${selectedSheetMusicImage.name} sheet music preview`} />
            </div>
          </div>
        ) : null}
        {bachModuleOpen ? (
          <div className="bachComposerModule">
            <div className="bachComposerControls">
              <label>
                <span>Key</span>
                <select
                  value={bachConfig.key}
                  onChange={(e) => onBachConfigChange("key", e.target.value as BachKey)}
                  disabled={isGeneratingBach}
                >
                  {BACH_KEY_OPTIONS.map((key) => (
                    <option key={key} value={key}>{key}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Length</span>
                <select
                  value={bachConfig.length}
                  onChange={(e) => onBachConfigChange("length", e.target.value as BachLength)}
                  disabled={isGeneratingBach}
                >
                  {BACH_LENGTH_OPTIONS.map((length) => (
                    <option key={length} value={length}>
                      {length.charAt(0).toUpperCase() + length.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Voices</span>
                <select
                  value={bachConfig.voices}
                  onChange={(e) => onBachConfigChange("voices", Number(e.target.value) as BachFugueConfig["voices"])}
                  disabled={isGeneratingBach}
                >
                  {BACH_VOICE_OPTIONS.map((voices) => (
                    <option key={voices} value={voices}>{voices}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Character</span>
                <select
                  value={bachConfig.character}
                  onChange={(e) => onBachConfigChange("character", e.target.value as BachCharacter)}
                  disabled={isGeneratingBach}
                >
                  {BACH_CHARACTER_OPTIONS.map((character) => (
                    <option key={character} value={character}>{character}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Complexity</span>
                <select
                  value={bachConfig.complexity}
                  onChange={(e) => onBachConfigChange("complexity", Number(e.target.value) as BachFugueConfig["complexity"])}
                  disabled={isGeneratingBach}
                >
                  {BACH_COMPLEXITY_OPTIONS.map((complexity) => (
                    <option key={complexity} value={complexity}>{complexity}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Tempo</span>
                <select
                  value={bachConfig.tempo}
                  onChange={(e) => onBachConfigChange("tempo", Number(e.target.value))}
                  disabled={isGeneratingBach}
                >
                  {BACH_TEMPO_OPTIONS.map((tempo) => (
                    <option key={tempo} value={tempo}>{tempo}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="bachComposerActions">
              <button
                type="button"
                className="bachActionBtn"
                onClick={() => void onGenerateBachMusic(false)}
                disabled={isGeneratingBach}
                aria-label="Generate Bach Music"
                title="Generate Bach Music"
              >
                <i className={`fa-solid ${isGeneratingBach ? "fa-spinner fa-spin" : "fa-wand-magic-sparkles"}`} aria-hidden="true" />
                <span>{isGeneratingBach ? "Generating" : "Generate"}</span>
              </button>
              <button
                type="button"
                className="bachActionBtn"
                onClick={() => void onGenerateBachMusic(true)}
                disabled={isGeneratingBach}
                aria-label="New Seed"
                title="New Seed"
              >
                <i className="fa-solid fa-rotate-right" aria-hidden="true" />
                <span>New Seed</span>
              </button>
              <span className="chip bachSeedChip">Seed {bachConfig.seed}</span>
            </div>
          </div>
        ) : null}
        <div className="midiTopGroup midiTopTransport midiTopTransportFull">
          <div className="transportHero">
            <button
              type="button"
              className="transportBtn"
              onClick={() => seekBy(-10)}
              disabled={!song}
              aria-label="Rewind 10 seconds"
              title="Rewind 10 seconds"
            >
              <i className="fa-solid fa-backward" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="transportBtn transportBtnPrimary"
              onClick={onPlayPause}
              disabled={!song || !sf2Ready}
              aria-label={isPlaying ? "Pause" : "Play"}
              title={isPlaying ? "Pause" : "Play"}
            >
              <i className={`fa-solid ${isPlaying ? "fa-pause" : "fa-play"}`} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="transportBtn"
              onClick={() => seekBy(10)}
              disabled={!song}
              aria-label="Forward 10 seconds"
              title="Forward 10 seconds"
            >
              <i className="fa-solid fa-forward" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="transportBtn"
              onClick={onExportWav}
              disabled={!song || !sf2Ready || isExporting}
              aria-label="Export WAV"
              title="Generate offline WAV export"
            >
              {isExporting
                ? <i className="fa-solid fa-spinner fa-spin" aria-hidden="true" />
                : <i className="fa-solid fa-download" aria-hidden="true" />}
            </button>
            <span className="transportState">
              {transportStateLabel}
            </span>
            <input
              className="transportSeekSlider"
              type="range"
              min={0}
              max={duration}
              step={0.01}
              value={Math.max(0, Math.min(duration, songTime))}
              onChange={onSeekSliderChange}
              onPointerDown={onSeekSliderPointerDown}
              onPointerUp={onSeekSliderPointerUp}
              onPointerCancel={onSeekSliderPointerUp}
              disabled={!song}
              aria-label="Playback position"
              title="Playback position"
            />
            {isExporting ? (
              <div className="exportProgress" aria-live="polite">
                <div className="exportProgressBar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(exportProgress * 100)}>
                  <span className="exportProgressFill" style={{ width: `${Math.round(exportProgress * 100)}%` }} />
                </div>
                <span className="exportProgressLabel">
                  {exportStage} {Math.round(exportProgress * 100)}%
                </span>
              </div>
            ) : null}
            <strong className="transportTimer">{fmtTime(songTime)} / {fmtTime(duration)}</strong>
            <span className="chip">{song ? `Tempo ${song.bpm} BPM` : "Tempo --"}</span>
            <span className="chip">{song ? `Sig ${song.timeSig}` : "Sig --"}</span>
          </div>
        </div>
        {song ? (
          <div className="midiMetadataPanel" aria-label="MIDI metadata">
            <div className="midiMetadataTitle">
              <span className="songChipLabel">Current MIDI</span>
              <strong>{songName || "Untitled MIDI"}</strong>
              <span className="chip">
                {currentMidiSource?.kind === "bundled"
                  ? "Bundled"
                  : currentMidiSource?.kind === "generated"
                    ? "Generated"
                    : "Uploaded"}
              </span>
            </div>
            <div className="midiMetadataGrid">
              <span>Format {song.format}</span>
              <span>{song.tracks.length} tracks</span>
              <span>{songMetadata?.noteCount ?? 0} notes</span>
              <span>{songMetadata?.eventCount ?? 0} events</span>
              <span>{Math.round(song.totalBars)} bars</span>
              <span>PPQ {song.division}</span>
              <span>{fmtTime(song.durationSec)} duration</span>
              {currentMidiSource?.path ? <span>{currentMidiSource.path}</span> : null}
            </div>
            {songMetadata?.namedTrackPreview ? (
              <div className="midiMetadataTracks">{songMetadata.namedTrackPreview}</div>
            ) : null}
          </div>
        ) : null}
      </div>
      {sheetMusicStage ? <p className="status sheetMusicStatus">{sheetMusicStage}</p> : null}
      {sheetMusicNotice ? <p className="status sheetMusicStatus">{sheetMusicNotice}</p> : null}
      {songError ? <p className="status error">{songError}</p> : null}
      {song && (
        <div className="midiTimelineWrap">
          <div className="midiTracksSplit">
            <div className="midiTracksLeft">
              {visibleTracks.map((track) => (
                <div key={`left-${track.index}`} className="midiTrackLabelRow">
                  <div className="midiTrackLabel">
                    <strong>#{track.index + 1}</strong>
                    <div className="trackMixButtons">
                      <button
                        type="button"
                        className={`mixBtn ${trackMixState[track.index]?.mute ? "active" : ""}`}
                        onClick={() => onToggleTrackMute(track.index)}
                        disabled={!sf2Ready}
                        title="Mute"
                      >
                        <i className="fa-solid fa-volume-xmark" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className={`mixBtn ${trackMixState[track.index]?.solo ? "active" : ""}`}
                        onClick={() => onToggleTrackSolo(track.index)}
                        disabled={!sf2Ready}
                        title="Solo"
                      >
                        <i className="fa-solid fa-headphones" aria-hidden="true" />
                      </button>
                    </div>
                    <span>{formatTrackInlineName(track) || track.instrumentName}</span>
                  </div>
                  <div className="midiTrackCc">
                    <CcKnob
                      label="EXP"
                      value={getTrackCc(track.index).cc11Expression}
                      onChange={(next) => onTrackCcChange(track.index, "cc11Expression", next)}
                      disabled={!sf2Ready}
                    />
                    <CcKnob
                      label="VOL"
                      value={getTrackCc(track.index).cc7Volume}
                      onChange={(next) => onTrackCcChange(track.index, "cc7Volume", next)}
                      disabled={!sf2Ready}
                    />
                    <CcKnob
                      label="PAN"
                      value={getTrackCc(track.index).cc10Pan}
                      onChange={(next) => onTrackCcChange(track.index, "cc10Pan", next)}
                      disabled={!sf2Ready}
                    />
                  </div>
                  <select
                    value={
                      trackPresetOverrides[track.index] ??
                      (trackDefaultPresetMap[track.index] ?? "")
                    }
                    onChange={(e) => onTrackPresetChange(track.index, e.target.value)}
                    disabled={!sf2Ready}
                  >
                    <option value="">Prg</option>
                    {presetOptions.map((p) => (
                      <option key={`preset-${p.index}`} value={p.index}>
                        {p.bank}:{p.program} {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <div className="midiScrollViewport" ref={viewportRef}>
              <div className="midiTimelineContent" style={{ width: `${contentW}px` }} ref={contentRef}>
                <div ref={playheadRef} className="midiPlayheadOptimized" />
                {visibleTracks.map((track) => {
                  const minNote = track.notes.length ? Math.min(...track.notes.map((n) => n.note)) : 48;
                  const maxNote = track.notes.length ? Math.max(...track.notes.map((n) => n.note)) : 72;
                  const span = Math.max(1, maxNote - minNote + 1);
                  return (
                    <div key={`right-${track.index}`} className="midiTrackSvgRow">
                      <svg className="midiTrackSvg" viewBox={`0 0 ${timelineW} ${trackH}`} preserveAspectRatio="none">
                        <rect x="0" y="0" width={timelineW} height={trackH} fill="#f7fbff" />
                        {track.notes.map((n, idx) => {
                          const x = (n.startSec / duration) * timelineW;
                          const w = Math.max(1.5, (n.durationSec / duration) * timelineW);
                          const y = ((maxNote - n.note) / span) * (trackH - 8) + 2;
                          const h = Math.max(2, (trackH - 8) / span);
                          return (
                            <rect key={idx} x={x} y={y} width={w} height={h} fill="#2d6a93" opacity="0.8" />
                          );
                        })}
                      </svg>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
