// Explore: what others composed (public shared songs), newest first, with play previews, Open and Fork.
import { useEffect, useRef, useState } from "react";
import { listShares, mediaUrl, getShare, topShares, type ShareInfo, type TopShare } from "../../agent/share-client.ts";
import { sanitizeSharedProject } from "../../agent/share-schema.ts";
import { renderJobs } from "../../audio/render-job.ts";
import { STARTER_PROMPTS } from "../composer/ComposerPanel.tsx";
import { MySongs } from "../songs/MySongs.tsx";
import { apiBase } from "../../agent/bridge-client.ts";
import type { PianoRollPreview } from "../../agent/piano-roll-preview.ts";

/** Tiny SVG piano roll: one bar per (downsampled) note, colored by track. */
export function PianoRoll({ p }: { p: PianoRollPreview }) {
  const span = Math.max(12, p.hi - p.lo + 1), h = 100 / span;
  return (
    <svg className="xp-roll" data-testid="card-pianoroll" viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label="piano-roll preview">
      {p.notes.map(([t, x, w, pitch], i) => <rect key={i} x={x} y={(p.hi - pitch) * h + (span - (p.hi - p.lo + 1)) * h / 2} width={Math.max(4, w)} height={Math.max(2, h * 0.85)} rx={1.5} fill={p.tracks[t] ?? "#90a4ae"} />)}
    </svg>
  );
}

const PAGE = 12;
function Preview({ s }: { s: ShareInfo }) {
  const [url, setUrl] = useState<string | null>(s.hasMp3 ? mediaUrl(s.slug, "mp3") : s.hasWav ? mediaUrl(s.slug, "wav") : null);
  const [state, setState] = useState(""); const ac = useRef<AbortController | null>(null);
  useEffect(() => () => ac.current?.abort(), []);
  if (url) return <audio controls preload="none" src={url} data-testid="card-audio" />;
  return (
    <button data-testid="card-render" disabled={!!state && state !== "failed"} onClick={async () => {
      try {
        setState("loading"); ac.current = new AbortController();
        const p = sanitizeSharedProject((await getShare(s.slug)).project);
        setState("rendering");
        const job = renderJobs().submit(p, { sampleRate: 44100, channels: 2, format: "pcm16", tailSeconds: 2 }, { saveArtifact: false, signal: ac.current.signal, keepResult: true });
        const done = await renderJobs().wait(job.id);
        const res = renderJobs().result(done.id);
        if (done.status !== "completed" || !res) throw new Error(done.error?.message ?? "render failed");
        setUrl(URL.createObjectURL(res.blob)); setState("");
      } catch { setState("failed"); }
    }}>{state === "" ? "▶ Render preview in browser" : state === "failed" ? "Preview failed — retry" : `${state}…`}</button>
  );
}

export function ExplorePage({ onCompose, onOpen }: { onCompose: (prompt?: string) => void; onOpen: (slug: string, fork: boolean) => void }) {
  const [page, setPage] = useState(0); const [items, setItems] = useState<ShareInfo[] | null>(null); const [err, setErr] = useState("");
  useEffect(() => { setItems(null); listShares(page * PAGE, PAGE + 1).then(setItems).catch((e) => setErr((e as Error).message)); }, [page]);
  const [top, setTop] = useState<TopShare[] | null>(null);
  useEffect(() => { topShares(10).then(setTop).catch(() => setTop([])); }, []);
  const [me, setMe] = useState<string | null>(null);
  useEffect(() => { void fetch(`${apiBase()}/session`, { credentials: "same-origin" }).then((r) => r.json()).then((b) => setMe(b.authenticated ? b.user : null)).catch(() => undefined); }, []);
  const shown = (items ?? []).slice(0, PAGE); const more = (items?.length ?? 0) > PAGE;
  return (
    <div className="xp" data-testid="explore-page">
      <header className="xp-hero">
        <div><h1>GBK Composer</h1><p>Describe music in plain words; an AI agent composes it with GBK's MIDI workstation and SoundFont synth, right in your browser.</p></div>
        <button className="xp-cta" data-testid="compose-cta" onClick={() => onCompose()}>Compose your own →</button>
      </header>
      <video className="xp-video" data-testid="launch-video" controls playsInline preload="metadata" poster="/media/compose-launch-poster.jpg" src="/media/compose-launch.mp4" aria-label="GBK Composer launch video" />
      <div className="xp-starters">{STARTER_PROMPTS.slice(0, 3).map((p) => <button key={p.label} onClick={() => onCompose(p.text)} title={p.text}>{p.label}</button>)}<button onClick={() => onCompose()} className="xp-ghost">Open the workstation</button></div>
      {me && <MySongs />}
      <h2>Top songs</h2>
      <p className="ws-dim xp-rank">Most-forked public songs, newest first among ties.</p>
      {top && !top.length && <div className="ws-dim" data-testid="top-empty">Nothing shared yet. Be the first!</div>}
      <div className="xp-grid" data-testid="top-grid">
        {(top ?? []).map((s, i) => {
          const link = `${location.origin}/s/${s.slug}`;
          return (
            <article key={s.slug} className="xp-card xp-top" data-testid="top-card" data-slug={s.slug}>
              <PianoRoll p={s.preview} />
              <h3 title={s.title}><span className="xp-rankno">#{i + 1}</span> {s.title}</h3>
              <div className="ws-dim">by {s.owner} · {s.forks} fork{s.forks === 1 ? "" : "s"}</div>
              <a className="xp-link" data-testid="top-link" href={link} title={link}>/s/{s.slug}</a>
              <Preview s={s} />
              <div className="ws-row"><button data-testid="top-open" onClick={() => onOpen(s.slug, false)}>Open</button><button onClick={() => void navigator.clipboard?.writeText(link)}>Copy link</button></div>
            </article>
          );
        })}
      </div>
      <h2>Recently shared</h2>
      {err && <div className="cmp-error">{err}</div>}
      {items === null && !err && <div className="ws-dim">Loading…</div>}
      {items && !shown.length && <div className="ws-dim" data-testid="explore-empty">Nothing shared yet. Be the first!</div>}
      <div className="xp-grid">
        {shown.map((s) => (
          <article key={s.slug} className="xp-card" data-testid="share-card" data-slug={s.slug}>
            <h3 title={s.title}>{s.title}</h3>
            <div className="ws-dim">by {s.owner} · {new Date(s.createdAt).toLocaleDateString()}{s.wav?.durationSeconds ? ` · ${Math.floor(s.wav.durationSeconds / 60)}:${String(Math.round(s.wav.durationSeconds % 60)).padStart(2, "0")}` : ""}</div>
            <div className="ws-dim">{s.forks} fork{s.forks === 1 ? "" : "s"}{s.parent ? <> · forked from <a href={`#`} onClick={(e) => { e.preventDefault(); onOpen(s.parent!.slug, false); }}>{s.parent.title}</a></> : null}</div>
            <Preview s={s} />
            <div className="ws-row"><button data-testid="card-open" onClick={() => onOpen(s.slug, false)}>Open</button><button data-testid="card-fork" onClick={() => onOpen(s.slug, true)}>Fork</button></div>
          </article>
        ))}
      </div>
      <nav className="ws-row xp-pager"><button disabled={!page} onClick={() => setPage(page - 1)}>← Newer</button><span className="ws-dim">page {page + 1}</span><button disabled={!more} onClick={() => setPage(page + 1)} data-testid="explore-next">Older →</button></nav>
    </div>
  );
}
