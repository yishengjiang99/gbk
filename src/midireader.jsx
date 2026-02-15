import { useEffect, useMemo, useRef, useState } from "react";

function fmtTime(sec) {
  const s = Math.max(0, sec | 0);
  const m = (s / 60) | 0;
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
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
  const [midiOptions, setMidiOptions] = useState([]);
  const [selectedMidiPath, setSelectedMidiPath] = useState("");
  const [trackPresetOverrides, setTrackPresetOverrides] = useState({});

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
        rec.panner?.disconnect();
      } catch {
        // no-op
      }
    }
    trackNodesRef.current = [];
    portsAttachedRef.current = false;
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
      node.connect(panner);
      panner.connect(analyser);
      trackNodes.push({ node, panner });
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

  return (
    <section className="card midiReader">
      <div className="midiTop">
        <label className="fileInput">
          <span>Upload MIDI</span>
          <input type="file" accept=".mid,.midi" onChange={onUploadMidi} />
        </label>
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
        <button type="button" onClick={onLoadSelectedMidi} disabled={!selectedMidiPath}>Reload</button>
        <button type="button" onClick={onPlayPause} disabled={!song || !sf2Ready}>
          {isPlaying ? "Pause" : "Play"}
        </button>
        <strong>{fmtTime(songTime)} / {fmtTime(duration)}</strong>
        <span>{song ? `Tempo ${song.bpm} BPM` : ""}</span>
        <span>{song ? `Signature ${song.timeSig}` : ""}</span>
        <span>{songName || "No MIDI loaded"}</span>
      </div>
      {songError ? <p className="status error">{songError}</p> : null}
      {song && (
        <div className="midiTimelineWrap">
          <div className="midiTracksSplit">
            <div className="midiTracksLeft">
              {visibleTracks.map((track) => (
                <div key={`left-${track.index}`} className="midiTrackLabelRow">
                  <div className="midiTrackLabel">
                    <strong>{track.name}</strong>
                    <span>{track.instrumentName}</span>
                  </div>
                  <select
                    value={
                      trackPresetOverrides[track.index] ??
                      (trackDefaultPresetMap[track.index] ?? "")
                    }
                    onChange={(e) => onTrackPresetChange(track.index, e.target.value)}
                    disabled={!sf2Ready}
                  >
                    <option value="">Track Program</option>
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
