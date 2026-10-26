// Explore: what others composed (public shared songs), newest first, with play previews, Open and Fork.
import { useEffect, useRef, useState } from "react";
import { listShares, mediaUrl, getShare, topShares, type ShareInfo, type TopShare } from "../../agent/share-client.ts";
import { sanitizeSharedProject } from "../../agent/share-schema.ts";
import { prepare, startLive } from "../social/live-song.ts";
import { STARTER_PROMPTS } from "../composer/ComposerPanel.tsx";
import { MySongs } from "../songs/MySongs.tsx";
import { apiBase } from "../../agent/bridge-client.ts";
import { markAction } from "../social/impressions.ts";
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
// Real-time SF2 playback of the song's project (live-song.ts); prerendered audio only for songs without a project.
let exploreCtx: AudioContext | null = null; let exploreStop: (() => void) | null = null; let exploreOwner: string | null = null;
const exploreListeners = new Set<() => void>();
function Preview({ s }: { s: ShareInfo }) {
  const [state, setState] = useState<"" | "loading" | "playing" | "legacy" | "failed">("");
  useEffect(() => { const f = () => setState((x) => (x === "playing" && exploreOwner !== s.slug ? "" : x)); exploreListeners.add(f); return () => { exploreListeners.delete(f); if (exploreOwner === s.slug) { exploreStop?.(); exploreStop = null; exploreOwner = null; } }; }, [s.slug]);
  const legacy = s.hasWav ? mediaUrl(s.slug, "wav") : s.hasMp3 ? mediaUrl(s.slug, "mp3") : null;
  if (state === "legacy" && legacy) return <audio controls autoPlay preload="none" src={legacy} data-testid="card-audio" />;
  const stop = () => { exploreStop?.(); exploreStop = null; exploreOwner = null; setState(""); };
  const play = async () => {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) { setState(legacy ? "legacy" : "failed"); return; }
    exploreCtx ??= new AC(); void exploreCtx.resume().catch(() => undefined); // inside the tap (iOS unlock)
    setState("loading");
    const p = await prepare(s.slug, exploreCtx.sampleRate);
    if (!p) { setState(legacy ? "legacy" : "failed"); return; }
    exploreStop?.(); const v = await startLive(exploreCtx, exploreCtx.destination, p);
    exploreStop = v.stop; exploreOwner = s.slug; exploreListeners.forEach((f) => f()); setState("playing");
  };
  return state === "playing"
    ? <button data-testid="card-stop" aria-pressed="true" onClick={stop}>❚❚ Stop</button>
    : <button data-testid="card-play-live" disabled={state === "loading"} onClick={() => void play().catch(() => setState("failed"))}>{state === "loading" ? "Loading…" : state === "failed" ? "Can't play — retry" : "▶ Play"}</button>;
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
        <div><h1>GBK Composer</h1><p>Describe music in plain words; an AI agent composes it with GBK's MIDI workstation and SoundFont synth, right in your browser.</p><p><a href="/chatgpt/gallery" data-testid="gallery-link">Hear demos made with GBK →</a></p></div>
        <button className="xp-cta" data-testid="compose-cta" onClick={() => onCompose()}>Compose your own →</button>
      </header>
      <video className="xp-video" data-testid="launch-video" controls playsInline preload="metadata" poster="/media/compose-launch-cover.jpg" src="/media/compose-launch-v4.mp4" aria-label="GBK Composer launch video" />
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
              <div className="ws-row"><button data-testid="top-open" onClick={() => onOpen(s.slug, false)}>Open</button><button onClick={() => { markAction(s.slug, "share"); void navigator.clipboard?.writeText(link); }}>Copy link</button></div>
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
      <footer className="ws-row ws-dim xp-footer"><a href="https://compose.grepawk.com/chatgpt">ChatGPT plugin</a><a href="https://compose.grepawk.com/chatgpt/gallery">Demo gallery</a><a href="https://compose.grepawk.com/privacy">Privacy</a><a href="https://compose.grepawk.com/terms">Terms</a><a href="https://compose.grepawk.com/support">Support</a></footer>
    </div>
  );
}
