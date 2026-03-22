import { useEffect, useMemo, useRef, useState } from "react";
import { renderOfflineSequenceToAudioBufferIncremental } from "./sf2-renderer.ts";

function fmtTime(sec) {
  const s = Math.max(0, sec | 0);
  const m = (s / 60) | 0;
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

const DEFAULT_TRACK_CC = { cc7Volume: 100, cc10Pan: 64, cc11Expression: 127 };

function clampCc(value) {
  return Math.max(0, Math.min(127, Number(value) | 0));
}

function encodeWav(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numSamples = audioBuffer.length;
  const bytesPerSample = 2;
  const dataSize = numChannels * numSamples * bytesPerSample;
  const channelData = Array.from({ length: numChannels }, (_, ch) => audioBuffer.getChannelData(ch));
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
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

async function encodeWavIncremental(audioBuffer, chunkSamples = 16384, onProgress) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numSamples = audioBuffer.length;
  const bytesPerSample = 2;
  const dataSize = numChannels * numSamples * bytesPerSample;
  const channelData = Array.from({ length: numChannels }, (_, ch) => audioBuffer.getChannelData(ch));
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
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
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return buffer;
}

function CcKnob({ label, value, onChange, disabled = false }) {
  const startRef = useRef({ active: false, startY: 0, startValue: value });

  useEffect(() => {
    if (!startRef.current.active) startRef.current.startValue = value;
  }, [value]);

  const angle = -135 + (Math.max(0, Math.min(127, value)) / 127) * 270;
  const rad = (angle * Math.PI) / 180;
  const x2 = 20 + Math.cos(rad) * 11;
  const y2 = 20 + Math.sin(rad) * 11;

  const onPointerDown = (event) => {
    if (disabled) return;
    if (event.button !== 0) return;
    event.preventDefault();
    startRef.current = { active: true, startY: event.clientY, startValue: value };
  };

  const onPointerMove = (event) => {
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

const ORCHESTRA_PAN_RULES = [
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

function resolveOrchestraPan(...labels) {
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
}) {
  const [song, setSong] = useState(null);
  const [songName, setSongName] = useState("");
  const [songError, setSongError] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStage, setExportStage] = useState("");
  const [songTime, setSongTime] = useState(0);
  const [midiOptions, setMidiOptions] = useState([]);
  const [selectedMidiPath, setSelectedMidiPath] = useState("");
  const [trackPresetOverrides, setTrackPresetOverrides] = useState({});
  const [trackCcControls, setTrackCcControls] = useState({});
  const [trackMixState, setTrackMixState] = useState({});
  const [toolbarHint, setToolbarHint] = useState("MIDI Explorer");

  const viewportRef = useRef(null);
  const playheadRef = useRef(null);
  const contentRef = useRef(null);
  const workerRef = useRef(null);
  const trackNodesRef = useRef([]);
  const portsAttachedRef = useRef(false);
  const dragStateRef = useRef({ active: false, startX: 0, startLeft: 0 });
  const isSeekingRef = useRef(false);
  const onErrorRef = useRef(onError);
  const trackPresetOverridesRef = useRef({});
  const trackCcControlsRef = useRef({});
  const trackMixStateRef = useRef({});
  const resolvePresetRef = useRef(resolvePresetIndex);
  const getRegionsRef = useRef(getRegionsForPreset);
  const fallbackPresetRef = useRef(fallbackPresetIndex);
  const durationRef = useRef(0.01);
  const contentWRef = useRef(1000);
  const presetOptionMapRef = useRef(new Map());

  const timelineW = 1000;
  const trackH = 108;
  const duration = Math.max(0.01, song?.durationSec ?? 0.01);
  const totalBars = Math.max(1, song?.totalBars ?? 1);
  const visibleBars = 30;
  const zoomFactor = totalBars > visibleBars ? totalBars / visibleBars : 1;
  const contentW = Math.round(timelineW * zoomFactor);

  const visibleTracks = useMemo(() => song?.tracks ?? [], [song]);
  const presetOptionMap = useMemo(
    () => new Map((presetOptions ?? []).map((p) => [p.index, p])),
    [presetOptions]
  );
  const trackDefaultPresetMap = useMemo(() => {
    const out = {};
    if (!song?.tracks?.length) return out;
    for (const track of song.tracks) {
      const programEvent = track.playEvents.find((e) => e.type === "program");
      if (!programEvent) continue;
      const presetIndex = resolvePresetIndex(programEvent.program, programEvent.bank);
      if (presetIndex != null && presetIndex >= 0) out[track.index] = presetIndex;
    }
    return out;
  }, [song, resolvePresetIndex]);

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
    presetOptionMapRef.current = presetOptionMap;
  }, [presetOptionMap]);

  const updatePlayhead = (sec) => {
    const line = playheadRef.current;
    if (!line) return;
    const safeDuration = Math.max(0.01, durationRef.current);
    const width = Math.max(1, contentWRef.current);
    const x = (Math.max(0, Math.min(safeDuration, sec)) / safeDuration) * width;
    line.style.transform = `translateX(${x}px)`;
  };

  const seekToClientX = (clientX) => {
    const content = contentRef.current;
    if (!content) return 0;
    const rect = content.getBoundingClientRect();
    const width = Math.max(1, contentWRef.current);
    const safeDuration = Math.max(0.01, durationRef.current);
    const xInContent = Math.max(0, Math.min(width, clientX - rect.left));
    const sec = (xInContent / width) * safeDuration;
    updatePlayhead(sec);
    setSongTime(sec);
    workerRef.current?.postMessage({ type: "seek", sec });
    return sec;
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

  const getTrackCc = (trackIndex, controls = trackCcControlsRef.current) => {
    const cc = controls?.[trackIndex];
    return {
      cc7Volume: clampCc(cc?.cc7Volume ?? DEFAULT_TRACK_CC.cc7Volume),
      cc10Pan: clampCc(cc?.cc10Pan ?? DEFAULT_TRACK_CC.cc10Pan),
      cc11Expression: clampCc(cc?.cc11Expression ?? DEFAULT_TRACK_CC.cc11Expression),
    };
  };

  const applyTrackControllers = (songData, controls = trackCcControlsRef.current) => {
    if (!songData?.tracks?.length) return;
    for (let i = 0; i < songData.tracks.length; i += 1) {
      const track = songData.tracks[i];
      const rec = trackNodesRef.current[i];
      if (!rec?.node) continue;
      const cc = getTrackCc(track.index, controls);
      rec.node.port.postMessage({ type: "setControllers", ...cc });
    }
  };

  const applyTrackMuteSolo = (songData, mix = trackMixStateRef.current) => {
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

  const applyTrackPanning = (songData, overrides) => {
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

  useEffect(() => {
    const worker = new Worker(new URL("./midi-timer.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "songLoaded") {
        setSong(msg.song);
        setSongTime(0);
        setIsPlaying(false);
        setSongError("");
        setTrackPresetOverrides({});
        setTrackCcControls({});
        setTrackMixState({});
        updatePlayhead(0);
        return;
      }
      if (msg.type === "tick") {
        if (!isSeekingRef.current) {
          setSongTime(msg.sec ?? 0);
          updatePlayhead(msg.sec ?? 0);
        }
        const viewport = viewportRef.current;
        if (viewport && !isSeekingRef.current) {
          const safeDuration = Math.max(0.01, durationRef.current);
          const width = contentWRef.current;
          const playX = ((msg.sec ?? 0) / safeDuration) * width;
          const target = Math.max(0, playX - viewport.clientWidth * 0.2);
          const maxLeft = Math.max(0, width - viewport.clientWidth);
          viewport.scrollLeft = Math.min(maxLeft, target);
        }
        return;
      }
      if (msg.type === "paused") {
        setSongTime(msg.sec ?? 0);
        updatePlayhead(msg.sec ?? 0);
        setIsPlaying(false);
        return;
      }
      if (msg.type === "ended") {
        setSongTime(msg.sec ?? 0);
        updatePlayhead(msg.sec ?? 0);
        setIsPlaying(false);
        return;
      }
      if (msg.type === "programChangeRequest") {
        const presetIndex =
          trackPresetOverridesRef.current[msg.trackIndex] != null
            ? trackPresetOverridesRef.current[msg.trackIndex]
            : resolvePresetRef.current(msg.program, msg.bank) ?? fallbackPresetRef.current;
        const regions = getRegionsRef.current(presetIndex);
        worker.postMessage({
          type: "setTrackPreset",
          trackIndex: msg.trackIndex,
          presetIndex,
          override: trackPresetOverridesRef.current[msg.trackIndex] != null,
          regions,
        });
        return;
      }
      if (msg.type === "error") {
        setSongError(msg.message || "Worker error");
        onErrorRef.current?.(msg.message || "Worker error");
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
    updatePlayhead(0);
  }, [songName]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    viewport.classList.add("dragScroll");

    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      dragStateRef.current.active = true;
      dragStateRef.current.startX = event.clientX;
      dragStateRef.current.startLeft = viewport.scrollLeft;
      viewport.classList.add("dragging");
      viewport.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    };

    const onPointerMove = (event) => {
      if (!dragStateRef.current.active) return;
      const dx = event.clientX - dragStateRef.current.startX;
      viewport.scrollLeft = dragStateRef.current.startLeft - dx;
    };

    const endDrag = (event) => {
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
    const line = playheadRef.current;
    if (!line) return;

    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      isSeekingRef.current = true;
      line.classList.add("seeking");
      line.setPointerCapture?.(event.pointerId);
      seekToClientX(event.clientX);
    };

    const onPointerMove = (event) => {
      if (!isSeekingRef.current) return;
      seekToClientX(event.clientX);
    };

    const endSeek = (event) => {
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
        const list = await res.json();
        const normalized = Array.isArray(list)
          ? list.filter((m) => m?.path && m?.name)
          : [];
        setMidiOptions(normalized);

        const preferred = normalized.find((m) => m.name === "60884_Beethoven-Symphony-No51.mid");
        const first = preferred ?? normalized[0];
        if (first) {
          setSelectedMidiPath(first.path);
          const midiRes = await fetch(`${import.meta.env.BASE_URL}${first.path}`);
          if (!midiRes.ok) throw new Error(`Failed to fetch ${first.path}`);
          const buf = await midiRes.arrayBuffer();
          workerRef.current?.postMessage({ type: "loadMidi", midiData: buf }, [buf]);
          setSongName(first.name);
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
    const trackNodes = [];
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
      const presetIndex = overridePreset ?? fallbackPresetIndex;
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
      // Resume audio context if it's not running (e.g., suspended or interrupted)
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
      const offlineTracks = [];
      const events = [];
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
            const pIdx = resolvePresetRef.current(ev.program, ev.bank) ?? fallbackPresetRef.current;
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
        onProgress: (progress) => {
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

  async function onUploadMidi(event) {
    const file = event.target.files?.[0];
    if (!file || !workerRef.current) return;
    try {
      if (isPlaying) workerRef.current.postMessage({ type: "pause" });
      disconnectTrackNodes();
      const buf = await file.arrayBuffer();
      workerRef.current.postMessage({ type: "loadMidi", midiData: buf }, [buf]);
      setSongName(file.name);
      setSongTime(0);
      setSongError("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSongError(msg);
      onError?.(msg);
      setSong(null);
    }
  }

  async function onLoadSelectedMidi() {
    if (!selectedMidiPath || !workerRef.current) return;
    try {
      if (isPlaying) workerRef.current.postMessage({ type: "pause" });
      disconnectTrackNodes();
      const res = await fetch(`${import.meta.env.BASE_URL}${selectedMidiPath}`);
      if (!res.ok) throw new Error(`Failed to fetch ${selectedMidiPath}`);
      const buf = await res.arrayBuffer();
      workerRef.current.postMessage({ type: "loadMidi", midiData: buf }, [buf]);
      const selected = midiOptions.find((m) => m.path === selectedMidiPath);
      setSongName(selected?.name || selectedMidiPath);
      setSongTime(0);
      setSongError("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSongError(msg);
      onError?.(msg);
    }
  }

  async function onSelectMidiPath(nextPath) {
    setSelectedMidiPath(nextPath);
    if (!nextPath) return;
    try {
      if (isPlaying) workerRef.current?.postMessage({ type: "pause" });
      disconnectTrackNodes();
      const res = await fetch(`${import.meta.env.BASE_URL}${nextPath}`);
      if (!res.ok) throw new Error(`Failed to fetch ${nextPath}`);
      const buf = await res.arrayBuffer();
      workerRef.current?.postMessage({ type: "loadMidi", midiData: buf }, [buf]);
      const selected = midiOptions.find((m) => m.path === nextPath);
      setSongName(selected?.name || nextPath);
      setSongTime(0);
      setSongError("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSongError(msg);
      onError?.(msg);
    }
  }

  function onTrackPresetChange(trackIndex, nextValue) {
    const parsed = Number(nextValue);
    const nextPreset = Number.isFinite(parsed) ? parsed : null;
    setTrackPresetOverrides((prev) => ({ ...prev, [trackIndex]: nextPreset }));
    if (!workerRef.current || !portsAttachedRef.current) return;
    const presetIndex = nextPreset ?? fallbackPresetIndex;
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

  function onTrackCcChange(trackIndex, key, rawValue) {
    const value = clampCc(rawValue);
    const current = getTrackCc(trackIndex);
    const nextTrack = { ...current, [key]: value };
    const nextAll = { ...trackCcControlsRef.current, [trackIndex]: nextTrack };
    trackCcControlsRef.current = nextAll;
    setTrackCcControls(nextAll);
    const rec = trackNodesRef.current[trackIndex];
    if (rec?.node) rec.node.port.postMessage({ type: "setControllers", ...nextTrack });
    applyTrackMuteSolo(song, trackMixStateRef.current);
  }

  function onToggleTrackMute(trackIndex) {
    const current = trackMixStateRef.current[trackIndex] ?? { mute: false, solo: false };
    const nextAll = {
      ...trackMixStateRef.current,
      [trackIndex]: { ...current, mute: !current.mute },
    };
    setTrackMixState(nextAll);
    applyTrackMuteSolo(song, nextAll);
  }

  function onToggleTrackSolo(trackIndex) {
    const current = trackMixStateRef.current[trackIndex] ?? { mute: false, solo: false };
    const nextAll = {
      ...trackMixStateRef.current,
      [trackIndex]: { ...current, solo: !current.solo },
    };
    setTrackMixState(nextAll);
    applyTrackMuteSolo(song, nextAll);
  }

  function formatTrackInlineName(track) {
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
        <div className="toolbar toolbarUnified midiUnifiedToolbar">
          <button
            type="button"
            className={`toolbarIconBtn ${activeTab === "midi" ? "active" : ""}`}
            onClick={() => onSelectTab("midi")}
            aria-label="MIDI Explorer"
            title="MIDI Explorer"
            onMouseEnter={() => setToolbarHint("MIDI Explorer")}
            onFocus={() => setToolbarHint("MIDI Explorer")}
          >
            <i className="fa-solid fa-music" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`toolbarIconBtn ${activeTab === "sf2" ? "active" : ""}`}
            onClick={() => onSelectTab("sf2")}
            aria-label="SF2 Explorer"
            title="SF2 Explorer"
            onMouseEnter={() => setToolbarHint("SF2 Explorer")}
            onFocus={() => setToolbarHint("SF2 Explorer")}
          >
            <i className="fa-solid fa-wave-square" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`toolbarIconBtn ${audioCtxState === "running" ? "active" : ""}`}
            onClick={onTogglePower}
            aria-label={audioCtxState === "running" ? "Power Off" : "Power On"}
            title={audioCtxState === "running" ? "Power Off" : "Power On"}
            onMouseEnter={() => setToolbarHint(audioCtxState === "running" ? "Power Off" : "Power On")}
            onFocus={() => setToolbarHint(audioCtxState === "running" ? "Power Off" : "Power On")}
          >
            <i className="fa-solid fa-power-off" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`toolbarIconBtn ${midiEnabled ? "active" : ""}`}
            onClick={onToggleMidi}
            disabled={!sf2Ready}
            aria-label={midiEnabled ? "Disable MIDI" : "Enable MIDI"}
            title={midiEnabled ? "Disable MIDI" : "Enable MIDI"}
            onMouseEnter={() => setToolbarHint(midiEnabled ? "Disable MIDI" : "Enable MIDI")}
            onFocus={() => setToolbarHint(midiEnabled ? "Disable MIDI" : "Enable MIDI")}
          >
            <i className="fa-solid fa-plug" aria-hidden="true" />
          </button>
          <select
            className="toolbarSelect"
            value={selectedMidiInput}
            onChange={(e) => onSelectMidiInput(e.target.value)}
            disabled={!midiEnabled}
            title="MIDI input source"
            onMouseEnter={() => setToolbarHint("MIDI input source")}
            onFocus={() => setToolbarHint("MIDI input source")}
          >
            <option value="all">All MIDI Inputs</option>
            {midiInputs.map((input) => (
              <option key={input.id} value={input.id}>
                {input.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`toolbarIconBtn ${!analyzerCollapsed ? "active" : ""}`}
            onClick={onToggleAnalyzer}
            aria-label={analyzerCollapsed ? "Show Analyzer" : "Hide Analyzer"}
            title={analyzerCollapsed ? "Show Analyzer" : "Hide Analyzer"}
            onMouseEnter={() => setToolbarHint(analyzerCollapsed ? "Show Analyzer" : "Hide Analyzer")}
            onFocus={() => setToolbarHint(analyzerCollapsed ? "Show Analyzer" : "Hide Analyzer")}
          >
            <i className="fa-solid fa-chart-column" aria-hidden="true" />
          </button>

          <div className="midiTopGroup midiTopLoad">
            <label className="fileInput midiFileInputCompact">
              <span className="midiFileInputLabel" aria-hidden="true">
                <i className="fa-solid fa-file-arrow-up" />
              </span>
              <input type="file" accept=".mid,.midi" onChange={onUploadMidi} />
            </label>
            <select
              className="toolbarSelect"
              value={selectedMidiPath}
              onChange={(e) => onSelectMidiPath(e.target.value)}
              disabled={!midiOptions.length}
              title="MIDI files from public/static"
              onMouseEnter={() => setToolbarHint("Select MIDI")}
              onFocus={() => setToolbarHint("Select MIDI")}
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
              className="toolbarIconBtn"
              onClick={onLoadSelectedMidi}
              disabled={!selectedMidiPath}
              aria-label="Reload MIDI"
              title="Reload MIDI"
              onMouseEnter={() => setToolbarHint("Reload MIDI")}
              onFocus={() => setToolbarHint("Reload MIDI")}
            >
              <i className="fa-solid fa-rotate-right" aria-hidden="true" />
            </button>
          </div>

          <div className="midiTopGroup midiTopLoad">
            <label className="fileInput midiFileInputCompact">
              <span className="midiFileInputLabel" aria-hidden="true">
                <i className="fa-solid fa-folder-open" />
              </span>
              <input type="file" accept=".sf2" onChange={onUploadSf2} />
            </label>
            <button
              type="button"
              className="toolbarIconBtn"
              onClick={onLoadDefaultSf2}
              disabled={sf2Loading}
              aria-label={sf2Loading ? "Loading default SF2" : "Load Default SF2"}
              title={sf2Loading ? "Loading default SF2" : "Load Default SF2"}
              onMouseEnter={() => setToolbarHint(sf2Loading ? "Loading default SF2" : "Load Default SF2")}
              onFocus={() => setToolbarHint(sf2Loading ? "Loading default SF2" : "Load Default SF2")}
            >
              <i className={`fa-solid ${sf2Loading ? "fa-spinner fa-spin" : "fa-database"}`} aria-hidden="true" />
            </button>
            <span className="songChip">{sf2Name || "No SoundFont loaded"}</span>
          </div>

          <div className="toolbarHoverText" aria-live="polite">
            {toolbarHint}
          </div>
        </div>
        <div className="midiTopGroup midiTopTransport midiTopTransportFull">
          <div className="transportHero">
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
            {isExporting ? (
              <div className="exportProgress" aria-live="polite">
                <div className="exportProgressBar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(exportProgress * 100)}>
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
      </div>
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
