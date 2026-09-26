import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseSF2, SF2Data, SF2Region } from "../sf2-parser.ts";
import { NavMenuSection, ToolbarMenu } from "./toolbar-menu.tsx";
import { createExternalMidiBridge, ExternalMidiBridge } from "./external-midi-bridge";
import {
  createMidiDriver,
  createMidiMessageHandler,
  isMidiPermissionDeniedError,
  MidiDriver,
  MidiMessageHandler,
} from "./midi-driver";
import MidiReader from "./midireader";
import ErrorBoundary from "./ErrorBoundary";
import { MidiRecorderUI } from "./MidiRecorderUI";
import sf2ProcessorUrl from "./sf2-processor.ts?worker&url";
import masterDynamicsUrl from "./master-dynamics-processor.ts?worker&url";
import { DEFAULT_DYNAMICS_MODE, DYNAMICS_MODES, isDynamicsMode, type DynamicsMode } from "./master-dynamics.ts";

// ---------------------------------------------------------------------------
// Local interface definitions for SF2 internal structures accessed at runtime
// ---------------------------------------------------------------------------

interface GenRecord {
  oper: number;
  amount: number;
}

interface ModRecord {
  srcOper: number;
  destOper: number;
  amount: number;
  amtSrcOper: number;
  transOper: number;
}

interface Zone {
  bagIndex: number;
  gens: GenRecord[];
  mods: ModRecord[];
}

interface SampleZone extends Zone {
  sampleID: number;
  sampleName: string;
  sampleRate: number;
}

interface Instrument {
  index: number;
  name: string;
  globalZone: Zone | null;
  sampleZones: SampleZone[];
}

interface PresetHeader {
  presetName: string;
  preset: number;
  bank: number;
  presetBagNdx: number;
  library: number;
  genre: number;
  morphology: number;
}

interface LevelEntry {
  label: string;
  gens: GenRecord[];
  mods: ModRecord[];
}

interface SelectedLayer {
  type: string;
  title: string;
  context: string;
  levels: LevelEntry[];
  bagIndex: number;
}

interface ProgramDetails {
  header: PresetHeader;
  presetGlobal: Zone | null;
  regionZones: Zone[];
  instruments: Instrument[];
  previewRegion: SF2Region | undefined;
}

interface PresetRow {
  presetName: string;
  preset: number;
  bank: number;
  presetBagNdx: number;
  library: number;
  genre: number;
  morphology: number;
  _index: number;
}

interface SampleFile {
  label: string;
  path: string;
}

interface PresetRegionCache {
  presetIndex: number | null;
  regions: SF2Region[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAMPLE_FILES: SampleFile[] = [
  {
    label: "GeneralUser-GS.sf2",
    path: `${import.meta.env.BASE_URL}static/GeneralUser-GS.sf2`,
  },
];
const DEFAULT_SF2 = SAMPLE_FILES[0];

const QWERTY_NOTE_MAP: Record<string, number> = {
  a: 60, // C4
  w: 61, // C#4
  s: 62, // D4
  e: 63, // D#4
  d: 64, // E4
  f: 65, // F4
  t: 66, // F#4
  g: 67, // G4
  y: 68, // G#4
  h: 69, // A4
};

function getPresetRows(sf2: SF2Data | null): PresetHeader[] {
  return sf2?.pdta?.phdr?.slice(0, -1) ?? [];
}

const GEN_OPER_NAMES: Record<number, string> = {
  0: "startAddrsOffset",
  1: "endAddrsOffset",
  2: "startloopAddrsOffset",
  3: "endloopAddrsOffset",
  4: "startAddrsCoarseOffset",
  5: "modLfoToPitch",
  6: "vibLfoToPitch",
  7: "modEnvToPitch",
  8: "initialFilterFc",
  9: "initialFilterQ",
  10: "modLfoToFilterFc",
  11: "modEnvToFilterFc",
  12: "endAddrsCoarseOffset",
  13: "modLfoToVolume",
  15: "chorusEffectsSend",
  16: "reverbEffectsSend",
  17: "pan",
  21: "delayModLFO",
  22: "freqModLFO",
  23: "delayVibLFO",
  24: "freqVibLFO",
  25: "delayModEnv",
  26: "attackModEnv",
  27: "holdModEnv",
  28: "decayModEnv",
  29: "sustainModEnv",
  30: "releaseModEnv",
  33: "delayVolEnv",
  34: "attackVolEnv",
  35: "holdVolEnv",
  36: "decayVolEnv",
  37: "sustainVolEnv",
  38: "releaseVolEnv",
  41: "instrument",
  43: "keyRange",
  44: "velRange",
  48: "initialAttenuation",
  51: "coarseTune",
  52: "fineTune",
  53: "sampleID",
  54: "sampleModes",
  56: "scaleTuning",
  57: "exclusiveClass",
  58: "overridingRootKey",
};

function readZones(
  bags: { genNdx: number; modNdx: number }[],
  gens: GenRecord[],
  mods: ModRecord[],
  start: number,
  end: number
): Zone[] {
  const out: Zone[] = [];
  for (let bi = start; bi < end; bi += 1) {
    const genStart = bags[bi]?.genNdx ?? 0;
    const genEnd = bags[bi + 1]?.genNdx ?? gens.length;
    const modStart = bags[bi]?.modNdx ?? 0;
    const modEnd = bags[bi + 1]?.modNdx ?? mods.length;
    out.push({
      bagIndex: bi,
      gens: gens.slice(genStart, genEnd),
      mods: mods.slice(modStart, modEnd),
    });
  }
  return out;
}

function unpackRange(amount: number): [number, number] {
  const u = amount & 0xffff;
  return [u & 0xff, (u >> 8) & 0xff];
}

function getLastGeneratorAmount(gens: GenRecord[], oper: number): number | null {
  for (let i = gens.length - 1; i >= 0; i -= 1) {
    if (gens[i].oper === oper) return gens[i].amount;
  }
  return null;
}

function formatGeneratorValue(g: GenRecord): string {
  if (g.oper === 43 || g.oper === 44) {
    const [lo, hi] = unpackRange(g.amount);
    return `${lo}-${hi}`;
  }
  return `${g.amount}`;
}

function formatModTarget(mod: ModRecord): string {
  return GEN_OPER_NAMES[mod.destOper] ?? `op${mod.destOper}`;
}

function zoneKeyVel(zone: Zone): { keyLo: number; keyHi: number; velLo: number; velHi: number } {
  const keyRange = getLastGeneratorAmount(zone.gens, 43);
  const velRange = getLastGeneratorAmount(zone.gens, 44);
  const [keyLo, keyHi] = keyRange != null ? unpackRange(keyRange) : [0, 127];
  const [velLo, velHi] = velRange != null ? unpackRange(velRange) : [0, 127];
  return { keyLo, keyHi, velLo, velHi };
}

function zoneMatches(zone: Zone, note: number, velocity: number): boolean {
  const { keyLo, keyHi, velLo, velHi } = zoneKeyVel(zone);
  return note >= keyLo && note <= keyHi && velocity >= velLo && velocity <= velHi;
}

function rangeFromGenerators(gens: GenRecord[]): {
  keyLo: number;
  keyHi: number;
  velLo: number;
  velHi: number;
} {
  const keyRange = getLastGeneratorAmount(gens ?? [], 43);
  const velRange = getLastGeneratorAmount(gens ?? [], 44);
  const [keyLo, keyHi] = keyRange != null ? unpackRange(keyRange) : [0, 127];
  const [velLo, velHi] = velRange != null ? unpackRange(velRange) : [0, 127];
  return { keyLo, keyHi, velLo, velHi };
}

function selectLayerFromMidi(
  programDetails: ProgramDetails,
  note: number,
  velocity: number
): SelectedLayer | null {
  if (!programDetails) return null;
  const matchedRegion = programDetails.regionZones.find((zone) => zoneMatches(zone, note, velocity));
  if (!matchedRegion) return null;
  const instIndex = getLastGeneratorAmount(matchedRegion.gens, 41);
  const inst = programDetails.instruments.find((item) => item.index === instIndex);
  const matchedInstZone =
    inst?.sampleZones.find((zone) => zoneMatches(zone, note, velocity)) ?? inst?.sampleZones[0];
  const levels: LevelEntry[] = [];
  if (programDetails.presetGlobal) {
    levels.push({
      label: `Preset global bag ${programDetails.presetGlobal.bagIndex}`,
      gens: programDetails.presetGlobal.gens,
      mods: programDetails.presetGlobal.mods,
    });
  }
  levels.push({
    label: `Preset region bag ${matchedRegion.bagIndex}`,
    gens: matchedRegion.gens,
    mods: matchedRegion.mods,
  });
  if (inst?.globalZone) {
    levels.push({
      label: `Instrument ${inst.index} global bag ${inst.globalZone.bagIndex}`,
      gens: inst.globalZone.gens,
      mods: inst.globalZone.mods,
    });
  }
  if (matchedInstZone) {
    levels.push({
      label: `Instrument ${inst!.index} region bag ${matchedInstZone.bagIndex}`,
      gens: matchedInstZone.gens,
      mods: matchedInstZone.mods,
    });
  }
  return {
    type: "region",
    title: `Preset region ${matchedRegion.bagIndex}`,
    context: `instrument ${instIndex}`,
    levels,
    bagIndex: matchedRegion.bagIndex,
  };
}

function buildSelectionFromRegion(
  programDetails: ProgramDetails,
  regionZone: Zone,
  midiNote: number,
  midiVelocity: number
): SelectedLayer {
  const instIndex = getLastGeneratorAmount(regionZone.gens, 41);
  const inst = programDetails.instruments.find((item) => item.index === instIndex);
  const matchedInstZone =
    inst?.sampleZones.find((zone) => zoneMatches(zone, midiNote, midiVelocity)) ??
    inst?.sampleZones[0];
  const levels: LevelEntry[] = [];
  if (programDetails.presetGlobal) {
    levels.push({
      label: `Preset global bag ${programDetails.presetGlobal.bagIndex}`,
      gens: programDetails.presetGlobal.gens,
      mods: programDetails.presetGlobal.mods,
    });
  }
  levels.push({
    label: `Preset region bag ${regionZone.bagIndex}`,
    gens: regionZone.gens,
    mods: regionZone.mods,
  });
  if (inst?.globalZone) {
    levels.push({
      label: `Instrument ${inst.index} global bag ${inst.globalZone.bagIndex}`,
      gens: inst.globalZone.gens,
      mods: inst.globalZone.mods,
    });
  }
  if (matchedInstZone) {
    levels.push({
      label: `Instrument ${inst!.index} region bag ${matchedInstZone.bagIndex}`,
      gens: matchedInstZone.gens,
      mods: matchedInstZone.mods,
    });
  }
  return {
    type: "region",
    title: `Preset region ${regionZone.bagIndex}`,
    context: `instrument ${instIndex}`,
    levels,
    bagIndex: regionZone.bagIndex,
  };
}

function buildSelectionFromInstrumentGlobal(
  programDetails: ProgramDetails,
  inst: Instrument,
  midiNote: number,
  midiVelocity: number
): SelectedLayer {
  const candidateRegion = programDetails.regionZones.find(
    (zone) =>
      getLastGeneratorAmount(zone.gens, 41) === inst.index && zoneMatches(zone, midiNote, midiVelocity)
  );
  const candidateInstRegion =
    inst.sampleZones.find((zone) => zoneMatches(zone, midiNote, midiVelocity)) ?? inst.sampleZones[0];
  const levels: LevelEntry[] = [];
  if (programDetails.presetGlobal) {
    levels.push({
      label: `Preset global bag ${programDetails.presetGlobal.bagIndex}`,
      gens: programDetails.presetGlobal.gens,
      mods: programDetails.presetGlobal.mods,
    });
  }
  if (candidateRegion) {
    levels.push({
      label: `Preset region bag ${candidateRegion.bagIndex}`,
      gens: candidateRegion.gens,
      mods: candidateRegion.mods,
    });
  }
  if (inst.globalZone) {
    levels.push({
      label: `Instrument ${inst.index} global bag ${inst.globalZone.bagIndex}`,
      gens: inst.globalZone.gens,
      mods: inst.globalZone.mods,
    });
  }
  if (candidateInstRegion) {
    levels.push({
      label: `Instrument ${inst.index} region bag ${candidateInstRegion.bagIndex}`,
      gens: candidateInstRegion.gens,
      mods: candidateInstRegion.mods,
    });
  }
  return {
    type: "instrumentGlobal",
    title: `Instrument ${inst.index} global`,
    context: inst.name || "(unnamed)",
    levels,
    bagIndex: inst.globalZone?.bagIndex ?? -1,
  };
}

function buildSelectionFromInstrumentRegion(
  programDetails: ProgramDetails,
  inst: Instrument,
  zone: SampleZone,
  midiNote: number,
  midiVelocity: number
): SelectedLayer {
  const candidateRegion = programDetails.regionZones.find(
    (r) => getLastGeneratorAmount(r.gens, 41) === inst.index && zoneMatches(r, midiNote, midiVelocity)
  );
  const levels: LevelEntry[] = [];
  if (programDetails.presetGlobal) {
    levels.push({
      label: `Preset global bag ${programDetails.presetGlobal.bagIndex}`,
      gens: programDetails.presetGlobal.gens,
      mods: programDetails.presetGlobal.mods,
    });
  }
  if (candidateRegion) {
    levels.push({
      label: `Preset region bag ${candidateRegion.bagIndex}`,
      gens: candidateRegion.gens,
      mods: candidateRegion.mods,
    });
  }
  if (inst.globalZone) {
    levels.push({
      label: `Instrument ${inst.index} global bag ${inst.globalZone.bagIndex}`,
      gens: inst.globalZone.gens,
      mods: inst.globalZone.mods,
    });
  }
  levels.push({
    label: `Instrument ${inst.index} region bag ${zone.bagIndex}`,
    gens: zone.gens,
    mods: zone.mods,
  });
  return {
    type: "instrumentRegion",
    title: `Instrument ${inst.index} zone ${zone.bagIndex}`,
    context: `sample ${zone.sampleID} (${zone.sampleName})`,
    levels,
    bagIndex: zone.bagIndex,
  };
}

function extractProgramDetails(sf2: SF2Data | null, presetIndex: number | null): ProgramDetails | null {
  if (!sf2 || presetIndex == null) return null;
  const pdta = sf2.pdta;
  const header = pdta.phdr[presetIndex] as PresetHeader | undefined;
  const next = pdta.phdr[presetIndex + 1];
  if (!header || !next) return null;

  const presetZones = readZones(
    pdta.pbag as { genNdx: number; modNdx: number }[],
    pdta.pgen as GenRecord[],
    pdta.pmod as ModRecord[],
    header.presetBagNdx,
    (next as PresetHeader).presetBagNdx
  );
  const presetGlobal: Zone | null =
    presetZones.length > 0 && getLastGeneratorAmount(presetZones[0].gens, 41) == null
      ? presetZones[0]
      : null;
  const regionZones = presetZones.filter((z) => getLastGeneratorAmount(z.gens, 41) != null);

  const instrumentIndexes = [
    ...new Set(
      regionZones
        .map((z) => getLastGeneratorAmount(z.gens, 41))
        .filter((idx): idx is number => idx != null && idx >= 0 && idx < pdta.inst.length - 1)
    ),
  ];

  const instruments: Instrument[] = instrumentIndexes.map((instIndex) => {
    const inst = pdta.inst[instIndex] as { instName: string; instBagNdx: number };
    const instNext = pdta.inst[instIndex + 1] as { instBagNdx: number };
    const zones = readZones(
      pdta.ibag as { genNdx: number; modNdx: number }[],
      pdta.igen as GenRecord[],
      pdta.imod as ModRecord[],
      inst.instBagNdx,
      instNext.instBagNdx
    );
    const globalZone: Zone | null =
      zones.length > 0 && getLastGeneratorAmount(zones[0].gens, 53) == null ? zones[0] : null;
    const sampleZones: SampleZone[] = zones
      .filter((z) => getLastGeneratorAmount(z.gens, 53) != null)
      .map((z) => {
        const sampleID = getLastGeneratorAmount(z.gens, 53) as number;
        const sh = pdta.shdr[sampleID] as { sampleName: string; sampleRate: number } | undefined;
        return {
          ...z,
          sampleID,
          sampleName: sh?.sampleName ?? "",
          sampleRate: sh?.sampleRate ?? 0,
        };
      });

    return {
      index: instIndex,
      name: inst.instName,
      globalZone,
      sampleZones,
    };
  });

  const previewRegion = sf2
    .buildRegionsForPreset(presetIndex, {
      decodeToFloat32: true,
      normalize: false,
      includeStereoLinks: false,
    })
    .find((r) => r.sample?.dataL?.length > 0);

  return {
    header,
    presetGlobal,
    regionZones,
    instruments,
    previewRegion,
  };
}

// ---------------------------------------------------------------------------
// WaveformCanvas
// ---------------------------------------------------------------------------

interface WaveformCanvasProps {
  data: Float32Array | null | undefined;
}

function WaveformCanvas({ data }: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.fillStyle = "#f2f8fd";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#0f4c75";
    ctx.lineWidth = 1;
    ctx.beginPath();

    const source = data ?? new Float32Array(0);
    if (source.length === 0) {
      ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
      return;
    }

    const mid = height / 2;
    const step = Math.max(1, Math.floor(source.length / width));
    for (let x = 0; x < width; x += 1) {
      const start = x * step;
      const end = Math.min(source.length, start + step);
      let min = 1;
      let max = -1;
      for (let i = start; i < end; i += 1) {
        const v = source[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const y1 = mid + min * mid;
      const y2 = mid + max * mid;
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
    }
    ctx.stroke();
    ctx.strokeStyle = "#6f8ca1";
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  }, [data]);

  return <canvas ref={canvasRef} width={460} height={120} className="waveCanvas" />;
}

// ---------------------------------------------------------------------------
// AnalyzerCanvas
// ---------------------------------------------------------------------------

interface AnalyzerCanvasProps {
  data: number[];
  mode: "time" | "freq";
  testId?: string;
}

function AnalyzerCanvas({ data, mode, testId }: AnalyzerCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const signalPeak = useMemo(() => {
    if (!data?.length) return 0;
    return data.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
  }, [data]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = "#f7fbff";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "#5f8096";
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1);

    if (!data?.length) return;

    if (mode === "time") {
      let peak = 0.0001;
      for (let i = 0; i < data.length; i += 1) {
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
      }
      const scale = Math.max(0.05, peak);
      ctx.strokeStyle = "#0e5a7b";
      ctx.beginPath();
      for (let i = 0; i < data.length; i += 1) {
        const x = (i / (data.length - 1 || 1)) * (width - 1);
        const v = Math.max(-1, Math.min(1, data[i] / scale));
        const y = (1 - (v + 1) / 2) * (height - 1);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      return;
    }

    ctx.fillStyle = "#0b7d5c";
    const barW = width / data.length;
    for (let i = 0; i < data.length; i += 1) {
      const v = Math.max(0, Math.min(255, data[i])) / 255;
      const h = v * (height - 2);
      ctx.fillRect(i * barW, height - 1 - h, Math.max(1, barW - 1), h);
    }
  }, [data, mode]);

  return (
    <canvas
      ref={canvasRef}
      width={460}
      height={90}
      className="analyzerCanvas"
      data-testid={testId}
      data-signal-peak={signalPeak.toFixed(6)}
    />
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const [sf2, setSf2] = useState<SF2Data | null>(null);
  const [sourceName, setSourceName] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingStage, setLoadingStage] = useState("");
  const [selectedPreset, setSelectedPreset] = useState<number | null>(null);
  const [showSummaryModal, setShowSummaryModal] = useState<boolean>(false);
  const [presetSearch, setPresetSearch] = useState<string>("");
  const [sortKey, setSortKey] = useState<string>("bank");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [midiNote, setMidiNote] = useState<number>(60);
  const [midiVelocity, setMidiVelocity] = useState<number>(100);
  const [selectedLayer, setSelectedLayer] = useState<SelectedLayer | null>(null);
  const [audioReady, setAudioReady] = useState<boolean>(false);
  const [audioError, setAudioError] = useState<string>("");
  const [recentTimeData, setRecentTimeData] = useState<number[]>([]);
  const [recentFreqData, setRecentFreqData] = useState<number[]>([]);
  const [midiEnabled, setMidiEnabled] = useState<boolean>(false);
  const [midiStatus, setMidiStatus] = useState<string>("MIDI disabled");
  const [midiInputs, setMidiInputs] = useState<{ id: string; name: string }[]>([]);
  const [selectedMidiInput, setSelectedMidiInput] = useState<string>("all");
  const [activeTab, setActiveTab] = useState<string>("midi");
  const [audioCtxState, setAudioCtxState] = useState<string>("off");
  const [dynamicsMode, setDynamicsMode] = useState<DynamicsMode>(() => {
    try {
      const saved = window.localStorage.getItem("sf2-master-dynamics");
      return isDynamicsMode(saved) ? saved : DEFAULT_DYNAMICS_MODE;
    } catch {
      return DEFAULT_DYNAMICS_MODE;
    }
  });
  const [dynamicsMeter, setDynamicsMeter] = useState({ compression: 0, limiting: 0 });
  const [didAutoLoadDefault, setDidAutoLoadDefault] = useState<boolean>(false);
  const [didAutoEnableMidi, setDidAutoEnableMidi] = useState<boolean>(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const [masterVolume, setMasterVolume] = useState(1);
  const masterVolumeRef = useRef(1);
  const compressorRef = useRef<AudioWorkletNode | null>(null);
  const dynamicsModeRef = useRef(dynamicsMode);
  const dynamicsLoadPromiseRef = useRef<Promise<void> | null>(null);
  const timeDomainRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const freqDomainRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastVizUpdateRef = useRef<number>(0);
  const noteOffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const midiDriverRef = useRef<MidiDriver | null>(null);
  const externalMidiMessageHandlerRef = useRef<MidiMessageHandler | null>(null);
  const externalMidiBridgeRef = useRef<ExternalMidiBridge | null>(null);
  const presetRegionsRef = useRef<PresetRegionCache>({ presetIndex: null, regions: [] });
  const presetRegionCacheRef = useRef<Map<number, SF2Region[]>>(new Map());
  const activeKeyboardKeysRef = useRef<Map<string, number>>(new Map());
  const workletLoadPromiseRef = useRef<Promise<void> | null>(null);
  const selectedPresetRef = useRef<number | null>(null);
  const livePresetIndexRef = useRef<number | null>(null);
  const triggerNoteOnRef = useRef<((note: number, velocity: number) => Promise<void>) | null>(null);
  const triggerNoteOffRef = useRef<((note: number) => Promise<void>) | null>(null);
  const resolvePresetIndexRef = useRef<((program: number, bank: number) => number | null) | null>(null);

  const releaseAudioInfrastructure = useCallback(() => {
    // Fast Refresh retains refs while re-running effect cleanup. None of the
    // nodes, module promises, or animation handles can survive a closed context.
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx) ctx.onstatechange = null;
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    lastVizUpdateRef.current = 0;
    if (compressorRef.current) compressorRef.current.port.onmessage = null;
    workletNodeRef.current?.disconnect();
    compressorRef.current?.disconnect();
    analyserRef.current?.disconnect();
    masterGainRef.current?.disconnect();
    workletNodeRef.current = null;
    compressorRef.current = null;
    analyserRef.current = null;
    masterGainRef.current = null;
    timeDomainRef.current = null;
    freqDomainRef.current = null;
    workletLoadPromiseRef.current = null;
    dynamicsLoadPromiseRef.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
  }, []);

  const presets = useMemo(() => getPresetRows(sf2), [sf2]);
  const visiblePresets = useMemo<PresetRow[]>(() => {
    const query = presetSearch.trim().toLowerCase();
    const rows = presets
      .map((preset, index) => ({ ...preset, _index: index }))
      .filter((preset) => {
        if (!query) return true;
        const text = `${preset.presetName} ${preset.bank} ${preset.preset}`.toLowerCase();
        return text.includes(query);
      })
      .sort((a, b) => {
        const mult = sortDirection === "asc" ? 1 : -1;
        if (sortKey === "program") {
          if (a.preset !== b.preset) return (a.preset - b.preset) * mult;
          if (a.bank !== b.bank) return (a.bank - b.bank) * mult;
          return (a._index - b._index) * mult;
        }
        if (a.bank !== b.bank) return (a.bank - b.bank) * mult;
        if (a.preset !== b.preset) return (a.preset - b.preset) * mult;
        return (a._index - b._index) * mult;
      });
    return rows;
  }, [presets, presetSearch, sortDirection, sortKey]);
  const programDetails = useMemo<ProgramDetails | null>(
    () => extractProgramDetails(sf2, selectedPreset),
    [sf2, selectedPreset]
  );
  const effectivePresetIndex = useMemo<number | null>(() => {
    if (!sf2) return null;
    if (selectedPreset != null) return selectedPreset;
    return presets.length > 0 ? 0 : null;
  }, [sf2, selectedPreset, presets.length]);
  selectedPresetRef.current = selectedPreset;
  livePresetIndexRef.current = effectivePresetIndex;
  dynamicsModeRef.current = dynamicsMode;

  useEffect(() => {
    compressorRef.current?.port.postMessage({ type: "setMode", mode: dynamicsMode });
    try {
      window.localStorage.setItem("sf2-master-dynamics", dynamicsMode);
    } catch {
      // Audio controls still work when storage is unavailable.
    }
  }, [dynamicsMode]);

  useEffect(() => {
    if (!programDetails) {
      setSelectedLayer(null);
      return;
    }
    const auto = selectLayerFromMidi(programDetails, midiNote, midiVelocity);
    setSelectedLayer(auto);
  }, [programDetails, midiNote, midiVelocity]);

  useEffect(() => {
    return () => {
      const active = [...activeKeyboardKeysRef.current.values()];
      activeKeyboardKeysRef.current.clear();
      for (const note of active) triggerNoteOff(note);
      if (noteOffTimerRef.current) clearTimeout(noteOffTimerRef.current);
      releaseAudioInfrastructure();
      if (midiDriverRef.current) {
        midiDriverRef.current.disconnect();
      }
      externalMidiBridgeRef.current?.dispose();
    };
  }, [releaseAudioInfrastructure]);

  useEffect(() => {
    presetRegionsRef.current = { presetIndex: null, regions: [] };
    presetRegionCacheRef.current = new Map();
  }, [sf2, effectivePresetIndex]);

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return target.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    }

    function releaseAllKeys(): void {
      const active = [...activeKeyboardKeysRef.current.values()];
      activeKeyboardKeysRef.current.clear();
      for (const note of active) {
        triggerNoteOff(note);
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const note = QWERTY_NOTE_MAP[key];
      if (note == null) return;
      event.preventDefault();
      if (activeKeyboardKeysRef.current.has(key)) return;
      activeKeyboardKeysRef.current.set(key, note);
      setMidiNote(note);
      triggerNoteOn(note, midiVelocity).catch((err: unknown) => {
        setAudioError(err instanceof Error ? err.message : String(err));
      });
    }

    function onKeyUp(event: KeyboardEvent): void {
      const key = event.key.toLowerCase();
      const note = activeKeyboardKeysRef.current.get(key);
      if (note == null) return;
      event.preventDefault();
      activeKeyboardKeysRef.current.delete(key);
      triggerNoteOff(note);
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseAllKeys);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseAllKeys);
      releaseAllKeys();
    };
  }, [midiVelocity, sf2, effectivePresetIndex]);

  useEffect(() => {
    if (!midiDriverRef.current) return;
    midiDriverRef.current.setSelectedInput(selectedMidiInput);
  }, [selectedMidiInput]);

  useEffect(() => {
    if (didAutoLoadDefault) return;
    setDidAutoLoadDefault(true);
    onSelectSample(DEFAULT_SF2.path, DEFAULT_SF2.label);
  }, [didAutoLoadDefault]);

  useEffect(() => {
    if (!sf2 || didAutoEnableMidi || midiEnabled) return;
    setDidAutoEnableMidi(true);
    startMidiDriver();
  }, [sf2, didAutoEnableMidi, midiEnabled]);

  async function parseFromU8(u8: Uint8Array, name: string): Promise<void> {
    setLoading(true);
    setError("");
    try {
      setLoadingStage(`Parsing SoundFont: ${name}…`);
      const parsed = parseSF2(u8);
      setSf2(parsed);
      setSourceName(name);
      setSelectedPreset(null);
      setSelectedLayer(null);
      setShowSummaryModal(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSf2(null);
    } finally {
      setLoading(false);
    }
  }

  async function onSelectSample(path: string, label: string): Promise<void> {
    setLoading(true);
    setError("");
    setLoadingStage(`Downloading SoundFont: ${label} (31 MB)…`);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(path, { signal: controller.signal });
      if (!res.ok) throw new Error(`Failed to fetch ${label}`);
      const buffer = await res.arrayBuffer();
      await parseFromU8(new Uint8Array(buffer), label);
    } catch (e) {
      setLoading(false);
      setError(controller.signal.aborted
        ? "SoundFont download timed out. Press Play to retry, or upload an SF2 from the menu."
        : `SoundFont loading failed: ${e instanceof Error ? e.message : String(e)}. Press Play to retry.`);
      setSf2(null);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function onUploadFile(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    await parseFromU8(new Uint8Array(buffer), file.name);
  }

  function startAnalyzerLoop(): void {
    if (rafRef.current != null || !analyserRef.current) return;

    const tick = (ts: number): void => {
      const analyser = analyserRef.current;
      const td = timeDomainRef.current;
      const fd = freqDomainRef.current;
      if (analyser && td && fd) {
        analyser.getFloatTimeDomainData(td);
        analyser.getByteFrequencyData(fd);
        if (ts - lastVizUpdateRef.current > 80) {
          const timeSample = Array.from(td.slice(0, 384), (v) => Number(v.toFixed(4)));
          const freqSample = Array.from(fd.slice(0, 128));
          setRecentTimeData(timeSample);
          setRecentFreqData(freqSample);
          lastVizUpdateRef.current = ts;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  const ensureAudioInfrastructure = useCallback(
    async ({ loadWorklet = true }: { loadWorklet?: boolean } = {}): Promise<{
      ctx: AudioContext;
      input: AudioNode;
    }> => {
      setAudioError("");
      let ctx = audioCtxRef.current;
      if (!ctx || ctx.state === "closed") {
        releaseAudioInfrastructure();
        ctx = new AudioContext();
        audioCtxRef.current = ctx;
        setAudioReady(false);
        setDynamicsMeter({ compression: 0, limiting: 0 });
        setAudioCtxState(ctx.state);
        const currentContext = ctx;
        ctx.onstatechange = () => {
          if (audioCtxRef.current !== currentContext) return;
          setAudioCtxState(currentContext.state);
          if (currentContext.state === "closed") setAudioReady(false);
        };
      }

      const currentTime = ctx.currentTime;
      let analyser = analyserRef.current;
      let masterGain = masterGainRef.current;

      if (!analyser) {
        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.82;
        analyserRef.current = analyser;
        timeDomainRef.current = new Float32Array(analyser.fftSize);
        freqDomainRef.current = new Uint8Array(analyser.frequencyBinCount);
      }

      if (!masterGain) {
        masterGain = ctx.createGain();
        masterGain.gain.setValueAtTime(masterVolumeRef.current, currentTime);
        masterGainRef.current = masterGain;
      }

      if (!dynamicsLoadPromiseRef.current) {
        dynamicsLoadPromiseRef.current = ctx.audioWorklet.addModule(masterDynamicsUrl).catch((err) => {
          if (audioCtxRef.current === ctx) dynamicsLoadPromiseRef.current = null;
          throw err;
        });
      }
      await dynamicsLoadPromiseRef.current;
      if (audioCtxRef.current !== ctx || ctx.state === "closed") {
        throw new Error("Audio was reset while loading. Press Play to reconnect.");
      }
      // Check again after awaiting: concurrent callers share exactly one bus.
      if (!compressorRef.current) {
        const compressor = new AudioWorkletNode(ctx, "master-dynamics", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: "explicit",
          processorOptions: { mode: dynamicsModeRef.current },
        });
        compressor.port.onmessage = ({ data }: MessageEvent) => {
          if (data?.type === "meter") setDynamicsMeter({ compression: data.compression, limiting: data.limiting });
        };
        compressorRef.current = compressor;
        // Every synth feeds one stereo bus; the analyzer shows the final output.
        masterGain.connect(compressor);
        compressor.connect(analyser);
        analyser.connect(ctx.destination);
      }

      if (loadWorklet) {
        if (!workletLoadPromiseRef.current) {
          workletLoadPromiseRef.current = ctx.audioWorklet.addModule(sf2ProcessorUrl).catch((err) => {
            if (audioCtxRef.current === ctx) workletLoadPromiseRef.current = null;
            throw err;
          });
        }
        await workletLoadPromiseRef.current;
        if (audioCtxRef.current !== ctx || (ctx.state as AudioContextState) === "closed") {
          throw new Error("Audio was reset while loading. Press Play to reconnect.");
        }
        setAudioReady(true);
      }
      startAnalyzerLoop();
      return { ctx, input: masterGain };
    },
    [releaseAudioInfrastructure]
  );

  const ensureAudioGraph = useCallback(
    async (autoResume = false): Promise<AudioWorkletNode> => {
      const { ctx, input } = await ensureAudioInfrastructure();
      if (autoResume && ctx.state !== "running") {
        await ctx.resume();
      }
      if (ctx.state !== "running") {
        throw new Error("AudioContext is not running. Click Power On in the toolbar.");
      }
      let node = workletNodeRef.current;
      if (!node) {
        node = new AudioWorkletNode(ctx, "sf2-processor", {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        workletNodeRef.current = node;
        node.connect(input);
      }
      return node;
    },
    [ensureAudioInfrastructure]
  );

  const resolvePresetIndex = useCallback(
    (program: number, bank: number): number | null => {
      const exactIndex = presets.findIndex((p) => p.preset === program && p.bank === bank);
      const bankZeroIndex = presets.findIndex((p) => p.preset === program && p.bank === 0);
      const programAnyIndex = presets.findIndex((p) => p.preset === program);
      if (exactIndex >= 0) return exactIndex;
      if (bankZeroIndex >= 0) return bankZeroIndex;
      if (programAnyIndex >= 0) return programAnyIndex;
      return null;
    },
    [presets]
  );

  const getRegionsForPresetIndex = useCallback(
    (presetIndex: number): SF2Region[] => {
      if (!sf2 || presetIndex == null || presetIndex < 0) return [];
      if (presetRegionCacheRef.current.has(presetIndex)) {
        return presetRegionCacheRef.current.get(presetIndex)!;
      }
      const regions = sf2.buildRegionsForPreset(presetIndex, {
        decodeToFloat32: true,
        normalize: true,
        includeStereoLinks: true,
      });
      presetRegionCacheRef.current.set(presetIndex, regions);
      return regions;
    },
    [sf2]
  );

  function getCurrentPresetRegions(presetIndex: number | null = effectivePresetIndex): SF2Region[] {
    if (!sf2 || presetIndex == null) return [];
    if (
      presetRegionsRef.current.presetIndex === presetIndex &&
      presetRegionsRef.current.regions.length
    ) {
      return presetRegionsRef.current.regions;
    }
    const regions = getRegionsForPresetIndex(presetIndex);
    presetRegionsRef.current = { presetIndex, regions };
    return regions;
  }

  async function triggerNoteOn(note: number, velocity: number): Promise<void> {
    const presetIndex = livePresetIndexRef.current;
    if (!sf2 || presetIndex == null) return;
    if (selectedPresetRef.current == null) {
      selectedPresetRef.current = presetIndex;
      setSelectedPreset(presetIndex);
    }
    const node = await ensureAudioGraph(false);
    const regions = getCurrentPresetRegions(presetIndex);
    node.port.postMessage({ type: "setPreset", regions });
    node.port.postMessage({ type: "noteOn", note, velocity });
  }

  async function triggerNoteOff(note: number): Promise<void> {
    const node = workletNodeRef.current;
    if (!node) return;
    node.port.postMessage({ type: "noteOff", note });
  }
  triggerNoteOnRef.current = triggerNoteOn;
  triggerNoteOffRef.current = triggerNoteOff;
  resolvePresetIndexRef.current = resolvePresetIndex;

  const handleMidiNoteOn = useCallback(
    async (note: number, velocity: number, _channel: number, sourceLabel = "MIDI"): Promise<void> => {
      setMidiNote(note);
      setMidiVelocity(velocity);
      setMidiStatus(`${sourceLabel} noteOn ${note} vel ${velocity}`);
      try {
        await triggerNoteOnRef.current?.(note, velocity);
      } catch (err) {
        setAudioError(err instanceof Error ? err.message : String(err));
      }
    },
    []
  );

  const handleMidiNoteOff = useCallback(
    (note: number, _channel: number, sourceLabel = "MIDI"): void => {
      setMidiStatus(`${sourceLabel} noteOff ${note}`);
      triggerNoteOffRef.current?.(note);
    },
    []
  );

  const handleMidiProgramChange = useCallback(
    (program: number, bank: number, channel: number, sourceLabel = "MIDI"): void => {
      const nextIndex = resolvePresetIndexRef.current?.(program, bank);
      if (nextIndex != null && nextIndex >= 0) {
        selectedPresetRef.current = nextIndex;
        livePresetIndexRef.current = nextIndex;
        setSelectedPreset(nextIndex);
        setMidiStatus(
          `${sourceLabel} program ch${channel + 1}: bank ${bank}, program ${program} -> preset #${nextIndex}`
        );
      } else {
        setMidiStatus(
          `${sourceLabel} program ch${channel + 1}: bank ${bank}, program ${program} (not found)`
        );
      }
    },
    []
  );

  useEffect(() => {
    externalMidiMessageHandlerRef.current = createMidiMessageHandler({
      onNoteOn: (note, velocity, channel) => handleMidiNoteOn(note, velocity, channel, "Embedded MIDI"),
      onNoteOff: (note, channel) => handleMidiNoteOff(note, channel, "Embedded MIDI"),
      onProgramChange: (program, bank, channel) =>
        handleMidiProgramChange(program, bank, channel, "Embedded MIDI"),
    });
    return () => {
      externalMidiMessageHandlerRef.current = null;
    };
  }, [handleMidiNoteOff, handleMidiNoteOn, handleMidiProgramChange]);

  useEffect(() => {
    const bridge = createExternalMidiBridge({
      windowLike: window,
      onMidiData: (data) => externalMidiMessageHandlerRef.current?.handleMidiMessage(data) ?? false,
      onMidiInfo: (info) => {
        if (info?.infoType === "tempo" && Number.isFinite(info.bpm as number)) {
          setMidiStatus(`Embedded MIDI tempo ${info.bpm} BPM`);
        }
      },
      onStatusChange: setMidiStatus,
    });
    externalMidiBridgeRef.current = bridge;
    bridge.start();
    return () => {
      bridge.dispose();
      externalMidiBridgeRef.current = null;
    };
  }, []);

  async function onPlaySample(): Promise<void> {
    if (!sf2 || effectivePresetIndex == null) return;
    try {
      await ensureAudioGraph(true);
      await triggerNoteOn(midiNote, midiVelocity);
      if (noteOffTimerRef.current) clearTimeout(noteOffTimerRef.current);
      noteOffTimerRef.current = setTimeout(() => {
        triggerNoteOff(midiNote);
      }, 900);
    } catch (err) {
      setAudioError(err instanceof Error ? err.message : String(err));
    }
  }

  async function playRawSample(sampleID: number): Promise<void> {
    if (!sf2) return;
    try {
      const { ctx } = await ensureAudioInfrastructure({ loadWorklet: false });
      if (ctx.state !== "running") await ctx.resume();
      const sh = sf2.pdta.shdr[sampleID] as
        | { start: number; end: number; sampleRate: number }
        | undefined;
      if (!sh || !sf2.sdta.smpl) return;
      const smpl = sf2.sdta.smpl;
      const start = sh.start;
      const end = sh.end > sh.start ? sh.end : smpl.length;
      const frameCount = end - start;
      if (frameCount <= 0) return;
      const audioBuffer = ctx.createBuffer(1, frameCount, sh.sampleRate);
      const channelData = audioBuffer.getChannelData(0);
      const slice = smpl.subarray(start, end);
      for (let i = 0; i < frameCount; i++) {
        channelData[i] = slice[i] / 32768;
      }
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.start();
    } catch (err) {
      setAudioError(err instanceof Error ? err.message : String(err));
    }
  }

  // Winamp volume knob: drives the app-owned master gain node only.
  // The SF2 synth, worker scheduling, and offline render paths are untouched.
  const applyMasterVolume = useCallback((value: number): void => {
    const next = Math.max(0, Math.min(1, value));
    masterVolumeRef.current = next;
    setMasterVolume(next);
    const ctx = audioCtxRef.current;
    const gain = masterGainRef.current;
    if (ctx && gain && ctx.state !== "closed") {
      gain.gain.setTargetAtTime(next, ctx.currentTime, 0.02);
    }
  }, []);

  async function onTogglePower(): Promise<void> {
    try {
      // A newly created context can start running during a user gesture. Decide
      // the requested action before creating/loading the audio graph.
      const targetState = audioCtxRef.current?.state === "running" ? "suspended" : "running";
      const { ctx } = await ensureAudioInfrastructure({ loadWorklet: false });
      if (targetState === "running") await ctx.resume();
      else await ctx.suspend();

      // Wait briefly for the context state transition to settle before reflecting it in UI.
      if (ctx.state !== targetState) {
        await new Promise<void>((resolve) => {
          const start = performance.now();
          const poll = () => {
            if (ctx.state === targetState || performance.now() - start > 700) {
              resolve();
              return;
            }
            setTimeout(poll, 16);
          };
          poll();
        });
      }
      if (targetState === "running" && ctx.state !== "running") {
        throw new Error(`AudioContext resume did not complete (current state: ${ctx.state})`);
      }
      setAudioCtxState(ctx.state);
    } catch (err) {
      setAudioError(err instanceof Error ? err.message : String(err));
    }
  }

  async function startMidiDriver(): Promise<void> {
    if (midiDriverRef.current) return;
    if (midiEnabled) {
      return;
    }
    try {
      const driver = await createMidiDriver({
        selectedInputId: selectedMidiInput,
        onNoteOn: (note, velocity, channel) => handleMidiNoteOn(note, velocity, channel, "MIDI"),
        onNoteOff: (note, channel) => handleMidiNoteOff(note, channel, "MIDI"),
        onProgramChange: (program, bank, channel) =>
          handleMidiProgramChange(program, bank, channel, "MIDI"),
        onStateChange: ({ connected, names, inputs }) => {
          setMidiInputs(inputs ?? []);
          if (connected === 0) {
            setMidiStatus("MIDI enabled (no inputs)");
            return;
          }
          setMidiStatus(`MIDI inputs: ${names.join(", ")}`);
        },
      });
      midiDriverRef.current = driver;
      setMidiEnabled(true);
      setMidiStatus("MIDI enabled");
    } catch (err) {
      if (isMidiPermissionDeniedError(err)) {
        setMidiEnabled(false);
        setMidiInputs([]);
        setMidiStatus("MIDI disabled");
        return;
      }
      setMidiEnabled(false);
      setMidiStatus("MIDI failed");
    }
  }

  async function onToggleMidi(): Promise<void> {
    if (midiEnabled) {
      midiDriverRef.current?.disconnect();
      midiDriverRef.current = null;
      setMidiEnabled(false);
      setMidiStatus("MIDI disabled");
      setMidiInputs([]);
      return;
    }
    await startMidiDriver();
  }

  function onHeaderSortClick(key: string): void {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDirection("asc");
  }

  return (
    <ErrorBoundary>
    <div className="app">
      {loading && <p className="status" role="status">{loadingStage}</p>}
      {error && <p className="status error">{error}</p>}

      {/* The Winamp player stays mounted on every tab so switching to the SF2
          explorer or recorder never destroys playback or the transport. The
          MIDI explorer panels below the chrome render only on the midi tab. */}
      <MidiReader
          vizTimeData={recentTimeData}
          masterVolume={masterVolume}
          onMasterVolumeChange={applyMasterVolume}
          sf2Ready={!!sf2}
          sf2Name={sourceName}
          sf2Loading={loading}
          sf2Error={error}
          onUploadSf2={onUploadFile}
          onLoadDefaultSf2={() => onSelectSample(DEFAULT_SF2.path, DEFAULT_SF2.label)}
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          audioCtxState={audioCtxState}
          onTogglePower={onTogglePower}
          midiEnabled={midiEnabled}
          onToggleMidi={onToggleMidi}
          selectedMidiInput={selectedMidiInput}
          onSelectMidiInput={setSelectedMidiInput}
          midiInputs={midiInputs}
          ensureAudioInfrastructure={ensureAudioInfrastructure}
          dynamicsMode={dynamicsMode}
          getRegionsForPreset={getRegionsForPresetIndex}
          resolvePresetIndex={resolvePresetIndex}
          fallbackPresetIndex={effectivePresetIndex ?? 0}
          presetOptions={presets.map((p, idx) => ({
            index: idx,
            bank: p.bank,
            program: p.preset,
            name: p.presetName || "(unnamed)",
          }))}
          onError={(msg: string) => setAudioError(msg)}
          onDynamicsModeChange={setDynamicsMode}
          dynamicsCompression={dynamicsMeter.compression}
          dynamicsLimiting={dynamicsMeter.limiting}
          sf2View={
            activeTab === "sf2" ? (
              <>
                {sf2 && showSummaryModal && (
                            <div className="modalBackdrop" onClick={() => setShowSummaryModal(false)}>
                              <section className="card summaryModal" onClick={(e) => e.stopPropagation()}>
                                <h2>File Summary</h2>
                                <p>
                                  <strong>Source:</strong> {sourceName}
                                </p>
                                <p>
                                  <strong>Presets:</strong> {presets.length}
                                </p>
                                <p>
                                  <strong>Instruments:</strong> {sf2.pdta.inst.length - 1}
                                </p>
                                <p>
                                  <strong>Samples:</strong> {sf2.pdta.shdr.length - 1}
                                </p>
                                <h3>INFO</h3>
                                <ul className="infoList">
                                  {Object.entries(sf2.info).map(([k, v]) => {
                                    const raw = v || "(empty)";
                                    const rendered =
                                      k === "ICMT" ? String(raw).replace(/<br\s*\/?>/gi, "\n") : raw;
                                    return (
                                      <li key={k}>
                                        <code>{k}</code>:{" "}
                                        <span className={k === "ICMT" ? "infoValueMultiline" : undefined}>
                                          {rendered}
                                        </span>
                                      </li>
                                    );
                                  })}
                                </ul>
                                <button type="button" onClick={() => setShowSummaryModal(false)}>
                                  Close
                                </button>
                              </section>
                            </div>
                          )}

                          {sf2 && (
                            <main className="layout sf2Layout">
                              <section className="card sf2Panel presetsPanel">
                                <div className="panelHead">
                                  <h2>Presets</h2>
                                  <span className="panelBadge">{visiblePresets.length}</span>
                                  <button
                                    type="button"
                                    className="toolbarActionBtn"
                                    onClick={() => setShowSummaryModal((v) => !v)}
                                    disabled={!sf2}
                                    aria-label={showSummaryModal ? "Hide File Summary" : "Show File Summary"}
                                    title={showSummaryModal ? "Hide File Summary" : "Show File Summary"}
                                  >
                                    <i className="fa-solid fa-circle-info" aria-hidden="true" />
                                    <span>{showSummaryModal ? "Hide Summary" : "File Summary"}</span>
                                  </button>
                                </div>
                                <div className="panelBody">
                                  <div className="presetFilters">
                                    <input
                                      type="search"
                                      placeholder="Search name/bank/program"
                                      value={presetSearch}
                                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                        setPresetSearch(e.target.value)
                                      }
                                    />
                                  </div>
                                  <div className="scroll tableScroll">
                                    <table className="sf2Table">
                                      <thead>
                                        <tr>
                                          <th>#</th>
                                          <th>Name</th>
                                          <th>
                                            <button
                                              type="button"
                                              className="thSort"
                                              onClick={() => onHeaderSortClick("bank")}
                                            >
                                              Bank {sortKey === "bank" ? (sortDirection === "asc" ? "↑" : "↓") : ""}
                                            </button>
                                          </th>
                                          <th>
                                            <button
                                              type="button"
                                              className="thSort"
                                              onClick={() => onHeaderSortClick("program")}
                                            >
                                              Program{" "}
                                              {sortKey === "program" ? (sortDirection === "asc" ? "↑" : "↓") : ""}
                                            </button>
                                          </th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {visiblePresets.map((preset) => (
                                          <tr
                                            key={`${preset.bank}:${preset.preset}:${preset._index}`}
                                            className={selectedPreset === preset._index ? "selected" : ""}
                                            onClick={() => {
                                              setSelectedPreset(preset._index);
                                            }}
                                          >
                                            <td>{preset._index}</td>
                                            <td>{preset.presetName || "(unnamed)"}</td>
                                            <td>{preset.bank}</td>
                                            <td>{preset.preset}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              </section>

                              <section className="card centerPanel sf2Panel detailsPanel">
                                <div className="panelHead">
                                  <h2>Program Details</h2>
                                  <span className="panelBadge">
                                    {selectedPreset == null ? "None" : `Preset #${selectedPreset}`}
                                  </span>
                                </div>
                                <div className="centerPanelScroll">
                                  {selectedPreset == null || !programDetails ? (
                                    <p>Click a program row to inspect its header, zones, and sample preview.</p>
                                  ) : (
                                    <div className="programDetails">
                                      <div className="detailBlock">
                                        <h3>MIDI Select</h3>
                                        <div className="sliderBlock">
                                          <label>
                                            MIDI note: <strong>{midiNote}</strong>
                                          </label>
                                          <input
                                            type="range"
                                            min="0"
                                            max="127"
                                            value={midiNote}
                                            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                              setMidiNote(Number(e.target.value))
                                            }
                                          />
                                        </div>
                                        <div className="sliderBlock">
                                          <label>
                                            Velocity: <strong>{midiVelocity}</strong>
                                          </label>
                                          <input
                                            type="range"
                                            min="1"
                                            max="127"
                                            value={midiVelocity}
                                            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                              setMidiVelocity(Number(e.target.value))
                                            }
                                          />
                                        </div>
                                      </div>
                                      <div className="detailBlock">
                                        <h3>Program Header Info</h3>
                                        <p>
                                          <strong>Name:</strong> {programDetails.header.presetName || "(unnamed)"}
                                        </p>
                                        <p>
                                          <strong>Bank:</strong> {programDetails.header.bank}
                                        </p>
                                        <p>
                                          <strong>Program:</strong> {programDetails.header.preset}
                                        </p>
                                        <p>
                                          <strong>presetBagNdx:</strong> {programDetails.header.presetBagNdx}
                                        </p>
                                        <p>
                                          <strong>library/genre/morphology:</strong>{" "}
                                          {programDetails.header.library}/{programDetails.header.genre}/
                                          {programDetails.header.morphology}
                                        </p>
                                      </div>

                                      <div className="detailBlock">
                                        <h3>Global Zone</h3>
                                        {programDetails.presetGlobal ? (
                                          <ul className="monoList">
                                            <li>
                                              <button
                                                type="button"
                                                className={`layerButton ${
                                                  selectedLayer?.type === "presetGlobal" ? "selected" : ""
                                                }`}
                                                onClick={() =>
                                                  setSelectedLayer({
                                                    type: "presetGlobal",
                                                    title: `Preset global ${programDetails.presetGlobal!.bagIndex}`,
                                                    context: "global zone",
                                                    levels: [
                                                      {
                                                        label: `Preset global bag ${programDetails.presetGlobal!.bagIndex}`,
                                                        gens: programDetails.presetGlobal!.gens,
                                                        mods: programDetails.presetGlobal!.mods,
                                                      },
                                                    ],
                                                    bagIndex: programDetails.presetGlobal!.bagIndex,
                                                  })
                                                }
                                              >
                                                bag {programDetails.presetGlobal.bagIndex}:{" "}
                                                {programDetails.presetGlobal.gens.length} generators /{" "}
                                                {programDetails.presetGlobal.mods.length} modulators
                                              </button>
                                            </li>
                                          </ul>
                                        ) : (
                                          <p>None</p>
                                        )}
                                      </div>

                                      <div className="detailBlock">
                                        <h3>Region Layer</h3>
                                        {programDetails.regionZones.length === 0 ? (
                                          <p>No preset regions</p>
                                        ) : (
                                          <ul className="monoList">
                                            {programDetails.regionZones.map((zone) => {
                                              const instIndex = getLastGeneratorAmount(zone.gens, 41);
                                              const { keyLo, keyHi, velLo, velHi } = zoneKeyVel(zone);
                                              const isSelected =
                                                selectedLayer?.type === "region" &&
                                                selectedLayer?.bagIndex === zone.bagIndex;
                                              return (
                                                <li key={`rz-${zone.bagIndex}`}>
                                                  <button
                                                    type="button"
                                                    className={`layerButton ${isSelected ? "selected" : ""}`}
                                                    onClick={() =>
                                                      setSelectedLayer(
                                                        buildSelectionFromRegion(
                                                          programDetails,
                                                          zone,
                                                          midiNote,
                                                          midiVelocity
                                                        )
                                                      )
                                                    }
                                                  >
                                                    bag {zone.bagIndex}: instrument {instIndex}, key {keyLo}-{keyHi},
                                                    vel {velLo}-{velHi}
                                                  </button>
                                                </li>
                                              );
                                            })}
                                          </ul>
                                        )}
                                      </div>

                                      <div className="detailBlock">
                                        <h3>Instrument Layer</h3>
                                        {programDetails.instruments.length === 0 ? (
                                          <p>No instruments referenced</p>
                                        ) : (
                                          <div className="instrumentBlocks">
                                            {programDetails.instruments.map((inst) => (
                                              <div key={`inst-${inst.index}`} className="instBlock">
                                                <p>
                                                  <strong>{inst.index}</strong> {inst.name || "(unnamed)"}
                                                </p>
                                                {inst.globalZone ? (
                                                  <p>
                                                    <strong>Global:</strong>{" "}
                                                    <button
                                                      type="button"
                                                      className={`layerButton ${
                                                        selectedLayer?.type === "instrumentGlobal" &&
                                                        selectedLayer?.bagIndex === inst.globalZone.bagIndex
                                                          ? "selected"
                                                          : ""
                                                      }`}
                                                      onClick={() =>
                                                        setSelectedLayer(
                                                          buildSelectionFromInstrumentGlobal(
                                                            programDetails,
                                                            inst,
                                                            midiNote,
                                                            midiVelocity
                                                          )
                                                        )
                                                      }
                                                    >
                                                      {inst.globalZone.gens.length} generators /{" "}
                                                      {inst.globalZone.mods.length} modulators
                                                    </button>
                                                  </p>
                                                ) : (
                                                  <p>
                                                    <strong>Global:</strong> None
                                                  </p>
                                                )}
                                                <ul className="monoList">
                                                  {inst.sampleZones.map((zone) => (
                                                    <li
                                                      key={`iz-${inst.index}-${zone.bagIndex}`}
                                                      className="sampleZoneRow"
                                                    >
                                                      <button
                                                        type="button"
                                                        className={`layerButton ${
                                                          selectedLayer?.type === "instrumentRegion" &&
                                                          selectedLayer?.bagIndex === zone.bagIndex
                                                            ? "selected"
                                                            : ""
                                                        }`}
                                                        onClick={() =>
                                                          setSelectedLayer(
                                                            buildSelectionFromInstrumentRegion(
                                                              programDetails,
                                                              inst,
                                                              zone,
                                                              midiNote,
                                                              midiVelocity
                                                            )
                                                          )
                                                        }
                                                      >
                                                        bag {zone.bagIndex}: sample {zone.sampleID} ({zone.sampleName}
                                                        ) @ {zone.sampleRate}Hz
                                                      </button>
                                                      <button
                                                        type="button"
                                                        className="samplePlayButton"
                                                        title={`Play sample ${zone.sampleID} (${zone.sampleName}) raw`}
                                                        onClick={() => playRawSample(zone.sampleID)}
                                                      >
                                                        ▶
                                                      </button>
                                                    </li>
                                                  ))}
                                                </ul>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </section>

                              <div className="rightStack">
                                <section className="card sf2Panel samplePanel">
                                  <div className="panelHead">
                                    <h2>PCM Sample Preview</h2>
                                    <span className="panelBadge">Audio</span>
                                  </div>
                                  <div className="panelBody">
                                    <div className="playControls">
                                      <button
                                        type="button"
                                        onClick={onPlaySample}
                                        disabled={selectedPreset == null || !sf2}
                                      >
                                        Play Sample
                                      </button>
                                      <span className="audioState">
                                        {audioReady ? "Audio ready" : "Audio not initialized"}
                                      </span>
                                    </div>
                                    {audioError ? <p className="status error">{audioError}</p> : null}
                                    {selectedPreset == null || !programDetails?.previewRegion ? (
                                      <p>Waveform appears when the selected program has playable regions.</p>
                                    ) : (
                                      <>
                                        <WaveformCanvas data={programDetails.previewRegion.sample.dataL} />
                                        <p>
                                          <strong>Frames:</strong>{" "}
                                          {programDetails.previewRegion.sample.dataL.length}{" "}
                                          <strong>Sample Rate:</strong>{" "}
                                          {programDetails.previewRegion.sample.sampleRate}
                                        </p>
                                      </>
                                    )}
                                  </div>
                                </section>
                                <section className="card sf2Panel levelPanel">
                                  <div className="panelHead">
                                    <h2>Level Details</h2>
                                  </div>
                                  {selectedPreset == null || !programDetails ? (
                                    <p>Select a program to inspect layer generators and modulators.</p>
                                  ) : !selectedLayer ? (
                                    <p>
                                      No matching layer for note {midiNote} velocity {midiVelocity}. Click a region
                                      or instrument layer to inspect it directly.
                                    </p>
                                  ) : (
                                    <div className="scroll">
                                      <p>
                                        <strong>{selectedLayer.title}</strong> ({selectedLayer.context})
                                      </p>
                                      {(selectedLayer.levels ?? []).map((level, idx) => (
                                        <div
                                          key={`${selectedLayer.type}-${selectedLayer.bagIndex}-level-${idx}`}
                                          className="levelBlock"
                                        >
                                          <p>
                                            <strong>{level.label}</strong>
                                          </p>
                                          {(() => {
                                            const r = rangeFromGenerators(level.gens);
                                            return (
                                              <p className="levelRangeCompact">
                                                MIDI {r.keyLo}-{r.keyHi} | Vel {r.velLo}-{r.velHi}
                                              </p>
                                            );
                                          })()}
                                          <table>
                                            <thead>
                                              <tr>
                                                <th>Kind</th>
                                                <th>Operator/Route</th>
                                                <th>Value</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {(level.gens ?? []).map((g, gIdx) => (
                                                <tr key={`g-${idx}-${gIdx}`}>
                                                  <td>generator</td>
                                                  <td>{GEN_OPER_NAMES[g.oper] ?? `op${g.oper}`}</td>
                                                  <td>{formatGeneratorValue(g)}</td>
                                                </tr>
                                              ))}
                                              {(level.mods ?? []).map((m, mIdx) => (
                                                <tr key={`m-${idx}-${mIdx}`}>
                                                  <td>modulator</td>
                                                  <td>
                                                    src {m.srcOper} → {formatModTarget(m)}
                                                  </td>
                                                  <td>
                                                    amount {m.amount}, amtSrc {m.amtSrcOper}, trans {m.transOper}
                                                  </td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </section>
                              </div>
                            </main>
                          )}
              </>
            ) : null
          }
          recorderView={activeTab === "recorder" ? <MidiRecorderUI /> : null}
          midiStatus={midiStatus}
        />



      {/* Hidden analyzer probe: keeps the analyser node connected so the
          folded Winamp waveform (and any signal diagnostics) keep receiving
          live time-domain data. */}
      <div style={{ display: "none" }} aria-hidden="true">
        <AnalyzerCanvas data={recentTimeData} mode="time" testId="analyzer-time" />
      </div>
    </div>
    </ErrorBoundary>
  );
}
