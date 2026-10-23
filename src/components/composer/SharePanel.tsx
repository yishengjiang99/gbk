import { useEffect, useState } from "react";
import { workstation } from "../../workstation/instance.ts";
import { deleteShare, listShares, setSharePublic, shareCurrent, type ShareInfo } from "../../agent/share-client.ts";
import type { Project } from "../../workstation/model.ts";
import { appUrl } from "../../agent/routes.ts";

/** Share / Fork controls + the owner's shared songs (unshare / delete). */
export function SharePanel({ project, readOnly, authenticated }: { project: Project; readOnly: string | null; authenticated: boolean }) {
  const [busy, setBusy] = useState(false); const [last, setLast] = useState<ShareInfo | null>(null); const [err, setErr] = useState(""); const [mine, setMine] = useState<ShareInfo[]>([]);
  const refresh = () => { if (authenticated) void listShares(0, 20, true).then(setMine).catch(() => undefined); };
  useEffect(refresh, [authenticated]);
  const from = project.meta?.sharedFrom; const forkOf = project.meta?.forkOf;
  return (
    <section className="cmp-share" data-testid="share-panel">
      {readOnly && from && (
        <div className="cmp-readonly" data-testid="readonly-banner" role="status">
          Viewing <b>{from.title}</b> by {from.owner} (read-only){from.parentSlug ? <> · forked from <a href={appUrl(`s/${from.parentSlug}`)}>{from.parentSlug}</a></> : null}.
          <button data-testid="fork-btn" onClick={() => workstation.fork()}>Fork</button>
        </div>
      )}
      {!readOnly && forkOf && <div className="ws-dim" data-testid="forked-from">forked from <a href={appUrl(`s/${forkOf}`)}>{forkOf}</a></div>}
      {authenticated && !readOnly && (
        <button data-testid="share-btn" disabled={busy || !project.tracks.length} onClick={async () => { setBusy(true); setErr(""); try { const s = await shareCurrent(); setLast(s); refresh(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }}>
          {busy ? "Sharing…" : "Share"}
        </button>
      )}
      {authenticated && !readOnly && <span className="ws-dim"> uploads this song (notes, settings, latest WAV/MIDI) so anyone with the link can listen and fork</span>}
      {last && <div data-testid="share-link">Link: <a href={last.url} target="_blank" rel="noreferrer">{last.url}</a> <button onClick={() => void navigator.clipboard?.writeText(last.url ?? "")}>Copy</button></div>}
      {err && <div className="cmp-error">{err}</div>}
      {mine.length > 0 && (
        <details><summary>My shared songs ({mine.length})</summary>
          <ul className="cmp-mine">{mine.map((s) => (
            <li key={s.slug}><a href={appUrl(`s/${s.slug}`)}>{s.title}</a> {s.public ? "" : <i>(unshared)</i>}
              <button onClick={() => void setSharePublic(s.slug, !s.public).then(refresh)}>{s.public ? "Unshare" : "Reshare"}</button>
              <button onClick={() => { if (confirm(`Delete "${s.title}" from the server?`)) void deleteShare(s.slug).then(refresh); }}>Delete</button></li>))}
          </ul></details>
      )}
    </section>
  );
}
