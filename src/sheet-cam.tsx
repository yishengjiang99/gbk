import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { parseSF2, type SF2Data, type SF2Region } from "../sf2-parser.ts";
import {
  isSupportedSheetMusicImageFile,
  parseSheetMusicWithLayout,
  type ParsedSheetMusicWithLayout,
} from "./sheet-music-reader.ts";
import type { Song } from "./midi-timer.worker.ts";
import sf2ProcessorUrl from "./sf2-processor.ts?worker&url";
import "./sheet-cam.css";

type Phase = "camera" | "scanning" | "ready";
type CameraState = "idle" | "starting" | "live" | "denied" | "unsupported" | "error";

const SF2_URL = `${import.meta.env.BASE_URL}static/GeneralUser-GS.sf2`;

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface PresetRow {
  preset: number;
  bank: number;
}

function resolvePresetIndex(sf2: SF2Data, program: number, bank: number): number | null {
  const rows = (sf2.pdta.phdr.slice(0, -1) as PresetRow[]) ?? [];
  const exact = rows.findIndex((p) => p.preset === program && p.bank === bank);
  if (exact >= 0) return exact;
  const bankZero = rows.findIndex((p) => p.preset === program && p.bank === 0);
  if (bankZero >= 0) return bankZero;
  const anyProgram = rows.findIndex((p) => p.preset === program);
  return anyProgram >= 0 ? anyProgram : null;
}

function PlayIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  );
}

function SheetCam() {
  const [phase, setPhase] = useState<Phase>("camera");
  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [cameraError, setCameraError] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [scan, setScan] = useState<ParsedSheetMusicWithLayout | null>(null);
  const [scanError, setScanError] = useState("");
  const [songTime, setSongTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState("");
  const [audioError, setAudioError] = useState("");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const sf2Ref = useRef<SF2Data | null>(null);
  const regionCacheRef = useRef(new Map<number, SF2Region[]>());
  const workerRef = useRef<Worker | null>(null);
  const trackNodesRef = useRef<AudioWorkletNode[]>([]);
  const songRef = useRef<Song | null>(null);
  const songTimeRef = useRef(0);
  const isPlayingRef = useRef(false);
  const scanRef = useRef<ParsedSheetMusicWithLayout | null>(null);
  const songLoadedResolveRef = useRef<((song: Song) => void) | null>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState("unsupported");
      return;
    }
    setCameraState("starting");
    setCameraError("");
    const attempts: MediaStreamConstraints[] = [
      { video: { facingMode: { exact: "environment" } }, audio: false },
      { video: { facingMode: "environment" }, audio: false },
      { video: true, audio: false },
    ];
    let lastErr: unknown = null;
    for (const constraints of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = stream;
        setCameraState("live");
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    const name = lastErr instanceof DOMException ? lastErr.name : "";
    setCameraError(lastErr instanceof Error ? lastErr.message : String(lastErr));
    setCameraState(name === "NotAllowedError" ? "denied" : "error");
  }, [stopCamera]);

  // Attach the live stream once the <video> element is rendered.
  useEffect(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (video && stream && cameraState === "live" && !video.srcObject) {
      video.srcObject = stream;
      video.play().catch(() => undefined);
    }
  }, [cameraState, phase]);

  useEffect(() => {
    void startCamera();
    return () => {
      stopCamera();
      workerRef.current?.terminate();
      workerRef.current = null;
      if (photoUrl) URL.revokeObjectURL(photoUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scanFile = useCallback(
    async (file: File) => {
      if (!isSupportedSheetMusicImageFile(file)) {
        setScanError("Please choose a JPG or PNG photo of sheet music.");
        return;
      }
      stopCamera();
      setPhotoUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });
      setScanError("");
      setScan(null);
      scanRef.current = null;
      setSongTime(0);
      songTimeRef.current = 0;
      setDuration(0);
      setIsPlaying(false);
      isPlayingRef.current = false;
      songRef.current = null;
      setPhase("scanning");
      try {
        const result = await parseSheetMusicWithLayout(file);
        scanRef.current = result;
        setScan(result);
        setPhase("ready");
      } catch (err) {
        setScanError(err instanceof Error ? err.message : String(err));
        setPhase("camera");
        void startCamera();
      }
    },
    [startCamera, stopCamera]
  );

  const capturePhoto = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      void scanFile(new File([blob], "sheet-photo.jpg", { type: "image/jpeg" }));
    }, "image/jpeg", 0.92);
  }, [scanFile]);

  const onPickFile = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) void scanFile(file);
    },
    [scanFile]
  );

  // ---- audio engine (reuses the app's SF2 synth path: sf2-processor worklet + MIDI worker) ----

  const ensureAudio = useCallback(async (): Promise<AudioContext> => {
    let ctx = audioCtxRef.current;
    if (!ctx || ctx.state === "closed") {
      ctx = new AudioContext();
      audioCtxRef.current = ctx;
      await ctx.audioWorklet.addModule(sf2ProcessorUrl);
      const master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      masterGainRef.current = master;
    }
    if (ctx.state !== "running") await ctx.resume();
    return ctx;
  }, []);

  const ensureSf2 = useCallback(async (): Promise<SF2Data> => {
    if (sf2Ref.current) return sf2Ref.current;
    setStatus("Downloading piano sound…");
    try {
      const res = await fetch(SF2_URL);
      if (!res.ok) throw new Error(`SoundFont download failed (HTTP ${res.status})`);
      const buf = await res.arrayBuffer();
      const parsed = parseSF2(new Uint8Array(buf));
      sf2Ref.current = parsed;
      return parsed;
    } finally {
      setStatus("");
    }
  }, []);

  const getRegions = useCallback((sf2: SF2Data, presetIndex: number): SF2Region[] => {
    const cached = regionCacheRef.current.get(presetIndex);
    if (cached) return cached;
    const regions = sf2.buildRegionsForPreset(presetIndex, {
      decodeToFloat32: true,
      normalize: true,
      includeStereoLinks: true,
    });
    regionCacheRef.current.set(presetIndex, regions);
    return regions;
  }, []);

  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;
    const worker = new Worker(new URL("./midi-timer.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type: string; [key: string]: unknown };
      if (msg.type === "songLoaded") {
        const loaded = msg.song as Song;
        songRef.current = loaded;
        setDuration(loaded.durationSec);
        songTimeRef.current = 0;
        setSongTime(0);
        songLoadedResolveRef.current?.(loaded);
        songLoadedResolveRef.current = null;
        return;
      }
      if (msg.type === "tick") {
        const sec = (msg.sec as number) ?? 0;
        songTimeRef.current = sec;
        setSongTime(sec);
        return;
      }
      if (msg.type === "paused" || msg.type === "ended") {
        const sec = (msg.sec as number) ?? 0;
        songTimeRef.current = sec;
        setSongTime(sec);
        setIsPlaying(false);
        isPlayingRef.current = false;
        return;
      }
      if (msg.type === "programChangeRequest") {
        const sf2 = sf2Ref.current;
        if (!sf2) return;
        const presetIndex =
          resolvePresetIndex(sf2, msg.program as number, msg.bank as number) ??
          resolvePresetIndex(sf2, 0, 0) ??
          0;
        worker.postMessage({
          type: "setTrackPreset",
          trackIndex: msg.trackIndex,
          presetIndex,
          override: false,
          regions: getRegions(sf2, presetIndex),
        });
        return;
      }
      if (msg.type === "error") {
        setAudioError((msg.message as string) || "Playback error");
      }
    };
    workerRef.current = worker;
    return worker;
  }, [getRegions]);

  const attachTrackNodes = useCallback(
    async (ctx: AudioContext, loaded: Song, sf2: SF2Data) => {
      for (const node of trackNodesRef.current) {
        try {
          node.disconnect();
        } catch {
          /* already disconnected */
        }
      }
      const master = masterGainRef.current;
      if (!master) throw new Error("Audio output is not ready");
      const nodes: AudioWorkletNode[] = [];
      for (let i = 0; i < loaded.tracks.length; i += 1) {
        const node = new AudioWorkletNode(ctx, "sf2-processor", {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        node.connect(master);
        nodes.push(node);
      }
      trackNodesRef.current = nodes;
      const worker = ensureWorker();
      const ports = nodes.map((node, trackIndex) => ({ trackIndex, port: node.port }));
      worker.postMessage({ type: "attachPorts", ports }, ports.map((p) => p.port));
      for (const track of loaded.tracks) {
        const programEvent = track.playEvents.find((e) => e.type === "program");
        const presetIndex =
          resolvePresetIndex(
            sf2,
            programEvent && programEvent.type === "program" ? programEvent.program : 0,
            programEvent && programEvent.type === "program" ? programEvent.bank : 0
          ) ?? 0;
        worker.postMessage({
          type: "setTrackPreset",
          trackIndex: track.index,
          presetIndex,
          override: false,
          regions: getRegions(sf2, presetIndex),
        });
      }
    },
    [ensureWorker, getRegions]
  );

  const waitForSongLoaded = useCallback((): Promise<Song> => {
    if (songRef.current) return Promise.resolve(songRef.current);
    return new Promise<Song>((resolve) => {
      songLoadedResolveRef.current = resolve;
    });
  }, []);

  const handlePlayPause = useCallback(async () => {
    if (isPlayingRef.current) {
      workerRef.current?.postMessage({ type: "pause" });
      return;
    }
    const result = scanRef.current;
    if (!result) return;
    try {
      setAudioError("");
      const ctx = await ensureAudio();
      const sf2 = await ensureSf2();
      const worker = ensureWorker();
      if (!songRef.current) {
        setStatus("Preparing playback…");
        try {
          const copy = result.midiData.slice(0);
          worker.postMessage({ type: "loadMidi", midiData: copy }, [copy]);
          const loaded = await waitForSongLoaded();
          await attachTrackNodes(ctx, loaded, sf2);
        } finally {
          setStatus("");
        }
      }
      setIsPlaying(true);
      isPlayingRef.current = true;
      worker.postMessage({ type: "play", startSec: songTimeRef.current });
    } catch (err) {
      setAudioError(err instanceof Error ? err.message : String(err));
      setIsPlaying(false);
      isPlayingRef.current = false;
      setStatus("");
    }
  }, [ensureAudio, ensureSf2, ensureWorker, attachTrackNodes, waitForSongLoaded]);

  const handleSeek = useCallback((sec: number) => {
    const loaded = songRef.current;
    if (!loaded) return;
    const clamped = Math.max(0, Math.min(loaded.durationSec, sec));
    songTimeRef.current = clamped;
    setSongTime(clamped);
    workerRef.current?.postMessage({ type: "seek", sec: clamped });
  }, []);

  const rescan = useCallback(() => {
    workerRef.current?.postMessage({ type: "pause" });
    setIsPlaying(false);
    isPlayingRef.current = false;
    setScanError("");
    setPhase("camera");
    void startCamera();
  }, [startCamera]);

  // ---- note highlighting: same worker clock that schedules the notes ----
  const activeNoteIndexes = useMemo(() => {
    const active = new Set<number>();
    if (!scan) return active;
    scan.noteLayout.forEach((note, index) => {
      if (songTime >= note.startSec && songTime < note.endSec) active.add(index);
    });
    return active;
  }, [scan, songTime]);

  return (
    <div className="sc-screen">
      <header className="sc-header">
        <div>
          <h1>Sheet Cam</h1>
          <div className="sc-sub">
            {phase === "camera" && "Point at sheet music, then capture"}
            {phase === "scanning" && "Reading the notes…"}
            {phase === "ready" && `${scan?.noteLayout.length ?? 0} notes detected`}
          </div>
        </div>
        {phase === "ready" && (
          <button type="button" className="sc-btn ghost" onClick={rescan}>
            Scan again
          </button>
        )}
      </header>

      {phase === "camera" && (
        <>
          <div className="sc-viewfinder">
            {cameraState === "live" && <video ref={videoRef} playsInline autoPlay muted />}
            <div className="sc-frame" />
          </div>
          {(cameraState === "denied" || cameraState === "unsupported" || cameraState === "error") && (
            <div className="sc-notice warn" role="alert">
              {cameraState === "denied" &&
                "Camera access was denied. Allow camera access in your browser settings, or use a photo instead."}
              {cameraState === "unsupported" && "This browser can't open the camera here. Use a photo instead."}
              {cameraState === "error" && `Couldn't start the camera (${cameraError || "unknown error"}). Use a photo instead.`}
            </div>
          )}
          {scanError && (
            <div className="sc-notice" role="alert">
              {scanError}
            </div>
          )}
          <div className="sc-controls">
            <button
              type="button"
              className="sc-btn"
              onClick={() => fileInputRef.current?.click()}
            >
              Use photo
            </button>
            <button
              type="button"
              className="sc-shutter"
              aria-label="Capture sheet music"
              onClick={capturePhoto}
              disabled={cameraState !== "live"}
            />
            <button type="button" className="sc-btn" onClick={() => void startCamera()}>
              Retry camera
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: "none" }}
            onChange={onPickFile}
          />
        </>
      )}

      {phase === "scanning" && (
        <div className="sc-scan-stage">
          {photoUrl && <img src={photoUrl} alt="Captured sheet music" />}
          <div className="sc-spinner" aria-hidden="true" />
          <div className="sc-status">Scanning the sheet music…</div>
        </div>
      )}

      {phase === "ready" && scan && (
        <>
          <div className="sc-stage">
            <div className="sc-sheet-wrap">
              {photoUrl && <img src={photoUrl} alt="Scanned sheet music" />}
              {scan.noteLayout.map((note, index) => (
                <div
                  key={index}
                  className={activeNoteIndexes.has(index) ? "sc-note-box active" : "sc-note-box"}
                  style={{
                    left: `${(note.bbox.x / scan.imageWidth) * 100}%`,
                    top: `${(note.bbox.y / scan.imageHeight) * 100}%`,
                    width: `${(note.bbox.w / scan.imageWidth) * 100}%`,
                    height: `${(note.bbox.h / scan.imageHeight) * 100}%`,
                  }}
                />
              ))}
            </div>
          </div>
          <div className="sc-transport">
            <div className="sc-transport-row">
              <button
                type="button"
                className="sc-play"
                aria-label={isPlaying ? "Pause" : "Play"}
                onClick={() => void handlePlayPause()}
              >
                {isPlaying ? <PauseIcon /> : <PlayIcon />}
              </button>
              <span className="sc-time">
                {fmtTime(songTime)} / {fmtTime(duration)}
              </span>
              <input
                type="range"
                className="sc-seek"
                min={0}
                max={Math.max(0.1, duration)}
                step={0.1}
                value={Math.min(songTime, duration)}
                onChange={(e) => handleSeek(Number(e.target.value))}
                aria-label="Seek"
              />
            </div>
            {(status || audioError) && (
              <div className={`sc-status${audioError ? " sc-error" : ""}`}>{audioError || status}</div>
            )}
            {scan.warnings.length > 0 && (
              <div className="sc-warnings">{scan.warnings.join(" ")}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SheetCam />
  </React.StrictMode>
);
