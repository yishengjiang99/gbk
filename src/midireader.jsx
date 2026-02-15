import { useEffect, useMemo, useRef, useState } from "react";

function fmtTime(sec) {
  const s = Math.max(0, sec | 0);
  const m = (s / 60) | 0;
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export default function MidiReader({
  sf2Ready,
  ensureAudioInfrastructure,
  getRegionsForPreset,
  resolvePresetIndex,
  fallbackPresetIndex,
  presetOptions = [],
  onError,
  defaultMidiUrl = "",
  defaultMidiName = "",
}) {
  const [song, setSong] = useState(null);
  const [songName, setSongName] = useState("");
  const [songError, setSongError] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [songTime, setSongTime] = useState(0);
  const [didAutoLoad, setDidAutoLoad] = useState(false);
  const [trackPresetOverrides, setTrackPresetOverrides] = useState({});

  const viewportRef = useRef(null);
  const playheadRef = useRef(null);
  const workerRef = useRef(null);
  const trackNodesRef = useRef([]);
  const portsAttachedRef = useRef(false);
  const onErrorRef = useRef(onError);
  const trackPresetOverridesRef = useRef({});
  const resolvePresetRef = useRef(resolvePresetIndex);
  const getRegionsRef = useRef(getRegionsForPreset);
  const fallbackPresetRef = useRef(fallbackPresetIndex);
  const durationRef = useRef(0.01);
  const contentWRef = useRef(1000);

  const timelineW = 1000;
  const trackH = 108;
  const duration = Math.max(0.01, song?.durationSec ?? 0.01);
  const totalBars = Math.max(1, song?.totalBars ?? 1);
  const visibleBars = 30;
  const zoomFactor = totalBars > visibleBars ? totalBars / visibleBars : 1;
  const contentW = Math.round(timelineW * zoomFactor);

  const visibleTracks = useMemo(() => song?.tracks ?? [], [song]);
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

  const updatePlayhead = (sec) => {
    const line = playheadRef.current;
    if (!line) return;
    const x = (Math.max(0, Math.min(duration, sec)) / duration) * Math.max(1, contentW);
    line.style.transform = `translateX(${x}px)`;
  };

  const disconnectTrackNodes = () => {
    for (const node of trackNodesRef.current) {
      try {
        node.disconnect();
      } catch {
        // no-op
      }
    }
    trackNodesRef.current = [];
    portsAttachedRef.current = false;
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
        setSongTime(msg.sec ?? 0);
        updatePlayhead(msg.sec ?? 0);
        const viewport = viewportRef.current;
        if (viewport) {
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
        setIsPlaying(false);
        return;
      }
      if (msg.type === "ended") {
        setSongTime(msg.sec ?? 0);
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
    if (didAutoLoad || !defaultMidiUrl || !workerRef.current) return;
    setDidAutoLoad(true);
    (async () => {
      try {
        const res = await fetch(defaultMidiUrl);
        if (!res.ok) throw new Error(`Failed to fetch ${defaultMidiUrl}`);
        const buf = await res.arrayBuffer();
        workerRef.current?.postMessage({ type: "loadMidi", midiData: buf }, [buf]);
        setSongName(defaultMidiName || defaultMidiUrl.split("/").pop() || "Default MIDI");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setSongError(msg);
        onError?.(msg);
      }
    })();
  }, [didAutoLoad, defaultMidiName, defaultMidiUrl, onError]);



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
      node.connect(analyser);
      trackNodes.push(node);
    }
    trackNodesRef.current = trackNodes;

    const ports = trackNodes.map((node, index) => ({ trackIndex: index, port: node.port }));
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
  }

  return (
    <section className="card midiReader">
      <div className="midiTop">
        <label className="fileInput">
          <span>Upload MIDI</span>
          <input type="file" accept=".mid,.midi" onChange={onUploadMidi} />
        </label>
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
              <div className="midiTimelineContent" style={{ width: `${contentW}px` }}>
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
