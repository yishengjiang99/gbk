// gbk Social web UI: one Feed tab (Explore merged: chips + Browse sheet), Create, Inbox, Profile; song ratings,
// flat comments, reports, profiles and the admin report queue. All user text renders as React text nodes.
import { createPath } from "../../workstation/studio-api.ts";
import { Crossfader, type FadeState } from "./crossfade.ts";
import { loadWorklet, prepare, preparedCount, songProject, warmSoundFont } from "./live-song.ts";
import { startImpression, endImpression, attachAudio, markAction, markRate, noteScroll } from "./impressions.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { social, LABELS, type Me, type Song, type SComment, type SUser } from "../../agent/social-client.ts";
import { PianoRoll } from "../explore/ExplorePage.tsx";
import { LiveRoll, type VizSource } from "./LiveRoll.tsx";
import { MySongs } from "../songs/MySongs.tsx";
import { navigate } from "../../agent/routes.ts";
import type { SocialRoute } from "../../agent/routes.ts";
import { needSignIn, takePending } from "../auth/gate.ts";
import { setRemixHandoff } from "../../agent/remix-handoff.ts";

type Sheet = null | { kind: "comments"; song: Song; draft?: string } | { kind: "browse" } | { kind: "report"; what: "song" | "comment" | "user"; target: string; label: string };
/** Opens the Studio in a FRESH chat session whose open project is the user's editable fork of this song,
 * with the original prompt prefilled (never auto-run). If the song fails to load, the Studio falls back to
 * the prompt-only landing (#162). */
export const remix = (slug: string, prompt: string) => { sessionStorage.setItem("gbk.focusComposer", "1"); setRemixHandoff({ slug, prompt }); sessionStorage.setItem("gbk.composerDraft", prompt.slice(0, 4000)); navigate("studio"); setTimeout(() => window.dispatchEvent(new Event("gbk:focus-composer")), 50); };
const ago = (t: number) => { const s = (Date.now() - t) / 1000; return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };

function Stars({ song, me, onChange }: { song: Song; me: Me | null; onChange: (s: Song) => void }) {
  const [err, setErr] = useState("");
  const set = async (n: number) => {
    if (!me) return needSignIn("Sign in to rate songs.", { kind: "rate", slug: song.slug, stars: n }); if (song.is_mine) { setErr("You can't rate your own song"); return; }
    try { const stars = song.my_rating === n ? null : n; const r = await social.rate(song.slug, stars); markRate(song.slug, stars); onChange({ ...song, ...r }); setErr(""); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="so-stars" data-testid="stars">
      {[1, 2, 3, 4, 5].map((n) => <button key={n} aria-label={`Rate ${n} star${n > 1 ? "s" : ""}`} data-testid={`star-${n}`} className={(song.my_rating ?? 0) >= n ? "on" : ""} onClick={() => void set(n)}>★</button>)}
      <span className="so-dim" data-testid="rating-summary">{song.rating_avg !== null ? `${song.rating_avg.toFixed(1)} (${song.rating_count})` : "no ratings"}</span>
      {err && <span className="so-err">{err}</span>}
    </div>
  );
}

function Chips({ song, onFilter }: { song: Song; onFilter: (f: { label?: string; tag?: string }) => void }) {
  return <div className="so-chips">{song.labels.map((l) => <button key={l} className={`so-chip lab ${l === "wip" ? "wip" : ""}`} onClick={() => onFilter({ label: l })}>{l}</button>)}{song.tags.map((t) => <button key={t} className="so-chip" onClick={() => onFilter({ tag: t })}>#{t}</button>)}</div>;
}

function Card({ idx, song, me, playing, viz, onPlay, onUpdate, onSheet, onFilter, onOpen }: { idx: number; song: Song; me: Me | null; playing: boolean; viz: () => VizSource; onPlay: (s: Song) => void; onUpdate: (s: Song) => void; onSheet: (s: Sheet) => void; onFilter: (f: { label?: string; tag?: string }) => void; onOpen: (slug: string, fork: boolean) => void }) {
  return (
    <article className="so-card" tabIndex={-1} data-testid="feed-card" data-slug={song.slug} data-idx={idx} data-playing={playing ? "1" : "0"}>
      <div className="so-rollwrap" onClick={() => onPlay(song)}>{song.preview ? <LiveRoll p={song.preview} playing={playing} source={viz} /> : <div className="so-noroll" />}<button type="button" className="so-playbadge" data-testid="card-play" aria-label={playing ? "Pause" : "Play"} aria-pressed={playing} onClick={(e) => { e.stopPropagation(); onPlay(song); }}><span aria-hidden="true">{playing ? "❚❚" : "▶"}</span></button></div>
      <div className="so-side">
        <button aria-label="Comments" data-testid="card-comments" onClick={() => onSheet({ kind: "comments", song })}>💬<small>{song.comment_count}</small></button>
        <button aria-label="Open in Studio" data-testid="card-open" onClick={() => { markAction(song.slug, "open_studio"); onOpen(song.slug, false); }}>✎<small>open</small></button>
        <button aria-label="Share" data-testid="card-share" onClick={() => { markAction(song.slug, "share"); const url = new URL(`/s/${song.slug}`, location.origin).href; const n = navigator as Navigator & { share?: (d: ShareData) => Promise<void> }; if (n.share) void n.share({ title: song.title, url }).catch(() => undefined); else void navigator.clipboard?.writeText(url); }}>↗<small>share</small></button>
        <button aria-label="Remix (fork)" data-testid="card-fork" onClick={() => { markAction(song.slug, "remix"); onOpen(song.slug, true); }}>⑂<small>{song.fork_count}</small></button>
        <button aria-label="Report song" data-testid="card-report" onClick={() => (me ? onSheet({ kind: "report", what: "song", target: song.slug, label: song.title }) : needSignIn("Sign in to report.", { kind: "report", what: "song", target: song.slug, label: song.title }))}>⚑</button>
      </div>
      <div className="so-meta">
        <h2 data-testid="card-title">{song.title}</h2>
        <div className="so-dim"><a href={`/u/${song.author.handle}`} onClick={(e) => { e.preventDefault(); markAction(song.slug, "profile_tap"); navigate(`u/${song.author.handle}`); }} data-testid="card-author">@{song.author.handle}</a>{song.author.badge && <span className="so-badge">{song.author.badge}</span>}{song.author.pro && <span className="so-badge so-pro" data-testid="card-pro">Pro</span>} · {song.play_count} plays{song.published_at ? ` · ${ago(song.published_at)}` : ""}</div>
        <Stars song={song} me={me} onChange={onUpdate} />
        <Chips song={song} onFilter={onFilter} />
        {song.prompt_shared && song.prompt_text && <div className="so-prompt" data-testid="card-prompt"><span className="so-clamp">“{song.prompt_text}”</span><button className="so-btn" data-testid="card-remix" onClick={() => remix(song.slug, song.prompt_text!)}>Remix this prompt</button></div>}
        {!song.preview && !song.media.mp3 && !song.media.wav && <div className="so-dim">No audio preview yet. Open in Studio to play.</div>}
      </div>
    </article>
  );
}

const srcOf = (s: Song) => s.media.mp3 ?? s.media.wav;
/** One shared <audio> (iOS only lets a gesture-unlocked element autoplay) + a warm-up element that preloads the next song. */
function useAudio() {
  const host = useRef<HTMLDivElement | null>(null); const xf = useRef<Crossfader | null>(null);
  const [st, setSt] = useState<FadeState>({ current: null, fading: null }); const [unlocked, setUnlocked] = useState(false); const counted = useRef(new Set<string>());
  const slugBySrc = useRef(new Map<string, string>());
  useEffect(() => {
    const x = new Crossfader(host.current!, setSt); xf.current = x; warmSoundFont();
    { const c = x.warm(); if (c) void loadWorklet(c).catch(() => undefined); }
    // test/debug hook (read-only counters)
    (window as unknown as { __gbkFeedAudio?: object }).__gbkFeedAudio = { playing: () => x.playingCount, live: () => x.currentIsLive, prepared: () => preparedCount(), level: () => { const a = x.analyser; if (!a) return 0; const d = new Float32Array(a.fftSize); a.getFloatTimeDomainData(d); let m = 0; for (const v of d) m = Math.max(m, Math.abs(v)); return m; } };
    const vis = () => { if (document.hidden) x.stop(); };
    document.addEventListener("visibilitychange", vis);
    return () => { document.removeEventListener("visibilitychange", vis); x.dispose(); };
  }, []);
  const start = useCallback((s: Song, gesture = false) => {
    const x = xf.current!; if (gesture) x.unlock();
    // Real-time first: the song's project through the SF2 engine; prerendered audio only for songs without a project.
    const ctx = x.audioContext; const key = `live:${s.slug}`; slugBySrc.current.set(key, s.slug);
    const legacy = () => { const src = srcOf(s); if (!src) return x.play(null).then(() => false); slugBySrc.current.set(src, s.slug); return x.play(src); };
    const go = ctx ? prepare(s.slug, ctx.sampleRate).then((p) => p ? x.playLive(key, p) : legacy()) : legacy();
    void go.then((ok) => { if (!ok) { if (!gesture && !x.playingCount) setUnlocked(false); return; } setUnlocked(true); if (!counted.current.has(s.slug)) { counted.current.add(s.slug); void social.play(s.slug); } });
  }, []);
  const cur = st.current ? slugBySrc.current.get(st.current) ?? null : null;
  const toggle = useCallback((s: Song) => { if (cur === s.slug) void xf.current!.play(null); else start(s, true); }, [cur, start]);
  const stop = useCallback(() => xf.current?.stop(), []);
  /** 58 ms fade-out of whatever plays (section switch); also cancels a live start in flight. */
  const fadeOut = useCallback(() => { void xf.current?.play(null); }, []);
  // Warm the next songs: project + render plan for the live engine; <audio> preload only for legacy audio-only songs.
  const preload = useCallback((ss: (Song | undefined)[]) => {
    const x = xf.current; if (!x) return; const ctx = x.audioContext; const list = ss.filter((s): s is Song => !!s);
    for (const s of list) { if (ctx) void prepare(s.slug, ctx.sampleRate); else void songProject(s.slug); }
    void Promise.all(list.map((s) => songProject(s.slug).then((p) => p ? null : srcOf(s)))).then((srcs) => xf.current?.preload(srcs));
  }, []);
  const fading = st.fading ? slugBySrc.current.get(st.fading) ?? null : null;
  const viz = useCallback((): VizSource => ({ el: xf.current?.currentEl ?? null, analyser: xf.current?.analyser ?? null }), []);
  const currentEl = useCallback(() => xf.current?.currentEl ?? null, []);
  return { cur, fading, unlocked, start, toggle, stop, fadeOut, preload, host, viz, currentEl };
}

function FeedView({ me, filter, setFilter, onSheet, onOpen, focusSlug }: { me: Me | null; filter: { sort: string; label?: string; tag?: string }; setFilter: (f: { sort: string; label?: string; tag?: string }) => void; onSheet: (s: Sheet) => void; onOpen: (slug: string, fork: boolean) => void; focusSlug?: string }) {
  const [items, setItems] = useState<Song[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [done, setDone] = useState(false); const [err, setErr] = useState(""); const [loading, setLoading] = useState(false);
  const [labels, setLabels] = useState<string[]>([]); const audio = useAudio(); const mv = useRef("unknown");
  const key = `${filter.sort}|${filter.label ?? ""}|${filter.tag ?? ""}|${focusSlug ?? ""}`; const live = useRef(key);
  // Share link (/s/<slug>): the shared song is pinned at the top of the feed, so it is the
  // active card — it starts as soon as audio unlocks (the Tap to play pill targets it).
  const focusDone = useRef<string | undefined>(undefined);
  useEffect(() => { focusDone.current = undefined; }, [focusSlug]);
  useEffect(() => { void social.tags().then((t) => setLabels(t.labels.map((l) => l.label).filter((l) => l !== "wip").slice(0, 4))).catch(() => undefined); }, []);
  const load = useCallback(async (reset: boolean) => {
    setLoading(true); setErr("");
    try { const r = await social.feed({ sort: filter.sort, label: filter.label, tag: filter.tag, cursor: reset ? null : cursor, limit: 10 }); if (live.current !== key) return;
      let pageItems = r.items;
      if (reset && focusSlug && focusDone.current !== focusSlug) {
        focusDone.current = focusSlug;
        if (!pageItems.some((x) => x.slug === focusSlug)) {
          const s = await social.song(focusSlug).catch(() => null);
          if (s && live.current === key) pageItems = [s, ...pageItems];
        }
      }
      setItems((p) => reset ? pageItems : [...p, ...pageItems.filter((x) => !p.some((y) => y.slug === x.slug))]); setCursor(r.next_cursor); setDone(!r.next_cursor); if (r.model_version) mv.current = r.model_version; }
    catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  }, [filter.sort, filter.label, filter.tag, cursor, key, focusSlug]);
  const feedEl = useRef<HTMLDivElement | null>(null); const [active, setActive] = useState(0); const [candidate, setCandidate] = useState(0);
  // Section switch (chip, #tag, Browse): fade the playing song out (58 ms), then start the new section at its first card.
  const focusFirst = useRef(false);
  useEffect(() => { live.current = key; setItems([]); setCursor(null); setDone(false); audio.fadeOut(); feedEl.current?.scrollTo({ top: 0 }); setActive(0); setCandidate(0); focusFirst.current = true; void load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [key]);
  useEffect(() => { if (!focusFirst.current || !items.length) return; focusFirst.current = false; const f = feedEl.current; if (!f) return; f.scrollTo({ top: 0 }); f.querySelector<HTMLElement>('[data-idx="0"]')?.focus({ preventScroll: true }); }, [items]);
  // Autoplay: the card that is >= 60% in view is active; it plays once audio is unlocked (first tap), and the next card preloads.
  useEffect(() => {
    const root = feedEl.current; if (!root) return;
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting && e.intersectionRatio >= 0.6) setCandidate(Number((e.target as HTMLElement).dataset.idx)); }, { root, threshold: [0.6] });
    root.querySelectorAll("[data-idx]").forEach((el) => io.observe(el)); return () => io.disconnect();
  }, [items.length]);
  useEffect(() => { if (audio.cur) attachAudio(audio.cur, audio.currentEl()); }, [audio.cur]);
  useEffect(() => () => endImpression(), []);
  // Snap settle: the crossfade starts only once scrolling stops (scrollend, or 120 ms without scroll events).
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    const root = feedEl.current; if (!root) return; let t: ReturnType<typeof setTimeout> | undefined;
    const done = () => { clearTimeout(t); const cards = [...root.querySelectorAll<HTMLElement>("[data-idx]")]; const mid = root.scrollTop + root.clientHeight / 2; const near = cards.reduce((b, el) => Math.abs(el.offsetTop + el.offsetHeight / 2 - mid) < Math.abs(b.offsetTop + b.offsetHeight / 2 - mid) ? el : b, cards[0]); if (near) setActive(Number(near.dataset.idx)); setSettled((n) => n + 1); };
    const on = () => { noteScroll(root.scrollTop); clearTimeout(t); t = setTimeout(done, 120); };
    root.addEventListener("scroll", on, { passive: true }); root.addEventListener("scrollend", done);
    return () => { clearTimeout(t); root.removeEventListener("scroll", on); root.removeEventListener("scrollend", done); };
  }, []);
  // Any first gesture (not just "Tap to play") unlocks audio and starts the visible card; after that, scroll switches autoplay.
  const visible = useRef<Song | undefined>(undefined); visible.current = items[active];
  useEffect(() => {
    if (audio.unlocked) return;
    const evs = ["pointerdown", "touchstart", "touchend", "keydown", "click", "wheel"] as const;
    const off = () => evs.forEach((e) => window.removeEventListener(e, on, true));
    const on = (e: Event) => {
      const s = visible.current; if (!s) return;
      const t = e.target as HTMLElement | null; if (t?.closest?.("[data-testid=tap-to-play],.so-rollwrap,.so-sheet,input,textarea,select")) return; // these handle their own start / are not a play intent
      audio.start(s, true); // listeners stay until play actually succeeds (iOS only honors touchend/click), then the effect removes them
    };
    evs.forEach((e) => window.addEventListener(e, on, { capture: true, passive: true })); return off;
  }, [audio.unlocked, audio.start, items.length > 0]);
  useEffect(() => { const s = items[active]; if (!s) return; startImpression(s.slug, active, filter.tag ? "tag" : filter.label ? "label" : filter.sort, mv.current); audio.preload([items[active], items[active + 1], items[active - 1]]); if (audio.unlocked) audio.start(s); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [active, settled, items.length > 0, audio.unlocked]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return; if (document.querySelector(".so-sheet")) return;
      const f = feedEl.current; if (!f) return;
      if (e.key === "ArrowDown" || e.key === "j" || e.key === "PageDown") { e.preventDefault(); f.scrollBy({ top: f.clientHeight, behavior: "smooth" }); }
      else if (e.key === "ArrowUp" || e.key === "k" || e.key === "PageUp") { e.preventDefault(); f.scrollBy({ top: -f.clientHeight, behavior: "smooth" }); }
      else if (e.key === " " && items[active]) { e.preventDefault(); audio.toggle(items[active]); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [items, active, audio]);
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => { const el = sentinel.current; if (!el) return; const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting) && !loading && !done && items.length) void load(false); }, { rootMargin: "200px" }); io.observe(el); return () => io.disconnect(); }, [load, loading, done, items.length]);
  const chip = (label: string, f: { sort: string; label?: string; tag?: string }, on: boolean, tid: string) => <button className={`so-chip ${on ? "sel" : ""}`} data-testid={tid} onClick={() => setFilter(f)}>{label}</button>;
  const plain = !filter.label && !filter.tag;
  return (
    <>
      <div className="so-filterbar" data-testid="filterbar">
        {chip("For you", { sort: "for_you" }, plain && filter.sort === "for_you", "chip-foryou")}
        {chip("New", { sort: "new" }, plain && filter.sort === "new", "chip-new")}
        {chip("Top", { sort: "top" }, plain && filter.sort === "top", "chip-top")}
        {labels.map((l) => chip(l, { sort: "new", label: l }, filter.label === l, `chip-label-${l}`))}
        {filter.tag && chip(`#${filter.tag} ✕`, { sort: "for_you" }, true, "chip-tag")}
        {filter.label && !labels.includes(filter.label) && chip(`${filter.label} ✕`, { sort: "for_you" }, true, "chip-label")}
        <button className="so-chip" data-testid="browse" onClick={() => onSheet({ kind: "browse" })}>Browse ▾</button>
      </div>
      <div className="so-feed" data-testid="feed" ref={feedEl} data-active={active} data-unlocked={audio.unlocked ? "1" : "0"} data-fading={audio.fading ?? ""} data-candidate={candidate}>
        <div ref={audio.host} hidden data-testid="feed-audio" />
        {!audio.unlocked && items.length > 0 && <button className="so-unlock" data-testid="tap-to-play" onClick={() => { const s = items[active]; if (s) audio.start(s, true); }}>🔊 Tap to play</button>}
        {items.map((s, i) => <Card key={s.slug} idx={i} song={s} me={me} playing={audio.cur === s.slug} viz={audio.viz} onPlay={audio.toggle} onUpdate={(n) => setItems((p) => p.map((x) => x.slug === n.slug ? n : x))} onSheet={onSheet} onFilter={(f) => setFilter({ sort: "new", ...f })} onOpen={onOpen} />)}
        {!loading && !items.length && !err && <div className="so-empty" data-testid="feed-empty">Nothing here yet. <button className="so-btn pri" onClick={() => navigate("studio")}>Compose the first one</button></div>}
        {err && <div className="so-empty so-err">{err} <button className="so-btn" onClick={() => void load(true)}>Retry</button></div>}
        <div ref={sentinel} className="so-sentinel">{loading ? "Loading…" : done && items.length ? "You're all caught up." : ""}</div>
      </div>
    </>
  );
}

function CommentsSheet({ song, me, draft, onSheet, onCount }: { song: Song; me: Me | null; draft?: string; onSheet: (s: Sheet) => void; onCount: () => void }) {
  const [items, setItems] = useState<SComment[] | null>(null); const [next, setNext] = useState<string | null>(null); const [text, setText] = useState(draft ?? ""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { void social.comments(song.slug).then((r) => { setItems(r.items); setNext(r.next_cursor); }).catch((e) => setErr((e as Error).message)); }, [song.slug]);
  const post = async () => { const b = text.trim(); if (!b) return; if (!me) return needSignIn("Sign in to comment.", { kind: "comment", slug: song.slug, text: b }); setBusy(true); setErr(""); try { const c = await social.comment(song.slug, b); markAction(song.slug, "comment"); setItems((p) => [c, ...(p ?? [])]); setText(""); onCount(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  return (
    <div data-testid="comments-sheet">
      {song.prompt_shared && song.prompt_text && <div className="so-prompt">Prompt: {song.prompt_text} <button className="so-link" data-testid="sheet-remix" onClick={() => remix(song.slug, song.prompt_text!)}>Remix</button></div>}
      {items === null && !err && <div className="so-dim">Loading…</div>}
      {items && !items.length && <div className="so-dim" data-testid="comments-empty">No comments yet.</div>}
      {(items ?? []).map((c) => (
        <div key={c.id} className="so-cm" data-testid="comment">
          <div className="so-dim"><a href={`/u/${c.author.handle}`} onClick={(e) => { e.preventDefault(); onSheet(null); navigate(`u/${c.author.handle}`); }}>@{c.author.handle}</a> · {ago(c.created_at)}
            {c.can_delete && <button className="so-link" data-testid="comment-delete" onClick={async () => { await social.deleteComment(c.id); setItems((p) => (p ?? []).filter((x) => x.id !== c.id)); onCount(); }}>delete</button>}
            {me && !c.can_delete && <button className="so-link" data-testid="comment-report" onClick={() => onSheet({ kind: "report", what: "comment", target: c.id, label: `comment by @${c.author.handle}` })}>report</button>}
          </div>
          <div className="so-cmbody" data-testid="comment-body">{c.body}</div>
        </div>
      ))}
      {next && <button className="so-btn" onClick={async () => { const r = await social.comments(song.slug, next); setItems((p) => [...(p ?? []), ...r.items]); setNext(r.next_cursor); }}>More</button>}
      {err && <div className="so-err">{err}</div>}
      {(
        <form className="so-row so-compose" onSubmit={(e) => { e.preventDefault(); void post(); }}>
          <input data-testid="comment-input" value={text} maxLength={500} placeholder="Add a comment" onChange={(e) => setText(e.target.value)} />
          <button className="so-btn pri" data-testid="comment-send" disabled={busy || !text.trim()}>Post</button>
        </form>
      )}
    </div>
  );
}

function BrowseSheet({ onPick }: { onPick: (f: { label?: string; tag?: string }) => void }) {
  const [t, setT] = useState<{ tags: { tag: string; count: number }[]; labels: { label: string; count: number }[] } | null>(null);
  useEffect(() => { void social.tags().then(setT).catch(() => setT({ tags: [], labels: [] })); }, []);
  const count = (l: string) => t?.labels.find((x) => x.label === l)?.count ?? 0;
  return (
    <div data-testid="browse-sheet">
      <b>Labels</b><div className="so-chips">{LABELS.map((l) => <button key={l} className={`so-chip ${l === "wip" ? "wip" : ""}`} data-testid={`browse-label-${l}`} onClick={() => onPick({ label: l })}>{l} {count(l) || ""}</button>)}</div>
      <b>Tags</b><div className="so-chips">{t && !t.tags.length && <span className="so-dim">No tags yet.</span>}{(t?.tags ?? []).map((x) => <button key={x.tag} className="so-chip" data-testid="browse-tag" onClick={() => onPick({ tag: x.tag })}>#{x.tag} {x.count}</button>)}</div>
    </div>
  );
}

function ReportSheet({ what, target, label, done }: { what: "song" | "comment" | "user"; target: string; label: string; done: (msg: string) => void }) {
  const [reason, setReason] = useState(""); const [err, setErr] = useState("");
  return (
    <form data-testid="report-sheet" onSubmit={async (e) => { e.preventDefault(); try { const r = await social.report(what, target, reason); done(r.deleted ? "Deleted" : "Thanks, we'll review it."); } catch (x) { setErr((x as Error).message); } }}>
      <p>Report {label}?</p>
      <textarea data-testid="report-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What's wrong? (optional)" />
      {err && <div className="so-err">{err}</div>}
      <button className="so-btn pri" data-testid="report-send">Send report</button>
    </form>
  );
}

function MiniGrid({ songs }: { songs: Song[] }) {
  return <div className="so-grid">{songs.map((s) => <a key={s.slug} className="so-mini" href={`/s/${s.slug}`} data-testid="profile-song">{s.preview && <PianoRoll p={s.preview} />}<b>{s.title}</b><div className="so-dim">★{s.rating_avg?.toFixed(1) ?? "–"} · 💬{s.comment_count}</div></a>)}</div>;
}

function ProfileView({ handle, me, onSheet, setMe }: { handle: string | null; me: Me | null; onSheet: (s: Sheet) => void; setMe: (m: Me) => void }) {
  const h = handle ?? me?.handle ?? null;
  const [d, setD] = useState<{ user: SUser; songs: Song[] } | null>(null); const [err, setErr] = useState("");
  const [name, setName] = useState(""); const [hd, setHd] = useState(""); const [msg, setMsg] = useState("");
  useEffect(() => { setD(null); setErr(""); if (h) void social.user(h).then(setD).catch((e) => setErr((e as Error).message)); }, [h]);
  useEffect(() => { if (me) { setName(me.display_name); setHd(me.handle); } }, [me]);
  if (!h) return <div className="so-pad" data-testid="profile-guest"><div className="so-row"><div className="so-av">G</div><div className="so-grow"><h2>Guest</h2><div className="so-dim">Browsing as a guest. Sign in to rate, comment, publish and keep your songs.</div></div></div><p><button className="so-btn pri" data-testid="profile-signin" onClick={() => needSignIn("Sign in to set up your profile.", { kind: "profile" })}>Sign in</button></p></div>;
  if (err) return <div className="so-pad so-err">{err}</div>;
  if (!d) return <div className="so-pad so-dim">Loading…</div>;
  const mine = me?.handle === d.user.handle;
  return (
    <div className="so-pad" data-testid="profile-view">
      <div className="so-row"><div className="so-av">{d.user.display_name.slice(0, 1).toUpperCase()}</div><div className="so-grow"><h2 data-testid="profile-name">{d.user.display_name}{d.user.badge && <span className="so-badge" data-testid="profile-badge">{d.user.badge}</span>}{d.user.pro && <span className="so-badge so-pro" data-testid="profile-pro">Pro</span>}</h2><div className="so-dim">@{d.user.handle} · {d.user.song_count} songs{d.user.rating_avg !== null ? ` · ★${d.user.rating_avg.toFixed(1)}` : ""}</div>{d.user.bio && <div className="so-bio" data-testid="profile-bio">{d.user.bio}</div>}</div></div>
      {!mine && <p className="so-row"><button className="so-btn" disabled title="Messages arrive in the next update">✉ Message</button><button className="so-btn" data-testid="profile-report" onClick={() => (me ? onSheet({ kind: "report", what: "user", target: d.user.handle, label: `@${d.user.handle}` }) : needSignIn("Sign in to report.", { kind: "report", what: "user", target: d.user.handle, label: `@${d.user.handle}` }))}>Report</button></p>}
      {mine && me && (
        <form className="so-settings" data-testid="profile-settings" onSubmit={async (e) => { e.preventDefault(); setMsg(""); try { const m = await social.settings({ display_name: name, ...(hd !== me.handle ? { handle: hd } : {}) }); setMe(m); setMsg("Saved"); if (m.handle !== h) navigate(`u/${m.handle}`); } catch (x) { setMsg((x as Error).message); } }}>
          <label>Display name <input data-testid="settings-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
          <label>Handle {me.handle_changed ? <span className="so-dim">(already changed once)</span> : <span className="so-dim">(can be changed once)</span>}<input data-testid="settings-handle" value={hd} maxLength={20} disabled={me.handle_changed} onChange={(e) => setHd(e.target.value.toLowerCase())} /></label>
          <div className="so-row"><button className="so-btn pri" data-testid="settings-save">Save</button><span className="so-dim" data-testid="settings-msg">{msg}</span>{me.is_admin && <a href="/admin/reports" onClick={(e) => { e.preventDefault(); navigate("admin/reports"); }} data-testid="admin-link">Report queue</a>}</div>
          <div className="so-row"><button type="button" className="so-btn" data-testid="signout" onClick={async () => { const c = document.cookie.match(/(?:^|; )gbk_csrf=([^;]+)/)?.[1]; await fetch("/api/logout", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...(c ? { "x-gbk-csrf": decodeURIComponent(c) } : {}) }, body: "{}" }); location.href = "/"; }}>Sign out</button></div>
        </form>
      )}
      <h3>Published</h3>
      {d.songs.length ? <MiniGrid songs={d.songs} /> : <div className="so-dim">No published songs yet.</div>}
      {mine && <><h3>Your songs</h3><MySongs /></>}
    </div>
  );
}

function AdminView() {
  const [status, setStatus] = useState("open"); const [d, setD] = useState<Awaited<ReturnType<typeof social.adminReports>> | null>(null); const [err, setErr] = useState("");
  const load = useCallback(() => { setErr(""); void social.adminReports(status).then(setD).catch((e) => setErr((e as Error).message)); }, [status]);
  useEffect(load, [load]);
  return (
    <div className="so-pad" data-testid="admin-reports">
      <div className="so-row"><h2 className="so-grow">Report queue</h2><select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="admin-status"><option value="open">Open</option><option value="resolved">Hidden</option><option value="dismissed">Dismissed</option></select></div>
      {err && <div className="so-err">{err}</div>}
      {d && !d.items.length && <div className="so-dim">Nothing to review.</div>}
      {(d?.items ?? []).map((r) => (
        <div key={r.id} className="so-cm" data-testid="admin-report">
          <div className="so-dim">{r.kind} · by @{r.reporter} · {ago(r.created_at)}{r.preview?.song ? <> · <a href={`/s/${r.preview.song}`}>song</a></> : null}</div>
          <div className="so-cmbody">{r.preview ? `${r.preview.text} (@${r.preview.by})${r.preview.hidden ? " [hidden]" : ""}` : r.target}</div>
          {r.reason && <div className="so-dim">Reason: {r.reason}</div>}
          {r.status === "open" && <div className="so-row"><button className="so-btn" data-testid="admin-hide" onClick={async () => { await social.resolve(r.id, "hide"); load(); }}>Hide</button><button className="so-btn" data-testid="admin-dismiss" onClick={async () => { await social.resolve(r.id, "dismiss"); load(); }}>Dismiss</button></div>}
        </div>
      ))}
    </div>
  );
}

export function SocialApp({ route, onOpen }: { route: SocialRoute; onOpen: (slug: string, fork: boolean) => void }) {
  const [me, setMe] = useState<Me | null>(null); const [sheet, setSheet] = useState<Sheet>(null); const [toast, setToast] = useState("");
  const [meChecked, setMeChecked] = useState(false);
  useEffect(() => { void social.me().then(setMe).catch(() => setMe(null)).finally(() => setMeChecked(true)); }, []);
  // Resume the action that asked for sign-in (rating, comment text, report, profile/inbox tab) once we know who we are.
  useEffect(() => {
    if (!meChecked || !me) return;
    const p = takePending("rate", "comment", "report", "profile", "inbox"); if (!p) return;
    if (p.kind === "rate") void social.rate(p.slug, p.stars).then(() => { markRate(p.slug, p.stars); say(`Rated ${p.stars}★`); setBump((b) => b + 1); }).catch((e) => say((e as Error).message));
    else if (p.kind === "comment") void social.song(p.slug).then(async (song) => { try { await social.comment(p.slug, p.text); markAction(p.slug, "comment"); setSheet({ kind: "comments", song: { ...song, comment_count: song.comment_count + 1 } }); } catch (e) { say((e as Error).message); setSheet({ kind: "comments", song, draft: p.text }); } }).catch((e) => say((e as Error).message));
    else if (p.kind === "report") setSheet({ kind: "report", what: p.what, target: p.target, label: p.label });
    else if (p.kind === "profile") navigate(`u/${me.handle}`);
    else navigate("inbox");
  }, [meChecked, me]);
  const filter = route.view === "feed" ? { sort: route.tag || route.label ? "new" : (route.sort ?? "for_you"), label: route.label, tag: route.tag } : { sort: "for_you" };
  const setFilter = (f: { sort: string; label?: string; tag?: string }) => navigate(f.tag ? `t/${f.tag}` : f.label ? `feed?label=${f.label}` : f.sort === "for_you" ? "" : `feed?sort=${f.sort}`);
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2000); };
  const tab = route.view === "feed" ? "feed" : route.view === "inbox" ? "inbox" : "me";
  const [bump, setBump] = useState(0);
  return (
    <div className="so-app" data-testid="social-app">
      <header className="so-top"><a href="/" onClick={(e) => { e.preventDefault(); navigate(""); }}><b>gbk</b></a><span className="so-grow" />{me && <span className="so-dim" data-testid="me-handle">@{me.handle}</span>}</header>
      <main className="so-main" key={bump}>
        {route.view === "feed" && <FeedView me={me} filter={filter} setFilter={setFilter} onSheet={setSheet} onOpen={onOpen} focusSlug={route.focus} />}
        {route.view === "profile" && <ProfileView handle={route.handle} me={me} onSheet={setSheet} setMe={setMe} />}
        {route.view === "inbox" && <div className="so-pad" data-testid="inbox-view"><h2>Inbox</h2>{me ? <p className="so-dim">Direct messages are coming in the next update. You'll be able to message any signed-in musician, and block, report or turn DMs off.</p> : <p className="so-dim">Messages appear here after you sign in. Tap Inbox to sign in.</p>}</div>}
        {route.view === "admin" && (me?.is_admin ? <AdminView /> : <div className="so-pad so-dim">Admins only.</div>)}
      </main>
      <nav className="so-tabs" data-testid="tabs">
        <button className={tab === "feed" ? "on" : ""} data-testid="tab-feed" onClick={() => navigate("")}>▶<br />Feed</button>
        <button data-testid="tab-create" onClick={() => { void createPath().then(navigate); }}>＋<br />Create</button>
        <button className={tab === "inbox" ? "on" : ""} data-testid="tab-inbox" onClick={() => (me || !meChecked ? navigate("inbox") : needSignIn("Sign in to see your messages.", { kind: "inbox" }))}>✉<br />Inbox</button>
        <button className={tab === "me" ? "on" : ""} data-testid="tab-profile" onClick={() => navigate(me ? `u/${me.handle}` : "me")}>◉<br />Profile</button>
      </nav>
      {sheet && <div className="so-scrim" onClick={() => setSheet(null)} />}
      {sheet && (
        <div className="so-sheet" role="dialog" aria-modal="true" data-testid="sheet">
          <header><b>{sheet.kind === "comments" ? `Comments · ${sheet.song.title}` : sheet.kind === "browse" ? "Browse" : "Report"}</b><button className="so-btn" data-testid="sheet-close" aria-label="Close" onClick={() => setSheet(null)}>✕</button></header>
          <div className="so-sheetbody">
            {sheet.kind === "comments" && <CommentsSheet song={sheet.song} me={me} draft={sheet.draft} onSheet={setSheet} onCount={() => setBump((x) => x)} />}
            {sheet.kind === "browse" && <BrowseSheet onPick={(f) => { setSheet(null); setFilter({ sort: "new", ...f }); }} />}
            {sheet.kind === "report" && <ReportSheet what={sheet.what} target={sheet.target} label={sheet.label} done={(m) => { setSheet(null); say(m); }} />}
          </div>
        </div>
      )}
      {toast && <div className="so-toast" role="status" data-testid="toast">{toast}</div>}
    </div>
  );
}
