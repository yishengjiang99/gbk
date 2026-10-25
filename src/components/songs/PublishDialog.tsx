import { useEffect, useState } from "react";
import { publishSong, suggestTitle, type SavedSong } from "../../agent/share-client.ts";
import { social, LABELS } from "../../agent/social-client.ts";

/** Publish = the user's explicit consent to make a private song public. Title is prefilled with an AI suggestion. */
export function PublishDialog({ song, onClose, onPublished }: { song: SavedSong; onClose: () => void; onPublished: (s: SavedSong) => void }) {
  const [title, setTitle] = useState(song.title); const [suggesting, setSuggesting] = useState(true); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const [labels, setLabels] = useState<string[]>([]); const [tags, setTags] = useState<string[]>([]); const [tagIn, setTagIn] = useState(""); const [sharePrompt, setSharePrompt] = useState(false); const [promptText, setPromptText] = useState("");
  useEffect(() => { let live = true; void social.promptSuggestion(song.slug).then((r) => { if (live && r.prompt) setPromptText(r.prompt); }); return () => { live = false; }; }, [song.slug]);
  const addTag = () => { const v = tagIn.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 24); if (v.length < 2 || tags.includes(v) || tags.length >= 10) { setErr(tags.length >= 10 ? "Up to 10 tags" : "Tags are 2-24 characters: a-z, 0-9, -"); return; } setErr(""); setTags([...tags, v]); setTagIn(""); };
  useEffect(() => { let live = true; void suggestTitle(song.slug).then((r) => { if (live) setTitle(r.title); }).catch(() => undefined).finally(() => { if (live) setSuggesting(false); }); return () => { live = false; }; }, [song.slug]);
  return (
    <div className="pub-backdrop" role="dialog" aria-modal="true" aria-label="Publish song" data-testid="publish-dialog">
      <div className="pub-card">
        <h3>Publish to the Feed</h3>
        <p className="ws-dim">Your song is saved privately. Publishing makes it visible to everyone in the Feed with a shareable link.</p>
        <label>Title <input data-testid="publish-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder={suggesting ? "Suggesting a title…" : "Title"} /></label>
        {suggesting && <div className="ws-dim" data-testid="publish-suggesting">AI is suggesting a title…</div>}
        <div className="ws-dim">Labels (up to 3)</div>
        <div className="pub-tags" data-testid="publish-labels">{LABELS.map((l) => <button type="button" key={l} className={`so-chip ${labels.includes(l) ? "sel" : ""} ${l === "wip" ? "wip" : ""}`} data-testid={`publish-label-${l}`} aria-pressed={labels.includes(l)} onClick={() => setLabels(labels.includes(l) ? labels.filter((x) => x !== l) : labels.length < 3 ? [...labels, l] : labels)}>{l}</button>)}</div>
        <div className="ws-dim">Tags ({tags.length}/10)</div>
        <div className="pub-tags">{tags.map((t) => <button type="button" key={t} className="so-chip sel" onClick={() => setTags(tags.filter((x) => x !== t))} aria-label={`Remove tag ${t}`}>#{t} ✕</button>)}</div>
        <div className="pub-tagrow"><input data-testid="publish-tag-input" value={tagIn} maxLength={24} placeholder="add a tag" onChange={(e) => setTagIn(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }} /><button type="button" data-testid="publish-tag-add" onClick={addTag}>Add</button></div>
        <label className="pub-share-prompt"><input type="checkbox" data-testid="publish-share-prompt" checked={sharePrompt} onChange={(e) => setSharePrompt(e.target.checked)} /> Share the prompt I used (others can Remix it)</label>
        {sharePrompt && <textarea data-testid="publish-prompt-text" rows={3} maxLength={4000} value={promptText} placeholder="The prompt to share (edit out anything private)" onChange={(e) => setPromptText(e.target.value)} />}
        {err && <div className="cmp-error">{err}</div>}
        <div className="pub-actions">
          <button onClick={onClose} data-testid="publish-cancel">Keep private</button>
          <button className="pub-primary" data-testid="publish-confirm" disabled={busy || !title.trim()} onClick={async () => { setBusy(true); setErr(""); try { const p = await publishSong(song.slug, title.trim()); const shareP = sharePrompt && !!promptText.trim(); if (labels.length || tags.length || shareP) await social.setMeta(p.slug, { labels, tags, ...(shareP ? { prompt_shared: true, prompt_text: promptText.trim() } : {}) }); onPublished(p); } catch (e) { setErr((e as Error).message); setBusy(false); } }}>{busy ? "Publishing…" : "Publish"}</button>
        </div>
      </div>
    </div>
  );
}
