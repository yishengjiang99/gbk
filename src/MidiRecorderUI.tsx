import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { createMidiDriver, type MidiDriver, type MidiStateChange } from "./midi-driver";
import { createMidiRecorder, type MidiRecorderSnapshot } from "./midi-recorder";
import { runBatchBenchmark, type BenchmarkResult } from "./midi-recorder-benchmark";
import type { WorkerStats } from "./midi-recorder.worker";
import MidiRecorderWorker from "./midi-recorder.worker.ts?worker";

export function MidiRecorderUI(): JSX.Element {
  const workerRef = useRef<Worker | null>(null);
  const driverRef = useRef<MidiDriver | null>(null);
  const permissionRef = useRef<Promise<MidiDriver> | null>(null);
  const recorderRef = useRef<ReturnType<typeof createMidiRecorder> | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [snapshot, setSnapshot] = useState<MidiRecorderSnapshot | null>(null);
  const [inputs, setInputs] = useState<MidiStateChange["inputs"]>([]);
  const [selectedInput, setSelectedInput] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkResult[] | null>(null);
  const [workerStats, setWorkerStats] = useState<WorkerStats | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const unmountedRef = useRef(false);

  const worker = useMemo(() => {
    const w = new MidiRecorderWorker();
    workerRef.current = w;
    return w;
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    const w = worker;
    const handleMessage = (event: MessageEvent<{ type: string; stats?: WorkerStats }>) => {
      if (event.data.type === "stats" && event.data.stats) {
        setWorkerStats(event.data.stats);
      }
    };
    w.addEventListener("message", handleMessage);
    return () => {
      unmountedRef.current = true;
      w.removeEventListener("message", handleMessage);
      if (recorderRef.current) {
        recorderRef.current.stop();
        recorderRef.current = null;
      }
      if (driverRef.current) {
        driverRef.current.disconnect();
        driverRef.current = null;
      }
      permissionRef.current = null;
      w.terminate();
      workerRef.current = null;
    };
  }, [worker]);

  const createRecorder = (): ReturnType<typeof createMidiRecorder> => {
    worker.postMessage({ type: "reset" });
    return createMidiRecorder({ worker, batchSize: 32 });
  };

  const requestStats = (): void => {
    worker.postMessage({ type: "stats" });
  };

  const onToggleMidi = async (): Promise<void> => {
    if (isLoading) return;
    setError(null);

    if (driverRef.current) {
      driverRef.current.disconnect();
      driverRef.current = null;
      permissionRef.current = null;
      setInputs([]);
      return;
    }

    setIsLoading(true);
    try {
      const permissionPromise = createMidiDriver({
        onStateChange: (state) => {
          if (unmountedRef.current) return;
          setInputs(state.inputs);
        },
        onRawMessage: (timestampMs, data) => {
          if (unmountedRef.current) return;
          recorderRef.current?.recordMessage(timestampMs, data);
        },
        selectedInputId: selectedInput,
      });
      permissionRef.current = permissionPromise;
      const driver = await permissionPromise;
      if (unmountedRef.current) {
        driver.disconnect();
        return;
      }
      driverRef.current = driver;
    } catch (err) {
      if (!unmountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (!unmountedRef.current) {
        setIsLoading(false);
      }
    }
  };

  const onStart = (): void => {
    if (recorderRef.current) {
      recorderRef.current.stop();
    }
    const recorder = createRecorder();
    recorderRef.current = recorder;
    recorder.start();
    setIsRecording(true);
    setSnapshot(recorder.snapshot());
    setBenchmark(null);
    setWorkerStats(null);
  };

  const onStop = (): void => {
    recorderRef.current?.stop();
    setIsRecording(false);
    if (recorderRef.current) {
      setSnapshot(recorderRef.current.snapshot());
    }
    requestStats();
  };

  const onDownload = (): void => {
    recorderRef.current?.download();
  };

  const onBenchmark = async (): Promise<void> => {
    setBenchmark(null);
    setError(null);
    try {
      const results = await runBatchBenchmark();
      if (unmountedRef.current) return;
      setBenchmark(results);
      requestStats();
    } catch (err) {
      if (!unmountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  useEffect(() => {
    if (!driverRef.current) return;
    driverRef.current.setSelectedInput(selectedInput);
  }, [selectedInput]);

  useEffect(() => {
    const id = setInterval(() => {
      if (recorderRef.current && isRecording) {
        setSnapshot(recorderRef.current.snapshot());
      }
    }, 200);
    return () => clearInterval(id);
  }, [isRecording]);

  const handleInputChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    setSelectedInput(e.target.value);
  };

  return (
    <div className="midi-recorder-ui">
      <h2>MIDI Recorder</h2>
      {error && <div className="recorder-error">{error}</div>}

      <div className="recorder-controls">
        <button onClick={onToggleMidi} disabled={isLoading}>
          {driverRef.current ? "Disconnect MIDI" : isLoading ? "Requesting…" : "Connect MIDI"}
        </button>

        {inputs.length > 0 && (
          <select value={selectedInput} onChange={handleInputChange}>
            <option value="all">All inputs</option>
            {inputs.map((input) => (
              <option key={input.id} value={input.id}>
                {input.name}
              </option>
            ))}
          </select>
        )}

        <button onClick={isRecording ? onStop : onStart}>{isRecording ? "Stop" : "Record"}</button>
        <button onClick={onDownload} disabled={!recorderRef.current || isRecording}>
          Download JSON
        </button>
        <button onClick={onBenchmark}>Benchmark</button>
      </div>

      {snapshot && (
        <div className="recorder-stats">
          <div>State: {snapshot.state}</div>
          <div>Active notes: {snapshot.activeNotes.length}</div>
          <div>Recorded events: {snapshot.recordedCount}</div>
          {snapshot.sentCount != null && <div>Sent to worker: {snapshot.sentCount}</div>}
        </div>
      )}

      {workerStats && (
        <div className="worker-stats">
          <h3>Worker stats</h3>
          <div>Received events: {workerStats.receivedEvents}</div>
          <div>Received bytes: {workerStats.receivedBytes}</div>
          <div>Received batches: {workerStats.receivedBatches}</div>
          <div>Duration: {workerStats.durationMs.toFixed(2)} ms</div>
          <div>p50 latency: {workerStats.p50LatencyMs.toFixed(3)} ms</div>
          <div>p99 latency: {workerStats.p99LatencyMs.toFixed(3)} ms</div>
        </div>
      )}

      {benchmark && (
        <div className="benchmark-results">
          <h3>Batch benchmark</h3>
          <table>
            <thead>
              <tr>
                <th>Batch size</th>
                <th>Messages</th>
                <th>Total ms</th>
                <th>p99 latency ms</th>
                <th>Recommended</th>
              </tr>
            </thead>
            <tbody>
              {benchmark.map((r) => (
                <tr key={r.batchSize}>
                  <td>{r.batchSize}</td>
                  <td>{r.messageCount}</td>
                  <td>{r.totalTimeMs.toFixed(2)}</td>
                  <td>{r.p99LatencyMs.toFixed(3)}</td>
                  <td>{r.recommended ? "✓" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
