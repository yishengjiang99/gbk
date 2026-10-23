import { useEffect, useState } from "react";
import { publishSong, suggestTitle, type SavedSong } from "../../agent/share-client.ts";

/** Publish = the user's explicit consent to make a private song public. Title is prefilled with an AI suggestion. */
export function PublishDialog({ song, onClose, onPublished }: { song: SavedSong; onClose: () => void; onPublished: (s: SavedSong) => void }) {
  const [title, setTitle] = useState(song.title); const [suggesting, setSuggesting] = useState(true); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  useEffect(() => { let live = true; void suggestTitle(song.slug).then((r) => { if (live) setTitle(r.title); }).catch(() => undefined).finally(() => { if (live) setSuggesting(false); }); return () => { live = false; }; }, [song.slug]);
  return (
    <div className="pub-backdrop" role="dialog" aria-modal="true" aria-label="Publish song" data-testid="publish-dialog">
      <div className="pub-card">
        <h3>Publish to Explore</h3>
        <p className="ws-dim">Your song is saved privately. Publishing makes it visible to everyone on Explore with a shareable link.</p>
        <label>Title <input data-testid="publish-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder={suggesting ? "Suggesting a title…" : "Title"} /></label>
        {suggesting && <div className="ws-dim" data-testid="publish-suggesting">AI is suggesting a title…</div>}
        {err && <div className="cmp-error">{err}</div>}
        <div className="pub-actions">
          <button onClick={onClose} data-testid="publish-cancel">Keep private</button>
          <button className="pub-primary" data-testid="publish-confirm" disabled={busy || !title.trim()} onClick={async () => { setBusy(true); setErr(""); try { onPublished(await publishSong(song.slug, title.trim())); } catch (e) { setErr((e as Error).message); setBusy(false); } }}>{busy ? "Publishing…" : "Publish"}</button>
        </div>
      </div>
    </div>
  );
}
