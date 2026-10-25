// gbk Social web UI: one Feed tab (Explore merged: chips + Browse sheet), Create, Inbox, Profile; song ratings,
// flat comments, reports, profiles and the admin report queue. All user text renders as React text nodes.
import { startImpression, endImpression, attachAudio, markAction } from "./impressions.ts";
import { LiveRoll } from "./LiveRoll.tsx";
import { Crossfader, type FadeState } from "./crossfade.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { social, LABELS, type Me, type Song, type SComment, type SUser } from "../../agent/social-client.ts";
import { PianoRoll } from "../explore/ExplorePage.tsx";
import { MySongs } from "../songs/MySongs.tsx";
import { navigate } from "../../agent/routes.ts";
import type { SocialRoute } from "../../agent/routes.ts";

type Sheet = null | { kind: "comments"; song: Song } | { kind: "browse" } | { kind: "signin"; why: string } | { kind: "report"; what: "song" | "comment" | "user"; target: string; label: string };
const signInUrl = () => `/api/auth/google?return=${encodeURIComponent(location.pathname + location.search)}`;
/** Opens the Studio with the Composer prefilled (never auto-run). */
export const remix = (prompt: string) => { sessionStorage.setItem("gbk.focusComposer", "1"); sessionStorage.setItem("gbk.composerDraft", prompt.slice(0, 4000)); navigate("studio"); setTimeout(() => window.dispatchEvent(new Event("gbk:focus-composer")), 50); };
const ago = (t: number) => { const s = (Date.now() - t) / 1000; return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };

function Stars({ song, me, onNeedSignIn, onChange }: { song: Song; me: Me | null; onNeedSignIn: () => void; onChange: (s: Song) => void }) {
  const [err, setErr] = useState("");
  const set = async (n: number) => {
    if (!me) return onNeedSignIn(); if (song.is_mine) { setErr("You can't rate your own song"); return; }
    try { const r = await social.rate(song.slug, song.my_rating === n ? null : n); markAction(song.slug, "rate"); onChange({ ...song, ...r }); setErr(""); } catch (e) { setErr((e as Error).message); }
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

function Card({ idx, song, me, playing, live, onPlay, onUpdate, onSheet, onFilter, onOpen }: { idx: number; song: Song; me: Me | null; playing: boolean; live: { el: HTMLAudioElement | null; analyser: AnalyserNode | null } | null; onPlay: (s: Song) => void; onUpdate: (s: Song) => void; onSheet: (s: Sheet) => void; onFilter: (f: { label?: string; tag?: string }) => void; onOpen: (slug: string, fork: boolean) => void }) {
  return (
    <article className="so-card" data-testid="feed-card" data-slug={song.slug} data-idx={idx} data-playing={playing ? "1" : "0"}>
      <div className="so-rollwrap" onClick={() => onPlay(song)}>{live ? <LiveRoll p={song.preview} el={live.el} analyser={live.analyser} playing={playing} /> : song.preview ? <PianoRoll p={song.preview} /> : <div className="so-noroll" />}<span className="so-playbadge" data-testid="card-play">{playing ? "❚❚" : "▶"}</span></div>
      <div className="so-side">
        <button aria-label="Comments" data-testid="card-comments" onClick={() => onSheet({ kind: "comments", song })}>💬<small>{song.comment_count}</small></button>
        <button aria-label="Open in Studio" data-testid="card-open" onClick={() => { markAction(song.slug, "open_studio"); onOpen(song.slug, false); }}>✎<small>open</small></button>
        <button aria-label="Remix (fork)" data-testid="card-fork" onClick={() => { markAction(song.slug, "remix"); onOpen(song.slug, true); }}>⑂<small>{song.fork_count}</small></button>
        <button aria-label="Report song" data-testid="card-report" onClick={() => (me ? onSheet({ kind: "report", what: "song", target: song.slug, label: song.title }) : onSheet({ kind: "signin", why: "Sign in to report." }))}>⚑</button>
      </div>
      <div className="so-meta">
        <h2 data-testid="card-title">{song.title}</h2>
        <div className="so-dim"><a href={`/u/${song.author.handle}`} onClick={(e) => { e.preventDefault(); navigate(`u/${song.author.handle}`); }} data-testid="card-author">@{song.author.handle}</a>{song.author.badge && <span className="so-badge">{song.author.badge}</span>} · {song.play_count} plays{song.published_at ? ` · ${ago(song.published_at)}` : ""}</div>
        <Stars song={song} me={me} onNeedSignIn={() => onSheet({ kind: "signin", why: "Sign in to rate songs." })} onChange={onUpdate} />
        <Chips song={song} onFilter={onFilter} />
        {song.prompt_shared && song.prompt_text && <div className="so-prompt" data-testid="card-prompt"><span className="so-clamp">“{song.prompt_text}”</span><button className="so-btn" data-testid="card-remix" onClick={() => markAction(song.slug, "remix") ?? remix(song.prompt_text!)}>Remix this prompt</button></div>}
        {!song.media.mp3 && !song.media.wav && <div className="so-dim">No audio preview yet. Open in Studio to play.</div>}
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
    const x = new Crossfader(host.current!, setSt); xf.current = x;
    const vis = () => { if (document.hidden) x.stop(); };
    document.addEventListener("visibilitychange", vis);
    return () => { document.removeEventListener("visibilitychange", vis); x.dispose(); };
  }, []);
  const start = useCallback((s: Song, gesture = false) => {
    const x = xf.current!; const src = srcOf(s); if (gesture) x.unlock(); if (!src) { void x.play(null); return; }
    slugBySrc.current.set(src, s.slug);
    void x.play(src).then((ok) => { if (!ok) return; setUnlocked(true); if (!counted.current.has(s.slug)) { counted.current.add(s.slug); void social.play(s.slug); } });
  }, []);
  const cur = st.current ? slugBySrc.current.get(st.current) ?? null : null;
  const toggle = useCallback((s: Song) => { if (cur === s.slug) void xf.current!.play(null); else start(s, true); }, [cur, start]);
  const stop = useCallback(() => xf.current?.stop(), []);
  const preload = useCallback((ss: (Song | undefined)[]) => xf.current?.preload(ss.map((s) => s && srcOf(s))), []);
  const fading = st.fading ? slugBySrc.current.get(st.fading) ?? null : null;
  return { cur, fading, unlocked, start, toggle, stop, preload, host, xf };
}

function FeedView({ me, filter, setFilter, onSheet, onOpen }: { me: Me | null; filter: { sort: string; label?: string; tag?: string }; setFilter: (f: { sort: string; label?: string; tag?: string }) => void; onSheet: (s: Sheet) => void; onOpen: (slug: string, fork: boolean) => void }) {
  const [items, setItems] = useState<Song[]>([]); const [cursor, setCursor] = useState<string | null>(null); const [done, setDone] = useState(false); const [err, setErr] = useState(""); const [loading, setLoading] = useState(false);
  const [labels, setLabels] = useState<string[]>([]); const audio = useAudio(); const mv = useRef("unknown");
  const key = `${filter.sort}|${filter.label ?? ""}|${filter.tag ?? ""}`; const live = useRef(key);
  useEffect(() => { void social.tags().then((t) => setLabels(t.labels.map((l) => l.label).filter((l) => l !== "wip").slice(0, 4))).catch(() => undefined); }, []);
  const load = useCallback(async (reset: boolean) => {
    setLoading(true); setErr("");
    try { const r = await social.feed({ sort: filter.sort, label: filter.label, tag: filter.tag, cursor: reset ? null : cursor, limit: 10 }); if (live.current !== key) return; setItems((p) => reset ? r.items : [...p, ...r.items.filter((x) => !p.some((y) => y.slug === x.slug))]); setCursor(r.next_cursor); setDone(!r.next_cursor); if (r.model_version) mv.current = r.model_version; }
    catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  }, [filter.sort, filter.label, filter.tag, cursor, key]);
  useEffect(() => { live.current = key; setItems([]); setCursor(null); setDone(false); audio.stop(); void load(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [key]);
  const feedEl = useRef<HTMLDivElement | null>(null); const [active, setActive] = useState(0); const [candidate, setCandidate] = useState(0);
  // Autoplay: the card that is >= 60% in view is active; it plays once audio is unlocked (first tap), and the next card preloads.
  useEffect(() => {
    const root = feedEl.current; if (!root) return;
    const io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting && e.intersectionRatio >= 0.6) setCandidate(Number((e.target as HTMLElement).dataset.idx)); }, { root, threshold: [0.6] });
    root.querySelectorAll("[data-idx]").forEach((el) => io.observe(el)); return () => io.disconnect();
  }, [items.length]);
  useEffect(() => { if (audio.cur) attachAudio(audio.cur, audio.xf.current?.currentEl ?? null); }, [audio.cur, audio.xf]);
  useEffect(() => () => endImpression(), []);
  // Snap settle: the crossfade starts only once scrolling stops (scrollend, or 120 ms without scroll events).
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    const root = feedEl.current; if (!root) return; let t: ReturnType<typeof setTimeout> | undefined;
    const done = () => { clearTimeout(t); const cards = [...root.querySelectorAll<HTMLElement>("[data-idx]")]; const mid = root.scrollTop + root.clientHeight / 2; const near = cards.reduce((b, el) => Math.abs(el.offsetTop + el.offsetHeight / 2 - mid) < Math.abs(b.offsetTop + b.offsetHeight / 2 - mid) ? el : b, cards[0]); if (near) setActive(Number(near.dataset.idx)); setSettled((n) => n + 1); };
    const on = () => { clearTimeout(t); t = setTimeout(done, 120); };
    root.addEventListener("scroll", on, { passive: true }); root.addEventListener("scrollend", done);
    return () => { clearTimeout(t); root.removeEventListener("scroll", on); root.removeEventListener("scrollend", done); };
  }, []);
  useEffect(() => { const s = items[active]; if (!s) return; startImpression(s.slug, active, filter.tag ? `tag` : filter.label ? "label" : filter.sort, mv.current); audio.preload([items[active], items[active + 1], items[active - 1]]); if (audio.unlocked) audio.start(s); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [active, settled, items.length > 0, audio.unlocked]);
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
        {!audio.unlocked && items.some(srcOf) && <button className="so-unlock" data-testid="tap-to-play" onClick={() => { const s = items[active]; if (s) audio.start(s, true); }}>🔊 Tap to play</button>}
        {items.map((s, i) => <Card key={s.slug} idx={i} song={s} me={me} playing={audio.cur === s.slug} live={i === active ? { el: audio.cur === s.slug ? audio.xf.current?.currentEl ?? null : null, analyser: audio.xf.current?.analyser ?? null } : null} onPlay={audio.toggle} onUpdate={(n) => setItems((p) => p.map((x) => x.slug === n.slug ? n : x))} onSheet={onSheet} onFilter={(f) => setFilter({ sort: "new", ...f })} onOpen={onOpen} />)}
        {!loading && !items.length && !err && <div className="so-empty" data-testid="feed-empty">Nothing here yet. <button className="so-btn pri" onClick={() => navigate("studio")}>Compose the first one</button></div>}
        {err && <div className="so-empty so-err">{err} <button className="so-btn" onClick={() => void load(true)}>Retry</button></div>}
        <div ref={sentinel} className="so-sentinel">{loading ? "Loading…" : done && items.length ? "You're all caught up." : ""}</div>
      </div>
    </>
  );
}

function CommentsSheet({ song, me, onSheet, onCount }: { song: Song; me: Me | null; onSheet: (s: Sheet) => void; onCount: () => void }) {
  const [items, setItems] = useState<SComment[] | null>(null); const [next, setNext] = useState<string | null>(null); const [text, setText] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { void social.comments(song.slug).then((r) => { setItems(r.items); setNext(r.next_cursor); }).catch((e) => setErr((e as Error).message)); }, [song.slug]);
  const post = async () => { const b = text.trim(); if (!b) return; setBusy(true); setErr(""); try { const c = await social.comment(song.slug, b); markAction(song.slug, "comment"); setItems((p) => [c, ...(p ?? [])]); setText(""); onCount(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  return (
    <div data-testid="comments-sheet">
      {song.prompt_shared && song.prompt_text && <div className="so-prompt">Prompt: {song.prompt_text} <button className="so-link" data-testid="sheet-remix" onClick={() => remix(song.prompt_text!)}>Remix</button></div>}
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
      {me ? (
        <form className="so-row so-compose" onSubmit={(e) => { e.preventDefault(); void post(); }}>
          <input data-testid="comment-input" value={text} maxLength={500} placeholder="Add a comment" onChange={(e) => setText(e.target.value)} />
          <button className="so-btn pri" data-testid="comment-send" disabled={busy || !text.trim()}>Post</button>
        </form>
      ) : <a className="so-btn pri" href={signInUrl()} data-testid="comment-signin">Sign in with Google to comment</a>}
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
    <form data-testid="report-sheet" onSubmit={async (e) => { e.preventDefault(); try { await social.report(what, target, reason); done("Thanks, we'll review it."); } catch (x) { setErr((x as Error).message); } }}>
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
  if (!h) return <div className="so-pad"><p>Sign in to see your profile and songs.</p><a className="so-btn pri" href={signInUrl()} data-testid="profile-signin">Sign in with Google</a></div>;
  if (err) return <div className="so-pad so-err">{err}</div>;
  if (!d) return <div className="so-pad so-dim">Loading…</div>;
  const mine = me?.handle === d.user.handle;
  return (
    <div className="so-pad" data-testid="profile-view">
      <div className="so-row"><div className="so-av">{d.user.display_name.slice(0, 1).toUpperCase()}</div><div className="so-grow"><h2 data-testid="profile-name">{d.user.display_name}{d.user.badge && <span className="so-badge" data-testid="profile-badge">{d.user.badge}</span>}</h2><div className="so-dim">@{d.user.handle} · {d.user.song_count} songs{d.user.rating_avg !== null ? ` · ★${d.user.rating_avg.toFixed(1)}` : ""}</div>{d.user.bio && <div className="so-bio" data-testid="profile-bio">{d.user.bio}</div>}</div></div>
      {!mine && <p className="so-row"><button className="so-btn" disabled title="Messages arrive in the next update">✉ Message</button><button className="so-btn" data-testid="profile-report" onClick={() => (me ? onSheet({ kind: "report", what: "user", target: d.user.handle, label: `@${d.user.handle}` }) : onSheet({ kind: "signin", why: "Sign in to report." }))}>Report</button></p>}
      {mine && me && (
        <form className="so-settings" data-testid="profile-settings" onSubmit={async (e) => { e.preventDefault(); setMsg(""); try { const m = await social.settings({ display_name: name, ...(hd !== me.handle ? { handle: hd } : {}) }); setMe(m); setMsg("Saved"); if (m.handle !== h) navigate(`u/${m.handle}`); } catch (x) { setMsg((x as Error).message); } }}>
          <label>Display name <input data-testid="settings-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
          <label>Handle {me.handle_changed ? <span className="so-dim">(already changed once)</span> : <span className="so-dim">(can be changed once)</span>}<input data-testid="settings-handle" value={hd} maxLength={20} disabled={me.handle_changed} onChange={(e) => setHd(e.target.value.toLowerCase())} /></label>
          <div className="so-row"><button className="so-btn pri" data-testid="settings-save">Save</button><span className="so-dim" data-testid="settings-msg">{msg}</span>{me.is_admin && <a href="/admin/reports" onClick={(e) => { e.preventDefault(); navigate("admin/reports"); }} data-testid="admin-link">Report queue</a>}</div>
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
  useEffect(() => { void social.me().then(setMe).catch(() => setMe(null)); }, []);
  const filter = route.view === "feed" ? { sort: route.tag || route.label ? "new" : (route.sort ?? "for_you"), label: route.label, tag: route.tag } : { sort: "for_you" };
  const setFilter = (f: { sort: string; label?: string; tag?: string }) => navigate(f.tag ? `t/${f.tag}` : f.label ? `feed?label=${f.label}` : f.sort === "for_you" ? "" : `feed?sort=${f.sort}`);
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2000); };
  const tab = route.view === "feed" ? "feed" : route.view === "inbox" ? "inbox" : "me";
  const [bump, setBump] = useState(0);
  return (
    <div className="so-app" data-testid="social-app">
      <header className="so-top"><a href="/" onClick={(e) => { e.preventDefault(); navigate(""); }}><b>gbk</b></a><span className="so-grow" />{me ? <span className="so-dim" data-testid="me-handle">@{me.handle}</span> : <a className="so-btn" href={signInUrl()} data-testid="signin">Sign in</a>}</header>
      <main className="so-main" key={bump}>
        {route.view === "feed" && <FeedView me={me} filter={filter} setFilter={setFilter} onSheet={setSheet} onOpen={onOpen} />}
        {route.view === "profile" && <ProfileView handle={route.handle} me={me} onSheet={setSheet} setMe={setMe} />}
        {route.view === "inbox" && <div className="so-pad" data-testid="inbox-view"><h2>Inbox</h2>{me ? <p className="so-dim">Direct messages are coming in the next update. You'll be able to message any signed-in musician, and block, report or turn DMs off.</p> : <><p>Sign in to use messages.</p><a className="so-btn pri" href={signInUrl()}>Sign in with Google</a></>}</div>}
        {route.view === "admin" && (me?.is_admin ? <AdminView /> : <div className="so-pad so-dim">Admins only.</div>)}
      </main>
      <nav className="so-tabs" data-testid="tabs">
        <button className={tab === "feed" ? "on" : ""} data-testid="tab-feed" onClick={() => navigate("")}>▶<br />Feed</button>
        <button data-testid="tab-create" onClick={() => navigate("studio")}>＋<br />Create</button>
        <button className={tab === "inbox" ? "on" : ""} data-testid="tab-inbox" onClick={() => navigate("inbox")}>✉<br />Inbox</button>
        <button className={tab === "me" ? "on" : ""} data-testid="tab-profile" onClick={() => navigate(me ? `u/${me.handle}` : "me")}>◉<br />Profile</button>
      </nav>
      {sheet && <div className="so-scrim" onClick={() => setSheet(null)} />}
      {sheet && (
        <div className="so-sheet" role="dialog" aria-modal="true" data-testid="sheet">
          <header><b>{sheet.kind === "comments" ? `Comments · ${sheet.song.title}` : sheet.kind === "browse" ? "Browse" : sheet.kind === "report" ? "Report" : "Sign in"}</b><button className="so-btn" data-testid="sheet-close" aria-label="Close" onClick={() => setSheet(null)}>✕</button></header>
          <div className="so-sheetbody">
            {sheet.kind === "comments" && <CommentsSheet song={sheet.song} me={me} onSheet={setSheet} onCount={() => setBump((x) => x)} />}
            {sheet.kind === "browse" && <BrowseSheet onPick={(f) => { setSheet(null); setFilter({ sort: "new", ...f }); }} />}
            {sheet.kind === "report" && <ReportSheet what={sheet.what} target={sheet.target} label={sheet.label} done={(m) => { setSheet(null); say(m); }} />}
            {sheet.kind === "signin" && <div><p>{sheet.why} Guests can browse, play and read.</p><a className="so-btn pri" href={signInUrl()} data-testid="sheet-signin">Sign in with Google</a></div>}
          </div>
        </div>
      )}
      {toast && <div className="so-toast" role="status" data-testid="toast">{toast}</div>}
    </div>
  );
}
