import { useEffect, useState } from "react";
import { workstation } from "../../workstation/instance.ts";
import { autosaveProject, uploadMedia, type SavedSong, type ShareInfo } from "../../agent/share-client.ts";
import { songAutosaver } from "../../agent/autosave.ts";
import { artifactStore } from "../../audio/artifact-store.ts";
import { PublishDialog } from "../songs/PublishDialog.tsx";
import { MySongs } from "../songs/MySongs.tsx";
import type { Project } from "../../workstation/model.ts";
import { appUrl } from "../../agent/routes.ts";

/** Share / Fork controls + the owner's shared songs (unshare / delete). */
/** Share = save privately + the Publish dialog (nothing goes public without its confirm). Also Fork and My songs. */
export function SharePanel({ project, readOnly, authenticated, publishRequest = 0 }: { project: Project; readOnly: string | null; authenticated: boolean; publishRequest?: number }) {
  const [busy, setBusy] = useState(false); const [last, setLast] = useState<ShareInfo | null>(null); const [err, setErr] = useState("");
  const [dialog, setDialog] = useState<SavedSong | null>(null); const [rk, setRk] = useState(0);
  const from = project.meta?.sharedFrom; const forkOf = project.meta?.forkOf;
  const openPublish = async () => {
    setBusy(true); setErr("");
    try {
      let song = await songAutosaver.flush(true);
      if (!song) { // a song the auto-saver does not track (e.g. the user's own import): save it privately on this explicit click
        song = await autosaveProject(workstation.project); songAutosaver.adopt(workstation.project.id, song, workstation.project.revision);
        const arts = (await artifactStore().list().catch(() => [])).filter((a) => a.projectId === workstation.project.id);
        for (const kind of ["wav", "midi"] as const) { const a = arts.find((x) => x.kind === kind); if (a) await uploadMedia(song.slug, kind, await artifactStore().blob(a.id), kind === "wav" && a.wav ? { durationSeconds: a.wav.durationSeconds } : undefined).catch(() => undefined); }
      }
      setDialog(song);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  // The Composer asks for the Publish dialog when an agent run finishes on a saved song.
  useEffect(() => { if (publishRequest && authenticated && !readOnly && project.tracks.length) void openPublish(); }, [publishRequest]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="cmp-share" data-testid="share-panel">
      {readOnly && from && (
        <div className="cmp-readonly" data-testid="readonly-banner" role="status">
          Viewing <b>{from.title}</b> by {from.owner} (read-only){from.parentSlug ? <> · forked from <a href={appUrl(`s/${from.parentSlug}`)}>{from.parentSlug}</a></> : null}.
          <button data-testid="fork-btn" onClick={() => workstation.fork()}>Fork</button>
        </div>
      )}
      {!readOnly && forkOf && <div className="ws-dim" data-testid="forked-from">forked from <a href={appUrl(`s/${forkOf}`)}>{forkOf}</a> · your fork is private until you publish it</div>}
      {authenticated && !readOnly && (
        <button data-testid="share-btn" disabled={busy || !project.tracks.length} onClick={() => void openPublish()}>
          {busy ? "Saving…" : "Publish…"}
        </button>
      )}
      {authenticated && !readOnly && <span className="ws-dim"> songs you make with the Composer are saved privately in My songs; Publish puts one on Explore</span>}
      {last && <div data-testid="share-link">Link: <a href={last.url} target="_blank" rel="noreferrer">{last.url}</a> <button onClick={() => void navigator.clipboard?.writeText(last.url ?? "")}>Copy</button></div>}
      {err && <div className="cmp-error">{err}</div>}
      {authenticated && <details data-testid="my-songs-studio"><summary>My songs</summary><MySongs compact refreshKey={rk} /></details>}
      {dialog && <PublishDialog song={dialog} onClose={() => { setDialog(null); setRk((x) => x + 1); }} onPublished={(s) => { setDialog(null); setLast(s); setRk((x) => x + 1); }} />}
    </section>
  );
}
