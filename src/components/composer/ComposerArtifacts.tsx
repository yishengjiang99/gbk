import { useEffect, useState } from "react";
import { artifactStore } from "../../audio/artifact-store.ts";
import type { ArtifactRef } from "../../agent/protocol.ts";

/** Artifacts produced in this conversation: play inline / download. Audio stays in this browser (IndexedDB). */
export function ComposerArtifacts({ artifacts }: { artifacts: ArtifactRef[] }) {
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let live = true;
    void Promise.all(artifacts.map(async (a) => [a.artifactId, await artifactStore().objectUrl(a.artifactId).catch(() => null)] as const)).then((xs) => { if (live) setUrls(Object.fromEntries(xs)); });
    return () => { live = false; };
  }, [artifacts.map((a) => a.artifactId).join(",")]);
  if (!artifacts.length) return null;
  return (
    <div className="cmp-artifacts" data-testid="composer-artifacts">
      {artifacts.map((a) => (
        <div key={a.artifactId} className="cmp-artifact" data-testid="composer-artifact" data-artifact-id={a.artifactId}>
          <div><b>WAV</b> {a.filename ?? a.artifactId} · {a.durationSeconds?.toFixed(1)} s · {a.bytes ? `${(a.bytes / 1048576).toFixed(1)} MB` : ""}</div>
          {urls[a.artifactId] ? <><audio controls preload="none" src={urls[a.artifactId]!} /> <a href={urls[a.artifactId]!} download={a.filename ?? `${a.artifactId}.wav`}>Download</a></> : <span className="ws-dim">artifact not in this browser's storage</span>}
          {a.sha256 && <div className="ws-dim">sha256 {a.sha256.slice(0, 16)}…</div>}
        </div>
      ))}
    </div>
  );
}
