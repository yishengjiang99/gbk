import { useEffect, useState } from "react";
import { renderJobs, type RenderJob } from "../../audio/render-job.ts";
import { artifactStore, type ArtifactMeta } from "../../audio/artifact-store.ts";

const STAGE: Record<string, string> = { queued: "Queued", loading: "Loading SoundFont / resolving instruments", rendering: "Rendering audio", encoding: "Encoding WAV", validating: "Validating output", saving: "Saving artifact", completed: "Completed", failed: "Failed", cancelled: "Cancelled" };
const fmtBytes = (n: number) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);

/** Render jobs (live state) and persisted artifacts with real download links. */
export function ArtifactPanel() {
  const [jobs, setJobs] = useState<RenderJob[]>(() => renderJobs().list());
  const [arts, setArts] = useState<ArtifactMeta[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  useEffect(() => renderJobs().subscribe(() => setJobs(renderJobs().list())), []);
  useEffect(() => {
    const load = () => artifactStore().list().then(async (list) => {
      setArts(list);
      const u: Record<string, string> = {};
      for (const a of list.slice(0, 20)) { try { u[a.id] = await artifactStore().objectUrl(a.id); } catch { /* storage unavailable */ } }
      setUrls(u);
    }).catch((e) => setError((e as Error).message));
    void load();
    return artifactStore().subscribe(() => void load());
  }, []);
  const active = jobs.filter((j) => !["completed", "failed", "cancelled"].includes(j.status) || Date.now() - (j.finishedAt ?? 0) < 60_000).slice(0, 4);
  const wavs = arts.filter((a) => a.kind === "wav");
  const midiFor = (w: ArtifactMeta) => arts.find((m) => m.kind === "midi" && m.projectId === w.projectId && m.revision === w.revision);
  return (
    <section className="ws-artifacts" data-testid="artifact-panel" aria-label="Renders and artifacts">
      <h4>Renders</h4>
      {active.length === 0 && <div className="ws-dim">No render running.</div>}
      {active.map((j) => (
        <div key={j.id} className={`ws-job ${j.status}`} data-testid={`render-job-${j.id}`} data-status={j.status}>
          <div className="ws-row"><b>{j.projectName}</b> <span className="ws-dim">rev {j.revision}</span></div>
          <div className="ws-dim">{STAGE[j.status] ?? j.status} · {Math.round(j.progress * 100)}%</div>
          <div className="ws-progress"><div style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>
          {j.error && <div className="ws-warn">{j.error.code}: {j.error.message}</div>}
          {!["completed", "failed", "cancelled"].includes(j.status) && <button onClick={() => renderJobs().cancel(j.id)}>Cancel</button>}
        </div>
      ))}
      <h4>Artifacts ({wavs.length})</h4>
      {error && <div className="ws-warn">{error}</div>}
      <ul className="ws-artifact-list">
        {wavs.slice(0, 12).map((a) => {
          const m = midiFor(a);
          return (
            <li key={a.id} data-testid={`artifact-${a.id}`}>
              <div><b>{a.filename}</b></div>
              <div className="ws-dim">WAV {a.wav?.format?.toUpperCase()} · {a.wav?.durationSeconds.toFixed(1)} s · {a.wav ? `${a.wav.sampleRate / 1000} kHz ${a.wav.channels === 2 ? "stereo" : "mono"}` : ""} · {fmtBytes(a.bytes)}</div>
              <div className="ws-dim">peak {a.wav?.peakDbFS} dBFS · RMS {a.wav?.rmsDbFS} dBFS{a.wav?.clippedSamples ? ` · ${a.wav.clippedSamples} clipped` : ""} · {new Date(a.createdAt).toLocaleTimeString()}</div>
              <div className="ws-row">
                {urls[a.id] && <a href={urls[a.id]} download={a.filename} data-testid="artifact-download-wav">Download WAV</a>}
                {m && urls[m.id] && <a href={urls[m.id]} download={m.filename} data-testid="artifact-download-midi">Download MIDI</a>}
                <button onClick={() => void artifactStore().delete(a.id).catch((e) => setError((e as Error).message))}>Delete</button>
              </div>
              {urls[a.id] && <audio controls preload="none" src={urls[a.id]} style={{ width: "100%", height: 28 }} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
