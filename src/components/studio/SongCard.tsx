// The song/version card shown in the studio chat (mobile and desktop): Play, Open editor, Publish (only when the
// caller passes onPublish, see the 76821f6 rule), and Restore for older versions. Styles: mobile-studio.css (.ms-song)
// plus song-card.css, which gives the card the same bright look outside the phone studio.
import { useMemo } from "react";
import type { Project } from "../../workstation/model.ts";
import { fmtTime, songSeconds, trackChips, type SongVersion } from "./studio-logic.ts";
import "./song-card.css";

export function VersionCard({ v, p, current, playing, pos, total, onPlay, onEdit, onPublish, onRestore }: { v?: SongVersion; p: Project; current: boolean; playing: boolean; pos: number; total: number; onPlay: () => void; onEdit: () => void; onPublish?: () => void; onRestore?: () => void }) {
  const song = v?.snapshot ?? p;
  const len = current ? total : songSeconds(song);
  const label = `${p.name === "Untitled" ? "Song" : p.name}${v ? (v.label ? ` · ${v.label}` : ` v${v.n}`) : ""}`;
  return <div className="ms-song" data-testid="version-card" data-version={v?.n ?? "current"} data-current={current ? "1" : "0"}>
    <div className="ms-song-t">
      <button className="ms-btn ms-play" aria-label={playing ? `Pause ${label}` : `Play ${label}`} data-testid="version-play" onClick={onPlay}>{playing ? "❚❚" : "▶︎"}</button>
      <b className="ms-grow">{label}{!v && <span className="ms-mut"> · latest edits</span>}</b>
      <span className="ms-mut ms-time">{current && playing ? fmtTime(pos) : "0:00"} / {fmtTime(len)}</span>
    </div>
    <RollThumb p={song} ph={current && playing && len > 0 ? pos / len : null} />
    <div className="ms-chips">{trackChips(song).map((c) => <span key={c} className="ms-chip">{c}</span>)}</div>
    <div className="ms-acts">
      <button data-testid="version-open-editor" onClick={onEdit}>Open editor</button>
      {onPublish && <button className="pri" data-testid="version-publish" onClick={onPublish}>Publish</button>}
    </div>
    {!current && onRestore && <button className="ms-link ms-restore" data-testid="version-restore" onClick={onRestore}>Restore this version</button>}
  </div>;
}

/** Tiny piano-roll picture of a song (at most 400 notes drawn). */
function RollThumb({ p, ph }: { p: Project; ph: number | null }) {
  const shapes = useMemo(() => {
    const ns = p.notes.length > 400 ? p.notes.filter((_, i) => i % Math.ceil(p.notes.length / 400) === 0) : p.notes;
    if (!ns.length) return [];
    let lo = 127, hi = 0, end = 1; for (const n of ns) { lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); end = Math.max(end, n.tick + n.duration); }
    const color = new Map(p.tracks.map((t) => [t.id, t.color])); const span = Math.max(12, hi - lo + 1);
    return ns.map((n) => ({ x: (n.tick / end) * 100, w: Math.max(0.6, (n.duration / end) * 100), y: ((hi - n.pitch) / span) * 56 + 4, c: color.get(n.trackId) ?? "#5b5bf6" }));
  }, [p]);
  return <div className="ms-thumb" aria-hidden><svg viewBox="0 0 100 64" preserveAspectRatio="none">{shapes.map((s, i) => <rect key={i} x={s.x} y={s.y} width={s.w} height={3.2} rx={0.8} fill={s.c} />)}</svg>
    {ph != null && <i className="ms-ph" style={{ left: `${Math.min(100, ph * 100)}%` }} />}</div>;
}
