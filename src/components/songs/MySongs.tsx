import { useCallback, useEffect, useState } from "react";
import { deleteShare, listShares, openOwn, setSharePublic, type SavedSong } from "../../agent/share-client.ts";
import { songAutosaver } from "../../agent/autosave.ts";
import { appUrl, navigate } from "../../agent/routes.ts";
import { PublishDialog } from "./PublishDialog.tsx";

/** The owner's songs (private auto-saves and published ones). Only rendered for a logged-in user; the API only returns their own. */
export function MySongs({ compact = false, refreshKey = 0 }: { compact?: boolean; refreshKey?: number }) {
  const [songs, setSongs] = useState<SavedSong[] | null>(null); const [pub, setPub] = useState<SavedSong | null>(null);
  const refresh = useCallback(() => { void listShares(0, 50, true).then(setSongs).catch(() => setSongs([])); }, []);
  useEffect(() => { refresh(); return songAutosaver.on((e) => { if (!e.saving) refresh(); }); }, [refresh, refreshKey]);
  if (!songs) return null;
  return (
    <section className={compact ? "my-songs compact" : "my-songs"} data-testid="my-songs">
      <h3>My songs <span className="ws-dim">(only you see private ones)</span></h3>
      {!songs.length && <div className="ws-dim">No songs yet. Ask the AI Composer for one; it's saved here privately.</div>}
      <ul>{songs.map((s) => (
        <li key={s.slug} data-testid="my-song" data-slug={s.slug} data-public={s.public ? "1" : "0"}>
          <b>{s.title}</b> <span className={s.public ? "pill pub" : "pill priv"} data-testid="my-song-status">{s.public ? "Public" : "Private"}</span>
          <span className="ws-dim"> {new Date(s.updatedAt ?? s.createdAt).toLocaleString()}</span>
          <span className="my-actions">
            <button data-testid="my-open" onClick={async () => { await openOwn(s.slug); navigate("studio"); }}>Open</button>
            {s.public
              ? <button data-testid="my-unpublish" onClick={() => void setSharePublic(s.slug, false).then(refresh)}>Unpublish</button>
              : <button data-testid="my-publish" onClick={() => setPub(s)}>Publish</button>}
            {s.public && <a href={appUrl(`s/${s.slug}`)} data-testid="my-link">link</a>}
            <button data-testid="my-delete" onClick={() => { if (confirm(`Delete "${s.title}" from the server?`)) void deleteShare(s.slug).then(() => { songAutosaver.forget(s.slug); refresh(); }); }}>Delete</button>
          </span>
        </li>))}
      </ul>
      {pub && <PublishDialog song={pub} onClose={() => setPub(null)} onPublished={() => { setPub(null); refresh(); }} />}
    </section>
  );
}
