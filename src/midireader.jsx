import { useEffect, useMemo, useRef, useState } from "react";

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
  const [songTime, setSongTime] = useState(0);
  const [showMidiInfoModal, setShowMidiInfoModal] = useState(false);
  const [midiOptions, setMidiOptions] = useState([]);
  const [selectedMidiPath, setSelectedMidiPath] = useState("");
  const [trackPresetOverrides, setTrackPresetOverrides] = useState({});
  const [trackCcControls, setTrackCcControls] = useState({});
  const [trackMixState, setTrackMixState] = useState({});

  const viewportRef = useRef(null);
  const playheadRef = useRef(null);
  const contentRef = useRef(null);
  const uploadInputRef = useRef(null);
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
  const songTitle = useMemo(() => {
    const midiTitle = song?.info?.title;
    if (typeof midiTitle === "string" && midiTitle.trim()) return midiTitle.trim();
    return songName || "No MIDI loaded";
  }, [song?.info?.title, songName]);
  const midiInfoRows = useMemo(() => {
    if (!song?.info) return [];
    return [
      ["Title", song.info.title || "(none)"],
      ["Duration", fmtTime(song.info.durationSec ?? song.durationSec ?? 0)],
      ["BPM", song.info.bpm ?? song.bpm ?? "--"],
      ["Time Signature", song.info.timeSig ?? song.timeSig ?? "--"],
      ["Format", song.info.format ?? song.format ?? "--"],
      ["Division", song.info.division ?? song.division ?? "--"],
      ["Tracks", song.info.trackCount ?? song.tracks?.length ?? 0],
      ["Notes", song.info.noteCount ?? 0],
      ["Bars", song.info.totalBars ?? song.totalBars ?? "--"],
      ["Lyrics Events", song.info.lyricsCount ?? 0],
      ["Marker Events", song.info.markerCount ?? 0],
      ["Cue Events", song.info.cueCount ?? 0],
      ["Copyright", song.info.copyright || "(none)"],
    ];
  }, [song]);
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

  const seekToSeconds = (nextSec) => {
    const safeDuration = Math.max(0.01, durationRef.current);
    const sec = Math.max(0, Math.min(safeDuration, Number(nextSec) || 0));
    updatePlayhead(sec);
    setSongTime(sec);
    workerRef.current?.postMessage({ type: "seek", sec });
    return sec;
  };

  const seekToClientX = (clientX) => {
    const content = contentRef.current;
    if (!content) return 0;
    const rect = content.getBoundingClientRect();
    const width = Math.max(1, contentWRef.current);
    const safeDuration = Math.max(0.01, durationRef.current);
    const xInContent = Math.max(0, Math.min(width, clientX - rect.left));
    return seekToSeconds((xInContent / width) * safeDuration);
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
    const worker = new Worker(new URL("./midi-timer.worker.js", import.meta.url), { type: "module" });
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

    const { ctx, analyser, processorOptions } = await ensureAudioInfrastructure();
    if (!processorOptions?.wasmBinary || !processorOptions?.glueCode) {
      throw new Error("AudioWorklet WASM data is not ready");
    }
    const trackNodes = [];
    for (let i = 0; i < song.tracks.length; i += 1) {
      const node = new AudioWorkletNode(ctx, "sf2-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions,
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

  function onStepSeek(deltaSec) {
    seekToSeconds(songTime + deltaSec);
  }

  async function onUploadMidi(event) {
    const file = event.target.files?.[0];
    if (!file || !workerRef.current) return;
    try {
      if (isPlaying) workerRef.current.postMessage({ type: "pause" });
      disconnectTrackNodes();
      const buf = await file.arrayBuffer();
      workerRef.current.postMessage({ type: "loadMidi", midiData: buf }, [buf]);
      setSelectedMidiPath("");
      setSongName(file.name);
      setSongTime(0);
      setSongError("");
      event.target.value = "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSongError(msg);
      onError?.(msg);
      setSong(null);
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

  return (
    <section className="card midiReader">
      <div className="midiTop">
        <div className="midiTopGroup midiTopTransport transportPanel">
          <div className="transportRow">
            <button
              type="button"
              className="transportBtn"
              onClick={() => onStepSeek(-5)}
              disabled={!song}
              aria-label="Rewind 5 seconds"
              title="Rewind 5 seconds"
            >
              <i className="fa-solid fa-backward-step" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="transportBtn"
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
              onClick={() => onStepSeek(5)}
              disabled={!song}
              aria-label="Forward 5 seconds"
              title="Forward 5 seconds"
            >
              <i className="fa-solid fa-forward-step" aria-hidden="true" />
            </button>
          </div>
          <div className="transportMeta">
            <strong className="chip">{fmtTime(songTime)} / {fmtTime(duration)}</strong>
            <span className="chip">{song ? `Tempo ${song.bpm} BPM` : "Tempo --"}</span>
            <span className="chip">{song ? `Sig ${song.timeSig}` : "Sig --"}</span>
          </div>
        </div>

        <div className="midiTopGroup midiTopLoad sourcePanel">
          <select
            value={selectedMidiPath}
            onChange={(e) => onSelectMidiPath(e.target.value)}
            disabled={!midiOptions.length}
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
            className="uploadMidiBtn"
            onClick={() => uploadInputRef.current?.click()}
          >
            <i className="fa-solid fa-file-arrow-up" aria-hidden="true" />
            <span>Play MIDI File</span>
          </button>
          <input
            ref={uploadInputRef}
            type="file"
            accept=".mid,.midi"
            onChange={onUploadMidi}
            hidden
          />
        </div>
      </div>
      <div className="midiTopSong">
        <span className="songChip">{songTitle}</span>
        <button
          type="button"
          onClick={() => setShowMidiInfoModal(true)}
          disabled={!song}
        >
          MIDI Info
        </button>
      </div>
      {showMidiInfoModal && song && (
        <div className="modalBackdrop" onClick={() => setShowMidiInfoModal(false)}>
          <section className="card summaryModal" onClick={(e) => e.stopPropagation()}>
            <h2>MIDI Info</h2>
            <ul className="infoList">
              {midiInfoRows.map(([label, value]) => (
                <li key={label}>
                  <strong>{label}:</strong> {value}
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => setShowMidiInfoModal(false)}>
              Close
            </button>
          </section>
        </div>
      )}
      {songError ? <p className="status error">{songError}</p> : null}
      {song && (
        <div className="midiScrubberRow">
          <span className="midiScrubberTime">{fmtTime(songTime)}</span>
          <input
            className="midiScrubber"
            type="range"
            min={0}
            max={duration}
            step={0.01}
            value={Math.min(duration, songTime)}
            onChange={(e) => seekToSeconds(e.target.value)}
            aria-label="Song position"
          />
          <span className="midiScrubberTime">{fmtTime(duration)}</span>
        </div>
      )}
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
