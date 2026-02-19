import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseSF2 } from "./sf2-parser.js";
import { createMidiDriver } from "./midi-driver.js";
import MidiReader from "./midireader.jsx";
import { fetchWasmBinary } from "./dsp-wasm-wrapper.js";

const INT16_MAX_VALUE = 32768;

const QWERTY_NOTE_MAP = {
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

function getPresetRows(sf2) {
  return sf2?.pdta?.phdr?.slice(0, -1) ?? [];
}

const GEN_OPER_NAMES = {
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

function readZones(bags, gens, mods, start, end) {
  const out = [];
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

function unpackRange(amount) {
  const u = amount & 0xffff;
  return [u & 0xff, (u >> 8) & 0xff];
}

function getLastGeneratorAmount(gens, oper) {
  for (let i = gens.length - 1; i >= 0; i -= 1) {
    if (gens[i].oper === oper) return gens[i].amount;
  }
  return null;
}

function formatGenerator(g) {
  if (g.oper === 43 || g.oper === 44) {
    const [lo, hi] = unpackRange(g.amount);
    return `${GEN_OPER_NAMES[g.oper] ?? `op${g.oper}`}: ${lo}-${hi}`;
  }
  return `${GEN_OPER_NAMES[g.oper] ?? `op${g.oper}`}: ${g.amount}`;
}

function formatGeneratorValue(g) {
  if (g.oper === 43 || g.oper === 44) {
    const [lo, hi] = unpackRange(g.amount);
    return `${lo}-${hi}`;
  }
  return `${g.amount}`;
}

function formatModTarget(mod) {
  return GEN_OPER_NAMES[mod.destOper] ?? `op${mod.destOper}`;
}

function zoneKeyVel(zone) {
  const keyRange = getLastGeneratorAmount(zone.gens, 43);
  const velRange = getLastGeneratorAmount(zone.gens, 44);
  const [keyLo, keyHi] = keyRange != null ? unpackRange(keyRange) : [0, 127];
  const [velLo, velHi] = velRange != null ? unpackRange(velRange) : [0, 127];
  return { keyLo, keyHi, velLo, velHi };
}

function zoneMatches(zone, note, velocity) {
  const { keyLo, keyHi, velLo, velHi } = zoneKeyVel(zone);
  return note >= keyLo && note <= keyHi && velocity >= velLo && velocity <= velHi;
}

function rangeFromGenerators(gens) {
  const keyRange = getLastGeneratorAmount(gens ?? [], 43);
  const velRange = getLastGeneratorAmount(gens ?? [], 44);
  const [keyLo, keyHi] = keyRange != null ? unpackRange(keyRange) : [0, 127];
  const [velLo, velHi] = velRange != null ? unpackRange(velRange) : [0, 127];
  return { keyLo, keyHi, velLo, velHi };
}

function selectLayerFromMidi(programDetails, note, velocity) {
  if (!programDetails) return null;
  const matchedRegion = programDetails.regionZones.find((zone) => zoneMatches(zone, note, velocity));
  if (!matchedRegion) return null;
  const instIndex = getLastGeneratorAmount(matchedRegion.gens, 41);
  const inst = programDetails.instruments.find((item) => item.index === instIndex);
  const matchedInstZone =
    inst?.sampleZones.find((zone) => zoneMatches(zone, note, velocity)) ?? inst?.sampleZones[0];
  const levels = [];
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
      label: `Instrument ${inst.index} region bag ${matchedInstZone.bagIndex}`,
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

function buildSelectionFromRegion(programDetails, regionZone, midiNote, midiVelocity) {
  const instIndex = getLastGeneratorAmount(regionZone.gens, 41);
  const inst = programDetails.instruments.find((item) => item.index === instIndex);
  const matchedInstZone =
    inst?.sampleZones.find((zone) => zoneMatches(zone, midiNote, midiVelocity)) ??
    inst?.sampleZones[0];
  const levels = [];
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
      label: `Instrument ${inst.index} region bag ${matchedInstZone.bagIndex}`,
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

function buildSelectionFromInstrumentGlobal(programDetails, inst, midiNote, midiVelocity) {
  const candidateRegion = programDetails.regionZones.find(
    (zone) =>
      getLastGeneratorAmount(zone.gens, 41) === inst.index && zoneMatches(zone, midiNote, midiVelocity)
  );
  const candidateInstRegion =
    inst.sampleZones.find((zone) => zoneMatches(zone, midiNote, midiVelocity)) ?? inst.sampleZones[0];
  const levels = [];
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

function buildSelectionFromInstrumentRegion(programDetails, inst, zone, midiNote, midiVelocity) {
  const candidateRegion = programDetails.regionZones.find(
    (r) => getLastGeneratorAmount(r.gens, 41) === inst.index && zoneMatches(r, midiNote, midiVelocity)
  );
  const levels = [];
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
    sampleID: zone.sampleID,
    sampleName: zone.sampleName,
    sampleRate: zone.sampleRate,
  };
}

function extractProgramDetails(sf2, presetIndex) {
  if (!sf2 || presetIndex == null) return null;
  const pdta = sf2.pdta;
  const header = pdta.phdr[presetIndex];
  const next = pdta.phdr[presetIndex + 1];
  if (!header || !next) return null;

  const presetZones = readZones(
    pdta.pbag,
    pdta.pgen,
    pdta.pmod,
    header.presetBagNdx,
    next.presetBagNdx
  );
  const presetGlobal =
    presetZones.length > 0 && getLastGeneratorAmount(presetZones[0].gens, 41) == null
      ? presetZones[0]
      : null;
  const regionZones = presetZones.filter((z) => getLastGeneratorAmount(z.gens, 41) != null);

  const instrumentIndexes = [
    ...new Set(
      regionZones
        .map((z) => getLastGeneratorAmount(z.gens, 41))
        .filter((idx) => idx != null && idx >= 0 && idx < pdta.inst.length - 1)
    ),
  ];

  const instruments = instrumentIndexes.map((instIndex) => {
    const inst = pdta.inst[instIndex];
    const instNext = pdta.inst[instIndex + 1];
    const zones = readZones(pdta.ibag, pdta.igen, pdta.imod, inst.instBagNdx, instNext.instBagNdx);
    const globalZone =
      zones.length > 0 && getLastGeneratorAmount(zones[0].gens, 53) == null ? zones[0] : null;
    const sampleZones = zones
      .filter((z) => getLastGeneratorAmount(z.gens, 53) != null)
      .map((z) => {
        const sampleID = getLastGeneratorAmount(z.gens, 53);
        const sh = pdta.shdr[sampleID];
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

function WaveformCanvas({ data }) {
  const canvasRef = useRef(null);

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

function AnalyzerCanvas({ data, mode }) {
  const canvasRef = useRef(null);

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

  return <canvas ref={canvasRef} width={460} height={90} className="analyzerCanvas" />;
}

export default function App() {
  const [sf2, setSf2] = useState(null);
  const [sourceName, setSourceName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState(null);
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [presetSearch, setPresetSearch] = useState("");
  const [sortKey, setSortKey] = useState("bank");
  const [sortDirection, setSortDirection] = useState("asc");
  const [midiNote, setMidiNote] = useState(60);
  const [midiVelocity, setMidiVelocity] = useState(100);
  const [selectedLayer, setSelectedLayer] = useState(null);
  const [audioReady, setAudioReady] = useState(false);
  const [audioError, setAudioError] = useState("");
  const [recentTimeData, setRecentTimeData] = useState([]);
  const [recentFreqData, setRecentFreqData] = useState([]);
  const [midiEnabled, setMidiEnabled] = useState(false);
  const [midiStatus, setMidiStatus] = useState("MIDI disabled");
  const [midiError, setMidiError] = useState("");
  const [midiInputs, setMidiInputs] = useState([]);
  const [selectedMidiInput, setSelectedMidiInput] = useState("all");
  const [activeTab, setActiveTab] = useState("midi");
  const [audioCtxState, setAudioCtxState] = useState("off");
  const [analyzerCollapsed, setAnalyzerCollapsed] = useState(false);
  const [sf2Options, setSf2Options] = useState([]);
  const [selectedSf2Path, setSelectedSf2Path] = useState("");
  const [didAutoEnableMidi, setDidAutoEnableMidi] = useState(false);
  const [webMidiSupported, setWebMidiSupported] = useState(true);

  const audioCtxRef = useRef(null);
  const workletNodeRef = useRef(null);
  const analyserRef = useRef(null);
  const masterGainRef = useRef(null);
  const compressorRef = useRef(null);
  const timeDomainRef = useRef(null);
  const freqDomainRef = useRef(null);
  const rafRef = useRef(null);
  const lastVizUpdateRef = useRef(0);
  const noteOffTimerRef = useRef(null);
  const midiDriverRef = useRef(null);
  const presetRegionsRef = useRef({ presetIndex: null, regions: [] });
  const presetRegionCacheRef = useRef(new Map());
  const activeKeyboardKeysRef = useRef(new Map());
  const workletLoadPromiseRef = useRef(null);
  const wasmDataRef = useRef(null);

  const presets = useMemo(() => getPresetRows(sf2), [sf2]);
  const visiblePresets = useMemo(() => {
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
  const programDetails = useMemo(
    () => extractProgramDetails(sf2, selectedPreset),
    [sf2, selectedPreset]
  );
  const effectivePresetIndex = useMemo(() => {
    if (!sf2) return null;
    if (selectedPreset != null) return selectedPreset;
    return presets.length > 0 ? 0 : null;
  }, [sf2, selectedPreset, presets.length]);

  const selectedSamplePreview = useMemo(() => {
    if (!sf2 || !selectedLayer) return null;
    
    // Only extract sample for instrumentRegion type layers
    if (selectedLayer.type !== "instrumentRegion") return null;
    if (selectedLayer.sampleID == null) return null;
    
    const { pdta, sdta } = sf2;
    const sampleID = selectedLayer.sampleID;
    const sh = pdta.shdr[sampleID];
    
    if (!sh || !sdta.smpl) return null;
    
    // Extract sample data using similar approach to decodeSampleData
    const start = sh.start;
    const end = sh.end;
    
    if (end <= start || end > sdta.smpl.length) return null;
    
    // Convert Int16 to Float32
    const n = end - start;
    const dataL = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      dataL[i] = sdta.smpl[start + i] / INT16_MAX_VALUE;
    }
    
    return {
      sample: {
        dataL,
        dataR: null,
        sampleRate: sh.sampleRate,
      },
      sampleID: selectedLayer.sampleID,
      sampleName: selectedLayer.sampleName,
    };
  }, [sf2, selectedLayer]);

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
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => { });
      }
      if (midiDriverRef.current) {
        midiDriverRef.current.disconnect();
      }
    };
  }, []);

  useEffect(() => {
    // Check if Web MIDI API is supported
    setWebMidiSupported(!!navigator.requestMIDIAccess);
  }, []);

  useEffect(() => {
    presetRegionsRef.current = { presetIndex: null, regions: [] };
    presetRegionCacheRef.current = new Map();
  }, [sf2, effectivePresetIndex]);

  useEffect(() => {
    function isTypingTarget(target) {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return target.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    }

    function releaseAllKeys() {
      const active = [...activeKeyboardKeysRef.current.values()];
      activeKeyboardKeysRef.current.clear();
      for (const note of active) {
        triggerNoteOff(note);
      }
    }

    function onKeyDown(event) {
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const note = QWERTY_NOTE_MAP[key];
      if (note == null) return;
      event.preventDefault();
      if (activeKeyboardKeysRef.current.has(key)) return;
      activeKeyboardKeysRef.current.set(key, note);
      setMidiNote(note);
      triggerNoteOn(note, midiVelocity).catch((err) => {
        setAudioError(err instanceof Error ? err.message : String(err));
      });
    }

    function onKeyUp(event) {
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
    (async () => {
      try {
        const manifestUrl = `${import.meta.env.BASE_URL}static/sf2-manifest.json`;
        const res = await fetch(manifestUrl);
        if (!res.ok) throw new Error(`Failed to fetch ${manifestUrl}`);
        const list = await res.json();
        const normalized = Array.isArray(list)
          ? list.filter((item) => item?.path && item?.name)
          : [];
        setSf2Options(normalized);

        const preferred = normalized.find((item) => item.name === "GeneralUser-GS.sf2");
        const first = preferred ?? normalized[0];
        if (first) {
          setSelectedSf2Path(first.path);
          await onSelectSample(first.path, first.name);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  useEffect(() => {
    if (!sf2 || didAutoEnableMidi || midiEnabled) return;
    setDidAutoEnableMidi(true);
    startMidiDriver();
  }, [sf2, didAutoEnableMidi, midiEnabled]);

  async function parseFromU8(u8, name) {
    setLoading(true);
    setError("");
    try {
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

  async function onSelectSample(path, label) {
    setLoading(true);
    setError("");
    try {
      const resolvedPath = /^https?:\/\//i.test(path) ? path : `${import.meta.env.BASE_URL}${path}`;
      const res = await fetch(resolvedPath);
      if (!res.ok) throw new Error(`Failed to fetch ${label}`);
      const buffer = await res.arrayBuffer();
      await parseFromU8(new Uint8Array(buffer), label);
    } catch (e) {
      setLoading(false);
      setError(e instanceof Error ? e.message : String(e));
      setSf2(null);
    }
  }

  async function onUploadFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    await parseFromU8(new Uint8Array(buffer), file.name);
  }

  function startAnalyzerLoop() {
    if (rafRef.current != null || !analyserRef.current) return;

    const tick = (ts) => {
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

  const ensureAudioInfrastructure = useCallback(async ({ loadWorklet = true } = {}) => {
    setAudioError("");
    let ctx = audioCtxRef.current;
    if (!ctx) {
      ctx = new AudioContext();
      audioCtxRef.current = ctx;
      setAudioCtxState(ctx.state);
      ctx.onstatechange = () => setAudioCtxState(ctx.state);
    }

    const currentTime = ctx.currentTime;
    let analyser = analyserRef.current;
    let masterGain = masterGainRef.current;
    let compressor = compressorRef.current;

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
      masterGain.gain.setValueAtTime(1.0, currentTime);
      masterGainRef.current = masterGain;
    }

    if (!compressor) {
      compressor = ctx.createDynamicsCompressor();
      // The point at which compression begins (in dB)
      compressor.threshold.setValueAtTime(-24, currentTime);
      // A range above the threshold where the curve smoothly transitions to the ratio (in dB)
      compressor.knee.setValueAtTime(30, currentTime);
      // The amount of change in dB input vs output (ratio)
      compressor.ratio.setValueAtTime(2, currentTime);
      // How quickly the compressor reduces the volume (in seconds)
      compressor.attack.setValueAtTime(0.01, currentTime);
      // How quickly the volume returns to normal (in seconds)
      compressor.release.setValueAtTime(0.25, currentTime);
      compressorRef.current = compressor;
      // Connect the audio graph: analyser -> masterGain -> compressor -> destination
      analyser.connect(masterGain);
      masterGain.connect(compressor);
      compressor.connect(ctx.destination);
    }

    if (loadWorklet) {
      if (!workletLoadPromiseRef.current) {
        // Fetch WASM binary in main thread to pass to AudioWorklet
        try {
          const wasmData = await fetchWasmBinary();
          wasmDataRef.current = wasmData;
          console.log('WASM binary fetched in main thread for AudioWorklet');
        } catch (error) {
          console.error('Failed to fetch WASM binary:', error);
          throw error;
        }
        
        const moduleUrl = new URL("./sf2-processor.js", import.meta.url);
        workletLoadPromiseRef.current = ctx.audioWorklet.addModule(moduleUrl);
      }
      await workletLoadPromiseRef.current;
      setAudioReady(true);
    }
    startAnalyzerLoop();
    return {
      ctx,
      analyser,
      processorOptions: {
        wasmBinary: wasmDataRef.current?.wasmBinary,
        glueCode: wasmDataRef.current?.glueCode,
        basePath: wasmDataRef.current?.basePath,
      },
    };
  }, []);

  const ensureAudioGraph = useCallback(async (autoResume = false) => {
    const { ctx, analyser, processorOptions } = await ensureAudioInfrastructure();
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
        processorOptions,
      });
      workletNodeRef.current = node;
      node.connect(analyser);
    }
    return node;
  }, [ensureAudioInfrastructure]);

  const resolvePresetIndex = useCallback((program, bank) => {
    const exactIndex = presets.findIndex((p) => p.preset === program && p.bank === bank);
    const bankZeroIndex = presets.findIndex((p) => p.preset === program && p.bank === 0);
    const programAnyIndex = presets.findIndex((p) => p.preset === program);
    if (exactIndex >= 0) return exactIndex;
    if (bankZeroIndex >= 0) return bankZeroIndex;
    if (programAnyIndex >= 0) return programAnyIndex;
    return null;
  }, [presets]);

  const getRegionsForPresetIndex = useCallback((presetIndex) => {
    if (!sf2 || presetIndex == null || presetIndex < 0) return [];
    if (presetRegionCacheRef.current.has(presetIndex)) {
      return presetRegionCacheRef.current.get(presetIndex);
    }
    const regions = sf2.buildRegionsForPreset(presetIndex, {
      decodeToFloat32: true,
      normalize: true,
      includeStereoLinks: true,
    });
    presetRegionCacheRef.current.set(presetIndex, regions);
    return regions;
  }, [sf2]);

  function getCurrentPresetRegions() {
    if (!sf2 || effectivePresetIndex == null) return [];
    if (
      presetRegionsRef.current.presetIndex === effectivePresetIndex &&
      presetRegionsRef.current.regions.length
    ) {
      return presetRegionsRef.current.regions;
    }
    const regions = getRegionsForPresetIndex(effectivePresetIndex);
    presetRegionsRef.current = { presetIndex: effectivePresetIndex, regions };
    return regions;
  }

  async function triggerNoteOn(note, velocity) {
    if (!sf2 || effectivePresetIndex == null) return;
    if (selectedPreset == null) setSelectedPreset(effectivePresetIndex);
    const node = await ensureAudioGraph(false);
    const regions = getCurrentPresetRegions();
    node.port.postMessage({ type: "setPreset", regions });
    node.port.postMessage({ type: "noteOn", note, velocity });
  }

  async function triggerNoteOff(note) {
    const node = workletNodeRef.current;
    if (!node) return;
    node.port.postMessage({ type: "noteOff", note });
  }

  // Shared function to play a note with current MIDI settings
  // Both "Play Note" and "Play Sample" buttons use this, as the audio engine
  // automatically selects the appropriate regions based on the current preset,
  // MIDI note, and velocity values.
  async function playCurrentNote() {
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

  // Handler for "Play Note" button (next to MIDI sliders)
  async function onPlayNote() {
    await playCurrentNote();
  }

  // Handler for "Play Sample" button (in PCM Sample Preview panel)
  // Plays the PCM sample directly using AudioBufferSourceNode
  async function onPlaySelectedLayer() {
    if (!selectedLayer) return;
    
    // Get the preview data (same logic as in the UI)
    const preview = selectedSamplePreview || programDetails?.previewRegion;
    if (!preview || !preview.sample || !preview.sample.dataL) return;
    
    try {
      // Ensure we have an audio context
      const { ctx } = await ensureAudioInfrastructure({ loadWorklet: false });
      
      // Create an AudioBuffer with the PCM data
      const sampleRate = preview.sample.sampleRate || 44100;
      const dataL = preview.sample.dataL;
      const dataR = preview.sample.dataR;
      
      // Create mono or stereo buffer based on available data
      const numChannels = dataR && dataR.length === dataL.length ? 2 : 1;
      const buffer = ctx.createBuffer(numChannels, dataL.length, sampleRate);
      
      // Copy the Float32Array data to the buffer
      buffer.getChannelData(0).set(dataL);
      if (numChannels === 2) {
        buffer.getChannelData(1).set(dataR);
      }
      
      // Create and configure the source node
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      
      // Play once and clean up
      source.onended = () => {
        source.disconnect();
      };
      
      source.start(0);
      
      setAudioError("");
    } catch (err) {
      setAudioError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onTogglePower() {
    try {
      const { ctx } = await ensureAudioInfrastructure({ loadWorklet: false });
      const targetState = ctx.state === "running" ? "suspended" : "running";
      if (targetState === "running") await ctx.resume();
      else await ctx.suspend();

      // Wait briefly for the context state transition to settle before reflecting it in UI.
      if (ctx.state !== targetState) {
        await new Promise((resolve) => {
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

  async function startMidiDriver() {
    if (midiDriverRef.current) return;
    if (midiEnabled) {
      return;
    }
    try {
      setMidiError("");
      const driver = await createMidiDriver({
        selectedInputId: selectedMidiInput,
        onNoteOn: async (note, velocity) => {
          setMidiNote(note);
          setMidiVelocity(velocity);
          setMidiStatus(`MIDI noteOn ${note} vel ${velocity}`);
          try {
            await triggerNoteOn(note, velocity);
          } catch (err) {
            setAudioError(err instanceof Error ? err.message : String(err));
          }
        },
        onNoteOff: (note) => {
          setMidiStatus(`MIDI noteOff ${note}`);
          triggerNoteOff(note);
        },
        onProgramChange: (program, bank, channel) => {
          const nextIndex = resolvePresetIndex(program, bank);
          if (nextIndex != null && nextIndex >= 0) {
            setSelectedPreset(nextIndex);
            setMidiStatus(
              `MIDI program ch${channel + 1}: bank ${bank}, program ${program} -> preset #${nextIndex}`
            );
          } else {
            setMidiStatus(`MIDI program ch${channel + 1}: bank ${bank}, program ${program} (not found)`);
          }
        },
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
      setMidiError(err instanceof Error ? err.message : String(err));
      setMidiEnabled(false);
      setMidiStatus("MIDI failed");
    }
  }

  async function onToggleMidi() {
    if (midiEnabled) {
      midiDriverRef.current?.disconnect();
      midiDriverRef.current = null;
      setMidiEnabled(false);
      setMidiStatus("MIDI disabled");
      setMidiError("");
      setMidiInputs([]);
      return;
    }
    await startMidiDriver();
  }

  function onHeaderSortClick(key) {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDirection("asc");
  }

  return (
    <div className={`app ${analyzerCollapsed ? "analyzerCollapsed" : "analyzerOpen"}`}>
      <header className="topHeader">
        <div>
          <h1>WASM MIDI SoundFont Player</h1>
          <p>Play MIDI with a WebAssembly SoundFont engine.</p>
        </div>
        <div className="toolbar">
          <button
            type="button"
            onClick={onTogglePower}
            className={`toggleBtn ${audioCtxState === "running" ? "tintOn" : ""}`}
            title={audioCtxState === "running" ? "Power Off" : "Power On"}
          >
            <i className="fa-solid fa-power-off" aria-hidden="true" />
            <span>{audioCtxState === "running" ? "Power Off" : "Power On"}</span>
          </button>
          <span className="midiStatus">Audio: {audioCtxState}</span>
          {webMidiSupported && (
            <>
              <button
                type="button"
                onClick={onToggleMidi}
                disabled={!sf2}
                className={`toggleBtn ${midiEnabled ? "tintOn" : ""}`}
                title={midiEnabled ? "Disable MIDI" : "Enable MIDI"}
              >
                <i className="fa-solid fa-music" aria-hidden="true" />
                <span>{midiEnabled ? "Disable MIDI" : "Enable MIDI"}</span>
              </button>
              <select
                value={selectedMidiInput}
                onChange={(e) => setSelectedMidiInput(e.target.value)}
                disabled={!midiEnabled}
                title="MIDI input source"
              >
                <option value="all">All MIDI Inputs</option>
                {midiInputs.map((input) => (
                  <option key={input.id} value={input.id}>
                    {input.name}
                  </option>
                ))}
              </select>
              <span className="midiStatus">{midiStatus}</span>
            </>
          )}
          <button
            type="button"
            className="menuToggleBtn"
            onClick={() => setAnalyzerCollapsed((v) => !v)}
            title={analyzerCollapsed ? "Show Analyzer" : "Hide Analyzer"}
            aria-label={analyzerCollapsed ? "Show Analyzer" : "Hide Analyzer"}
          >
            <i className="fa-solid fa-bars" aria-hidden="true" />
          </button>
        </div>
      </header>
      <section className="tabsRow">
        <button
          type="button"
          className={`tabButton ${activeTab === "midi" ? "active" : ""}`}
          onClick={() => setActiveTab("midi")}
        >
          MIDI Explorer
        </button>
        <button
          type="button"
          className={`tabButton ${activeTab === "sf2" ? "active" : ""}`}
          onClick={() => setActiveTab("sf2")}
        >
          SF2 Explorer
        </button>
      </section>

      {loading && <p className="status">Parsing...</p>}
      {error && <p className="status error">{error}</p>}
      {midiError && <p className="status error">{midiError}</p>}

      {activeTab === "midi" && (
        <MidiReader
          sf2Ready={!!sf2}
          ensureAudioInfrastructure={ensureAudioInfrastructure}
          getRegionsForPreset={(presetIndex) => getRegionsForPresetIndex(presetIndex)}
          resolvePresetIndex={resolvePresetIndex}
          fallbackPresetIndex={effectivePresetIndex ?? 0}
          presetOptions={presets.map((p, idx) => ({
            index: idx,
            bank: p.bank,
            program: p.preset,
            name: p.presetName || "(unnamed)",
          }))}
          onError={(msg) => setAudioError(msg)}
        />
      )}

      {activeTab === "sf2" && (
        <>
          <section className="card controls">
            <label className="fileInput">
              <span className="iconLabel">
                <i className="fa-solid fa-file-arrow-up" aria-hidden="true" />
                <span>Open SF2 File</span>
              </span>
              <input type="file" accept=".sf2" onChange={onUploadFile} />
            </label>
            <select
              value={selectedSf2Path}
              onChange={async (e) => {
                const nextPath = e.target.value;
                setSelectedSf2Path(nextPath);
                if (!nextPath) return;
                const selected = sf2Options.find((item) => item.path === nextPath);
                await onSelectSample(nextPath, selected?.name || nextPath);
              }}
              disabled={!sf2Options.length || loading}
              title="SF2 files from public/static"
            >
              <option value="">Select SF2</option>
              {sf2Options.map((item) => (
                <option key={item.path} value={item.path}>
                  {item.name}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => setShowSummaryModal((v) => !v)} disabled={!sf2}>
              {showSummaryModal ? "Hide File Summary" : "Show File Summary"}
            </button>
            <span className="midiStatus">Keyboard: a w s e d f t g y h</span>
          </section>
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
                      k === "ICMT"
                        ? String(raw).replace(/<br\s*\/?>/gi, "\n")
                        : raw;
                    return (
                      <li key={k}>
                        <code>{k}</code>:{" "}
                        <span className={k === "ICMT" ? "infoValueMultiline" : undefined}>{rendered}</span>
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

          {sf2 && <main className="layout sf2Layout">
            <section className="card sf2Panel presetsPanel">
              <div className="panelHead">
                <h2>Presets</h2>
                <span className="panelBadge">{visiblePresets.length}</span>
              </div>
              <div className="panelBody">
                <div className="presetFilters">
                  <input
                    type="search"
                    placeholder="Search name/bank/program"
                    value={presetSearch}
                    onChange={(e) => setPresetSearch(e.target.value)}
                  />
                </div>
                <div className="scroll tableScroll">
                  <table className="sf2Table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Name</th>
                        <th>
                          <button type="button" className="thSort" onClick={() => onHeaderSortClick("bank")}>
                            Bank {sortKey === "bank" ? (sortDirection === "asc" ? "↑" : "↓") : ""}
                          </button>
                        </th>
                        <th>
                          <button
                            type="button"
                            className="thSort"
                            onClick={() => onHeaderSortClick("program")}
                          >
                            Program {sortKey === "program" ? (sortDirection === "asc" ? "↑" : "↓") : ""}
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
                          onChange={(e) => setMidiNote(Number(e.target.value))}
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
                          onChange={(e) => setMidiVelocity(Number(e.target.value))}
                        />
                      </div>
                    </div>
                    <div className="playControls">
                      <button type="button" onClick={onPlayNote} disabled={selectedPreset == null || !sf2}>
                        Play Note
                      </button>
                      <span className="audioState">{audioReady ? "Audio ready" : "Audio not initialized"}</span>
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
                        <strong>library/genre/morphology:</strong> {programDetails.header.library}/
                        {programDetails.header.genre}/{programDetails.header.morphology}
                      </p>
                    </div>

                    <div className="detailBlock">
                      <h3>Global Zone</h3>
                      {programDetails.presetGlobal ? (
                        <ul className="monoList">
                          <li>
                            <button
                              type="button"
                              className={`layerButton ${selectedLayer?.type === "presetGlobal" ? "selected" : ""
                                }`}
                              onClick={() =>
                                setSelectedLayer({
                                  type: "presetGlobal",
                                  title: `Preset global ${programDetails.presetGlobal.bagIndex}`,
                                  context: "global zone",
                                  levels: [
                                    {
                                      label: `Preset global bag ${programDetails.presetGlobal.bagIndex}`,
                                      gens: programDetails.presetGlobal.gens,
                                      mods: programDetails.presetGlobal.mods,
                                    },
                                  ],
                                  bagIndex: programDetails.presetGlobal.bagIndex,
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
                                    className={`layerButton ${selectedLayer?.type === "instrumentGlobal" &&
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
                                    {inst.globalZone.gens.length} generators / {inst.globalZone.mods.length} modulators
                                  </button>
                                </p>
                              ) : (
                                <p>
                                  <strong>Global:</strong> None
                                </p>
                              )}
                              <ul className="monoList">
                                {inst.sampleZones.map((zone) => (
                                  <li key={`iz-${inst.index}-${zone.bagIndex}`}>
                                    <button
                                      type="button"
                                      className={`layerButton ${selectedLayer?.type === "instrumentRegion" &&
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
                                      bag {zone.bagIndex}: sample {zone.sampleID} ({zone.sampleName}) @{" "}
                                      {zone.sampleRate}Hz
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
                    {/* Button is disabled when layer, preset, or sf2 is missing.
                        The handler has a simpler guard that only checks selectedLayer
                        since playCurrentNote() validates preset/sf2, but we disable
                        the button proactively for better UX. */}
                    <button type="button" onClick={onPlaySelectedLayer} disabled={!selectedLayer || selectedPreset == null || !sf2}>
                      Play Sample
                    </button>
                  </div>
                  {audioError ? <p className="status error">{audioError}</p> : null}
                  {(() => {
                    // Use selectedSamplePreview if available (for instrumentRegion), otherwise use previewRegion
                    const preview = selectedSamplePreview || programDetails?.previewRegion;
                    
                    if (selectedPreset == null || !preview) {
                      return <p>Waveform appears when the selected program has playable regions.</p>;
                    }
                    
                    return (
                      <>
                        <WaveformCanvas data={preview.sample.dataL} />
                        <p>
                          {selectedSamplePreview && (
                            <>
                              <strong>Sample ID:</strong> {selectedSamplePreview.sampleID} ({selectedSamplePreview.sampleName})<br />
                            </>
                          )}
                          <strong>Frames:</strong> {preview.sample.dataL.length}{" "}
                          <strong>Sample Rate:</strong> {preview.sample.sampleRate}
                        </p>
                      </>
                    );
                  })()}
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
                    No matching layer for note {midiNote} velocity {midiVelocity}. Click a region or
                    instrument layer to inspect it directly.
                  </p>
                ) : (
                  <div className="scroll">
                    <p>
                      <strong>{selectedLayer.title}</strong> ({selectedLayer.context})
                    </p>
                    {(selectedLayer.levels ?? []).map((level, idx) => (
                      <div key={`${selectedLayer.type}-${selectedLayer.bagIndex}-level-${idx}`} className="levelBlock">
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
          </main>}
        </>
      )}

      <aside className={`fixedAnalyzerPanel card ${analyzerCollapsed ? "collapsed" : ""}`}>
        <div className="analyzerHead">
          <h2>{analyzerCollapsed ? "Viz" : "Analyzer"}</h2>
          {!analyzerCollapsed && (
            <button type="button" onClick={() => setAnalyzerCollapsed((v) => !v)}>
              Collapse
            </button>
          )}
        </div>
        {!analyzerCollapsed && (
          <div className="analyzerBody">
            <h3>Recent Time Domain</h3>
            <AnalyzerCanvas data={recentTimeData} mode="time" />
            <h3>Recent Frequency Domain</h3>
            <AnalyzerCanvas data={recentFreqData} mode="freq" />
          </div>
        )}
      </aside>
    </div>
  );
}
