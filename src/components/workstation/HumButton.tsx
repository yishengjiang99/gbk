// "🎤 Hum": hum a tune into the microphone and land it in the composition as
// a new "Hummed melody" track. Recording is local; transcription (Spotify
// Basic Pitch, ONNX) runs in a worker in the browser — no audio leaves the
// page. Insertion goes through workstation.userEdit like every human edit,
// so it is one undo step and respects read-only shares.
import { useEffect, useRef, useState } from "react";
import { workstation } from "./useWorkstation.ts";
import { newId } from "../../workstation/model.ts";
import { HumRecorder, MAX_HUM_SECONDS } from "../../hum/record.ts";
import { transcribe } from "../../hum/transcribe.ts";
import { humToOps } from "../../hum/notes-to-ops.ts";
import { reportError } from "../../telemetry/error-reporter.ts";
import { nativeHum, type HumState } from "../../hum/native-bridge.ts";

/** iOS app: the native recorder/transcriber does the work; this button only toggles it and shows its state. */
export function NativeHumButton() {
  const [st, setSt] = useState<HumState>({ phase: "idle", elapsed: 0, progress: 0 });
  useEffect(() => { const f = (e: Event) => setSt((e as CustomEvent<HumState>).detail); window.addEventListener("gbk:hum-state", f); return () => window.removeEventListener("gbk:hum-state", f); }, []);
  const toggle = () => (window as unknown as { webkit?: { messageHandlers?: { hum?: { postMessage: (m: unknown) => void } } } }).webkit?.messageHandlers?.hum?.postMessage({ type: "toggle" });
  const s = Math.floor(st.elapsed);
  return <button type="button" className="cmp-hum" data-testid="hum-btn" data-native="1" data-phase={st.phase} disabled={st.phase === "transcribing"} aria-label={st.phase === "recording" ? "Stop" : st.phase === "transcribing" ? "Transcribing" : "Hum"} onClick={toggle}>
    {st.phase === "recording" ? `⏺ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} Stop` : st.phase === "transcribing" ? `🎤 ${Math.round(st.progress * 100)}%` : "🎤 Hum"}</button>;
}

type Phase = "idle" | "recording" | "transcribing";

export function HumButton() {
  return nativeHum() ? null : <WebHumButton />; // iOS: the native button lives in the composer prompt bar
}
/** Web Hum flow (record -> transcribe in a worker -> one undoable "Hummed melody" track). `onError` gets plain text. */
export function useWebHum(onError: (msg: string) => void = (m) => alert(m)) {
  const [phase, setPhaseState] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState(0);
  const recorderRef = useRef<HumRecorder | null>(null);
  const mountedRef = useRef(true);
  // The phase as of now, not as of the last render: two taps (or a tap racing the 60 s auto-stop) before
  // React re-renders must not stop the take twice. Each take/cancel bumps the generation; stale work drops out.
  const phaseRef = useRef<Phase>("idle");
  const genRef = useRef(0);
  const setPhase = (p: Phase) => { phaseRef.current = p; setPhaseState(p); };
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; genRef.current++; recorderRef.current?.cancel(); };
  }, []);
  useEffect(() => {
    if (phase !== "recording") return;
    const t = setInterval(() => {
      const rec = recorderRef.current;
      if (!rec) return;
      setElapsed(rec.elapsed);
      if (rec.elapsed >= MAX_HUM_SECONDS) void stopAndTranscribe();
    }, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const start = async () => {
    if (phaseRef.current !== "idle") return;
    if (workstation.readOnlyReason) {
      for (const f of workstation.readOnlyHintListeners) f(workstation.readOnlyReason);
      return;
    }
    const rec = (recorderRef.current ??= new HumRecorder());
    rec.onEnded = () => void stopAndTranscribe(); // mic unplugged or taken mid-take: keep what was captured
    try {
      await rec.start();
      if (!mountedRef.current) { rec.cancel(); return; }
      if (!rec.recording || phaseRef.current !== "idle") return; // cancelled during the permission prompt
      setElapsed(0);
      setPhase("recording");
    } catch (e) {
      const err = e as Error;
      reportError(err, { where: "hum.start" });
      if (err.name === "NotAllowedError" || err.name === "SecurityError") {
        onError("Microphone access was denied. Allow microphone permission for this site in the browser, then tap Hum again.");
      } else {
        onError("Could not start recording. Check that a microphone is available and try again.");
      }
    }
  };

  const stopAndTranscribe = async () => {
    const rec = recorderRef.current;
    if (!rec || phaseRef.current !== "recording") return;
    const gen = ++genRef.current;
    const live = () => mountedRef.current && gen === genRef.current;
    setPhase("transcribing");
    setProgress(0);
    try {
      const { samples, seconds } = await rec.stop();
      if (!live()) return;
      if (seconds < 0.3 || samples.length === 0) {
        onError("That take was too short to transcribe — hum a few notes, then tap Stop.");
        return;
      }
      const notes = await transcribe(samples, (f) => { if (live()) setProgress(f); });
      if (!live()) return;
      if (!notes.length) {
        onError("No melody detected in that take — try humming a clear, single tune closer to the microphone.");
        return;
      }
      const trackId = newId("trk");
      const ops = humToOps(workstation.project, notes, trackId);
      const r = workstation.userEdit(ops, { label: "hum a melody" });
      if (r) workstation.setSelection({ trackIds: [trackId], noteIds: [] }); // null: read-only, hint already shown
    } catch (e) {
      const err = e as Error;
      reportError(err, { where: "hum.transcribe" });
      if (live()) onError("Couldn't turn that take into notes. Please try again.");
    } finally {
      if (live()) setPhase("idle");
    }
  };

  /** Discards the take, also mid-transcription (the result is dropped). */
  const cancel = () => { genRef.current++; recorderRef.current?.cancel(); setPhase("idle"); };
  return { phase, elapsed, progress, start, stop: stopAndTranscribe, cancel };
}

export function WebHumButton() {
  const { phase, elapsed, progress, start, stop: stopAndTranscribe } = useWebHum();
  if (phase === "recording") {
    const s = Math.floor(elapsed);
    return (
      <button type="button" onClick={() => void stopAndTranscribe()} aria-pressed="true" data-testid="hum-btn" data-phase="recording"
        title={`Recording… tap to stop and transcribe (max ${MAX_HUM_SECONDS}s)`}>
        ⏺ {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")} Stop
      </button>
    );
  }
  if (phase === "transcribing") {
    return (
      <button type="button" disabled aria-busy="true" data-testid="hum-btn" data-phase="transcribing" title="Transcribing the hum in your browser">
        🎤 {progress > 0 ? `${Math.round(progress * 100)}%` : "…"}
      </button>
    );
  }
  return (
    <button type="button" onClick={() => void start()} data-testid="hum-btn" data-phase="idle"
      title="Hum a tune into the microphone — it becomes a new piano track (transcribed in your browser)">
      🎤 Hum
    </button>
  );
}
