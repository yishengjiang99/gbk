import { useCallback, useEffect, useRef, useState } from "react";
import { NavMenuSection, ToolbarMenu } from "./toolbar-menu.tsx";
import { createMidiRecorder, MidiRecorderExports, RecorderState } from "./midi-recorder.ts";
import RecorderWorker from "./midi-recorder.worker.ts?worker";
import { createMidiDriver, MidiDriver } from "./midi-driver.ts";

interface MidiRecorderUIProps {
  audioCtxState: string;
  onTogglePower: () => void;
  activeTab: string;
  onSelectTab: (tab: string) => void;
}

export default function MidiRecorderUI({
  audioCtxState,
  onTogglePower,
  activeTab,
  onSelectTab,
}: MidiRecorderUIProps) {
  const [state, setState] = useState<RecorderState>("idle");
  const [midiEnabled, setMidiEnabled] = useState(false);
  const [midiStatus, setMidiStatus] = useState("MIDI disabled");
  const [midiInputs, setMidiInputs] = useState<{ id: string; name: string }[]>([]);
  const [selectedInput, setSelectedInput] = useState("all");
  const [stats, setStats] = useState<{ batches: number; events: number; latencyMs: number } | null>(
    null
  );

  const workerRef = useRef<Worker | null>(null);
  const recorderRef = useRef<MidiRecorderExports | null>(null);
  const driverRef = useRef<MidiDriver | null>(null);

  useEffect(() => {
    const worker = new RecorderWorker();
    workerRef.current = worker;
    recorderRef.current = createMidiRecorder({ worker, batchSize: 32 });
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === "stats") {
        setStats({ batches: msg.batches, events: msg.events, latencyMs: msg.latencyMs });
      }
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
      recorderRef.current = null;
    };
  }, []);

  const refreshState = useCallback(() => {
    setState(recorderRef.current?.state ?? "idle");
    setStats((prev) =>
      prev
        ? {
            ...prev,
            events: recorderRef.current?.snapshot().recordedCount ?? prev.events,
          }
        : prev
    );
  }, []);

  const onRecord = useCallback(() => {
    recorderRef.current?.start();
    refreshState();
  }, [refreshState]);

  const onStop = useCallback(() => {
    recorderRef.current?.stop();
    refreshState();
  }, [refreshState]);

  const onDownload = useCallback(() => {
    recorderRef.current?.download(`recording-${Date.now()}.json`);
  }, []);

  const onToggleMidi = useCallback(async () => {
    if (driverRef.current) {
      driverRef.current.disconnect();
      driverRef.current = null;
      setMidiEnabled(false);
      setMidiStatus("MIDI disabled");
      setMidiInputs([]);
      return;
    }
    try {
      const driver = await createMidiDriver({
        selectedInputId: selectedInput,
        onNoteOn: (note, velocity, channel) => {
          recorderRef.current?.recordMessage(performance.now(), [
            0x90 | channel,
            note,
            velocity,
          ]);
        },
        onNoteOff: (note, channel) => {
          recorderRef.current?.recordMessage(performance.now(), [0x80 | channel, note, 0]);
        },
        onStateChange: ({ connected, names, inputs }) => {
          setMidiInputs(inputs ?? []);
          setMidiStatus(
            connected === 0 ? "MIDI enabled (no inputs)" : `MIDI inputs: ${names.join(", ")}`
          );
        },
      });
      driverRef.current = driver;
      setMidiEnabled(true);
      setMidiStatus("MIDI enabled");
    } catch (err) {
      setMidiStatus(err instanceof Error ? err.message : String(err));
    }
  }, [selectedInput]);

  useEffect(() => {
    driverRef.current?.setSelectedInput(selectedInput);
  }, [selectedInput]);

  const onBenchmark = useCallback(() => {
    const worker = workerRef.current;
    const recorder = recorderRef.current;
    if (!worker || !recorder) return;

    recorder.reset();
    recorder.start();
    const start = performance.now();
    for (let i = 0; i < 5000; i++) {
      const channel = i % 16;
      const note = 60 + (i % 24);
      const status = i % 2 === 0 ? 0x90 | channel : 0x80 | channel;
      const velocity = i % 2 === 0 ? Math.max(1, i % 127) : 0;
      recorder.recordMessage(start + i * 0.1, [status, note, velocity]);
    }
    recorder.stop();
    worker.postMessage({ type: "stats" });
  }, []);

  return (
    <div className="app">
      <header className="topToolbar card">
        <div className="appHeaderToolbar toolbarUnified" aria-label="Recorder controls">
          <div className="toolbarGroup" aria-label="View">
            <span className="toolbarGroupLabel">View</span>
            <div className="toolbarButtonRow toolbarSegmented">
              <button
                type="button"
                className={`toolbarActionBtn ${activeTab === "midi" ? "active" : ""}`}
                onClick={() => onSelectTab("midi")}
              >
                <i className="fa-solid fa-music" aria-hidden="true" />
                <span>MIDI</span>
              </button>
              <button
                type="button"
                className={`toolbarActionBtn ${activeTab === "sf2" ? "active" : ""}`}
                onClick={() => onSelectTab("sf2")}
              >
                <i className="fa-solid fa-wave-square" aria-hidden="true" />
                <span>SF2</span>
              </button>
              <button
                type="button"
                className={`toolbarActionBtn ${activeTab === "recorder" ? "active" : ""}`}
                onClick={() => onSelectTab("recorder")}
              >
                <i className="fa-solid fa-record-vinyl" aria-hidden="true" />
                <span>Recorder</span>
              </button>
            </div>
          </div>

          <ToolbarMenu label="Menu" icon="fa-bars" variant="nav">
            <NavMenuSection label="Audio">
              <button
                type="button"
                className={`toolbarActionBtn ${audioCtxState === "running" ? "active" : ""}`}
                onClick={onTogglePower}
              >
                <i className="fa-solid fa-power-off" aria-hidden="true" />
                <span>{audioCtxState === "running" ? "Power Off" : "Power On"}</span>
              </button>
            </NavMenuSection>

            <NavMenuSection label="MIDI Input">
              <button
                type="button"
                className={`toolbarActionBtn ${midiEnabled ? "active" : ""}`}
                onClick={onToggleMidi}
              >
                <i className="fa-solid fa-plug" aria-hidden="true" />
                <span>{midiEnabled ? "Disable MIDI" : "Enable MIDI"}</span>
              </button>
              <select
                className="toolbarSelect"
                value={selectedInput}
                onChange={(e) => setSelectedInput(e.target.value)}
                disabled={!midiEnabled}
              >
                <option value="all">All MIDI Inputs</option>
                {midiInputs.map((input) => (
                  <option key={input.id} value={input.id}>
                    {input.name}
                  </option>
                ))}
              </select>
            </NavMenuSection>

            <NavMenuSection label="Recorder">
              <button
                type="button"
                className="toolbarActionBtn"
                onClick={onRecord}
                disabled={state === "recording"}
              >
                <i className="fa-solid fa-circle" aria-hidden="true" />
                <span>Record</span>
              </button>
              <button
                type="button"
                className="toolbarActionBtn"
                onClick={onStop}
                disabled={state !== "recording"}
              >
                <i className="fa-solid fa-stop" aria-hidden="true" />
                <span>Stop</span>
              </button>
              <button
                type="button"
                className="toolbarActionBtn"
                onClick={onDownload}
                disabled={state === "recording"}
              >
                <i className="fa-solid fa-download" aria-hidden="true" />
                <span>Download JSON</span>
              </button>
              <button type="button" className="toolbarActionBtn" onClick={onBenchmark}>
                <i className="fa-solid fa-flask" aria-hidden="true" />
                <span>Benchmark</span>
              </button>
            </NavMenuSection>
          </ToolbarMenu>
        </div>
      </header>

      <main className="layout sf2Layout">
        <section className="card sf2Panel">
          <div className="panelHead">
            <h2>MIDI Recorder</h2>
            <span className="panelBadge">{state}</span>
          </div>
          <div className="panelBody">
            <p>Enable a MIDI input, then press Record to capture a performance.</p>
            <p>Events are batched, transferred to a worker, and exported as JSON.</p>
            {stats && (
              <div className="detailBlock">
                <h3>Worker Stats</h3>
                <p>
                  <strong>Batches:</strong> {stats.batches}
                </p>
                <p>
                  <strong>Events:</strong> {stats.events}
                </p>
                <p>
                  <strong>Latency:</strong> {stats.latencyMs.toFixed(2)} ms
                </p>
              </div>
            )}
          </div>
        </section>
      </main>

      <div className="statusDock">
        <span className="midiStatus">{midiStatus}</span>
        <span className="midiStatus">Audio: {audioCtxState}</span>
      </div>
    </div>
  );
}
