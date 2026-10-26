import { useEffect, useMemo, useRef, useState } from "react";
import type { Note, Project } from "../../workstation/model.ts";
import { bars as barList, tickToSec } from "../../workstation/timing.ts";
import { diffNotes } from "../../workstation/diff.ts";
import { buildNoteIndex, visibleNotes } from "../../workstation/visible.ts";
import type { Proposal } from "../../workstation/controller.ts";
import { workstation } from "./useWorkstation.ts";
import { EDGE_PX, edgeVector, panStep, wheelFactor, zoomPitchAt, zoomTimeAt } from "../../workstation/roll-zoompan.ts";

export const ROLL_HINT = "Scroll to zoom time · Shift+scroll (or Alt) for pitch · pinch zooms · hover the edges to pan";

export interface View { scrollTick: number; pxPerTick: number; lowPitch: number; highPitch: number }
const KEY_W = 36;
// Dark workstation palette on desktop; phones (<500px) follow prefers-color-scheme (bright when light).
// The desktop studio grid (themeAuto) follows prefers-color-scheme at every width (bright by default).
export const rollDark = (auto?: boolean) => auto ? matchMedia("(prefers-color-scheme: dark)").matches : !matchMedia("(prefers-color-scheme: light) and (max-width: 499px)").matches;
export type RollTool = "draw" | "select" | "erase";
export const ROLL_KEY_W = KEY_W;

interface Props { project: Project; proposal: Proposal | null; view: View; setView: (v: View) => void; height: number; onManualScroll?: () => void; onWidth?: (px: number) => void;
  /** Desktop studio: explicit tool (undefined = the original click-to-add behaviour). */ tool?: RollTool;
  /** Grid for drawing/moving (ticks, 0 = off). Default: a 16th note. */ snapTicks?: number;
  /** Focused track: other tracks are drawn as faint, non-editable ghost notes. */ focusTrackId?: string | null;
  /** Follow prefers-color-scheme at every width. */ themeAuto?: boolean;
  /** Double-click on a note (tool mode): e.g. focus its track. */ onNoteDoubleClick?: (n: Note) => void }

export function PianoRollEditor({ project, proposal, view, setView, height, onManualScroll, onWidth, tool, snapTicks, focusTrackId, themeAuto, onNoteDoubleClick }: Props) {
  const dark = () => rollDark(themeAuto);
  const [, setScheme] = useState(0);
  useEffect(() => { if (!themeAuto) return; const mq = matchMedia("(prefers-color-scheme: dark)"); const f = () => setScheme((x) => x + 1); mq.addEventListener("change", f); return () => mq.removeEventListener("change", f); }, [themeAuto]);
  const [draft, setDraft] = useState<{ tick: number; pitch: number; duration: number } | null>(null);
  const erase = useRef<Set<string> | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const drag = useRef<null | { kind: "select" | "move" | "resize" | "draw"; startTick: number; startPitch: number; noteIds: string[]; dTick: number; dPitch: number; x0: number; hadNotes?: boolean; moved?: boolean }>(null);
  const clickAdded = useRef(0);
  // Desktop studio (explicit tools): wheel zooms at the cursor, hovering an edge auto-pans.
  const zp = tool !== undefined;
  const [edge, setEdge] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const [toast, setToast] = useState<{ x: number; y: number; text: string } | null>(null);
  const [hint, setHint] = useState(() => { try { return zp && !localStorage.getItem("gbk.rollZoomHint"); } catch { return false; } });
  const live = useRef({ view, setView, onManualScroll, maxScroll: 0 });
  const edgeRef = useRef({ dx: 0, dy: 0 }); const panRaf = useRef(0); const rowAcc = useRef({ rows: 0 }); const toastT = useRef(0);
  const sel = project.selection;
  live.current = { view, setView, onManualScroll, maxScroll: Math.max(0, project.endTick + project.ppq * 8 - (width - KEY_W) / view.pxPerTick) };
  const rowH = height / (view.highPitch - view.lowPitch + 1);
  const diff = useMemo(() => (proposal ? diffNotes(proposal.original, proposal.candidate) : null), [proposal]);
  const barsMemo = useMemo(() => barList(project, project.endTick + project.ppq * 16), [project.timeSigs, project.ppq, project.endTick]);
  const noteIndex = useMemo(() => buildNoteIndex(project.notes), [project.notes]);
  const trackById = useMemo(() => new Map(project.tracks.map((t) => [t.id, t])), [project.tracks]);

  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const upd = () => { setWidth(el.clientWidth); onWidth?.(el.clientWidth - KEY_W); }; const ro = new ResizeObserver(upd); ro.observe(el); upd();
    return () => ro.disconnect();
  }, []);

  const x = (tick: number) => KEY_W + (tick - view.scrollTick) * view.pxPerTick;
  const y = (pitch: number) => (view.highPitch - pitch) * rowH;
  const tickAt = (px: number) => Math.max(0, Math.round(view.scrollTick + (px - KEY_W) / view.pxPerTick));
  const pitchAt = (py: number) => Math.max(0, Math.min(127, view.highPitch - Math.floor(py / rowH)));
  const grid = snapTicks === undefined ? project.ppq / 4 : snapTicks;
  const snap = (t: number) => (grid > 0 ? Math.round(t / grid) * grid : Math.round(t));
  const snapDown = (t: number) => (grid > 0 ? Math.floor(t / grid) * grid : Math.round(t));
  const editable = (n: Note) => trackById.get(n.trackId)?.visible !== false && (!focusTrackId || n.trackId === focusTrackId);
  const noteAt = (px: number, py: number): Note | undefined => {
    const t = tickAt(px), p = pitchAt(py);
    const cand = visibleNotes(noteIndex, t, t);
    for (let i = cand.length - 1; i >= 0; i--) { const n = cand[i]; if (n.pitch === p && n.tick <= t && n.tick + n.duration >= t && editable(n)) return n; }
  };

  // Static layer (grid + notes + overlays) redrawn when inputs change; playhead on rAF.
  useEffect(() => {
    const cv = canvas.current; if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = width * dpr; cv.height = height * dpr;
    const g = cv.getContext("2d")!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    let raf = 0;
    const endTick = view.scrollTick + (width - KEY_W) / view.pxPerTick;
    const draw = () => {
      const dk = dark(); g.fillStyle = dk ? (themeAuto ? "#12151c" : "#14161b") : (themeAuto ? "#fbfbfd" : "#ffffff"); g.fillRect(0, 0, width, height);
      for (let p = view.lowPitch; p <= view.highPitch; p++) if ([1, 3, 6, 8, 10].includes(p % 12)) { g.fillStyle = dk ? (themeAuto ? "#171a22" : "#101216") : "#f1f2f6"; g.fillRect(KEY_W, y(p), width, rowH); }
      // selection
      if (sel.endTick > sel.startTick) { g.fillStyle = "rgba(120,170,255,0.12)"; g.fillRect(x(sel.startTick), 0, (sel.endTick - sel.startTick) * view.pxPerTick, height); }
      if (project.loop.enabled) { g.strokeStyle = "#ffb74d"; g.strokeRect(x(project.loop.startTick), 1, (project.loop.endTick - project.loop.startTick) * view.pxPerTick, height - 2); }
      // bars/beats (LOD: skip beats when dense)
      g.font = "10px sans-serif";
      for (const b of barsMemo) {
        if (b.tick + b.length < view.scrollTick) continue; if (b.tick > endTick) break;
        g.fillStyle = dk ? "#3a3f4b" : "#c3cbd8"; g.fillRect(x(b.tick), 0, 1, height);
        if (b.ticksPerBeat * view.pxPerTick > 8) { g.fillStyle = dk ? "#23262e" : "#e3e8f0"; for (let k = 1; k < b.numerator; k++) g.fillRect(x(b.tick + k * b.ticksPerBeat), 0, 1, height); }
        if (b.length * view.pxPerTick > 24 || b.index % 4 === 1) { g.fillStyle = dk ? "#8a90a0" : "#5b6677"; g.fillText(String(b.index), x(b.tick) + 3, 10); }
      }
      // notes (culled)
      const removed = new Set(diff?.removed.map((n) => n.id) ?? []);
      const moved = new Map(diff?.moved.map((m) => [m.before.id, m.after]) ?? []);
      const selIds = new Set(sel.noteIds);
      const margin = (width * 0.25) / view.pxPerTick;
      for (const n of visibleNotes(noteIndex, view.scrollTick - margin, endTick + margin)) {
        if (n.tick > endTick || n.tick + n.duration < view.scrollTick || n.pitch < view.lowPitch || n.pitch > view.highPitch) continue;
        const t = trackById.get(n.trackId); if (t && !t.visible) continue;
        const ghost = !!focusTrackId && n.trackId !== focusTrackId;
        const alpha = ghost ? 0.16 : 0.35 + (n.velocity / 127) * 0.65;
        g.globalAlpha = alpha; g.fillStyle = t?.color ?? "#ccc";
        g.fillRect(x(n.tick), y(n.pitch) + 0.5, Math.max(2, n.duration * view.pxPerTick - 1), Math.max(1, rowH - 1));
        g.globalAlpha = 1;
        if (selIds.has(n.id)) { g.strokeStyle = dk || !themeAuto ? "#fff" : "#111"; g.lineWidth = 1.5; g.strokeRect(x(n.tick), y(n.pitch) + 0.5, Math.max(2, n.duration * view.pxPerTick - 1), Math.max(1, rowH - 1)); }
        if (removed.has(n.id) || moved.has(n.id)) { g.strokeStyle = "#ff5252"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x(n.tick), y(n.pitch)); g.lineTo(x(n.tick + n.duration), y(n.pitch) + rowH); g.stroke(); }
      }
      // proposal overlays: added + moved-after as dashed translucent
      if (diff) {
        g.setLineDash([4, 3]); g.lineWidth = 1.5;
        for (const n of [...diff.added, ...diff.moved.map((m) => m.after)]) {
          if (n.tick > endTick || n.tick + n.duration < view.scrollTick) continue;
          g.fillStyle = "rgba(124,255,178,0.35)"; g.strokeStyle = "#7cffb2";
          g.fillRect(x(n.tick), y(n.pitch), n.duration * view.pxPerTick, rowH); g.strokeRect(x(n.tick), y(n.pitch), n.duration * view.pxPerTick, rowH);
        }
        g.setLineDash([]);
      }
      // song structure: section bands + labels, tempo / meter change markers (from the project model)
      const SEC_COLORS = ["rgba(79,195,247,0.10)", "rgba(255,183,77,0.10)", "rgba(129,199,132,0.10)", "rgba(186,104,200,0.10)"];
      (project.meta?.sections ?? []).forEach((sec, i) => {
        const b0 = barsMemo[sec.startBar - 1], b1 = barsMemo[sec.startBar - 1 + sec.bars];
        if (!b0) return;
        const t0 = b0.tick, t1 = b1 ? b1.tick : b0.tick + b0.length * sec.bars;
        if (t1 < view.scrollTick || t0 > endTick) return;
        g.fillStyle = SEC_COLORS[i % SEC_COLORS.length]; g.fillRect(x(t0), 12, (t1 - t0) * view.pxPerTick, height - 12);
        g.fillStyle = "#e0c080"; g.fillRect(x(t0), 0, 2, height);
        g.fillStyle = dk ? "#ffd180" : "#9a6400"; g.fillText(`§ ${sec.name}${sec.energy !== undefined ? ` (${Math.round(sec.energy * 100)}%)` : ""}`, x(t0) + 4, 22);
      });
      g.fillStyle = "#80d8ff";
      for (const t of project.tempos) if (t.tick > 0 && t.tick >= view.scrollTick && t.tick <= endTick) { g.fillRect(x(t.tick), height - 14, 1, 14); g.fillText(`♩=${Math.round(60e6 / t.microPerQuarter)}`, x(t.tick) + 3, height - 4); }
      for (const t of project.timeSigs) if (t.tick > 0 && t.tick >= view.scrollTick && t.tick <= endTick) g.fillText(`${t.numerator}/${t.denominator}`, x(t.tick) + 3, height - 16);
      // keyboard
      for (let p = view.lowPitch; p <= view.highPitch; p++) {
        g.fillStyle = [1, 3, 6, 8, 10].includes(p % 12) ? (themeAuto && !dk ? "#2b2d33" : "#222") : (themeAuto && !dk ? "#ffffff" : "#ddd"); g.fillRect(0, y(p), KEY_W - 2, rowH - 0.5);
        if (p % 12 === 0 && rowH > 6) { g.fillStyle = "#333"; g.fillText(`C${p / 12 - 1}`, 2, y(p) + rowH - 1); }
      }
    };
    const tick = () => {
      draw();
      const pos = workstation.getState().transport.positionTick;
      g.fillStyle = "#ff4081"; g.fillRect(x(pos), 0, 2, height);
      if (workstation.getState().transport.playing) raf = requestAnimationFrame(tick);
    };
    tick();
    const unsub = workstation.subscribe((s) => { if (s.transport.playing && !raf) raf = requestAnimationFrame(tick); else if (!s.transport.playing) { cancelAnimationFrame(raf); raf = 0; tick(); } });
    return () => { cancelAnimationFrame(raf); unsub(); };
  }, [project, diff, view, width, height, barsMemo, noteIndex, focusTrackId, themeAuto, dark()]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (zp) { dismissHint(); stopPan(); }
    const r = canvas.current!.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    if (px < KEY_W) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const n = noteAt(px, py);
    if (tool === "erase") { erase.current = new Set(n ? [n.id] : []); setDraft(null); return; }
    if (tool === "draw" && !n) {
      const t = snapDown(tickAt(px)); const len = grid > 0 ? grid : project.ppq / 4;
      drag.current = { kind: "draw", startTick: t, startPitch: pitchAt(py), noteIds: [], dTick: 0, dPitch: 0, x0: px };
      setDraft({ tick: t, pitch: pitchAt(py), duration: len }); return;
    }
    if (n) {
      const ids = sel.noteIds.includes(n.id) ? sel.noteIds : [n.id];
      if (!sel.noteIds.includes(n.id)) workstation.setSelection({ noteIds: ids, trackIds: [n.trackId] });
      const nearEnd = Math.abs(x(n.tick + n.duration) - px) < 5;
      drag.current = { kind: nearEnd ? "resize" : "move", startTick: tickAt(px), startPitch: pitchAt(py), noteIds: ids, dTick: 0, dPitch: 0, x0: px };
    } else {
      const t = snap(tickAt(px));
      drag.current = { kind: "select", startTick: t, startPitch: pitchAt(py), noteIds: [], dTick: 0, dPitch: 0, x0: px, hadNotes: sel.noteIds.length > 0 };
      workstation.setSelection({ startTick: t, endTick: t, noteIds: [] });
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    const d = drag.current;
    if (erase.current) { const n = noteAt(px, py); if (n && !erase.current.has(n.id)) { erase.current.add(n.id); setHover({ x: px, y: py, text: `erase ${erase.current.size}` }); } return; }
    if (d?.kind === "draw") { const len = grid > 0 ? grid : project.ppq / 4; const end = Math.max(d.startTick + len, grid > 0 ? Math.ceil(tickAt(px) / grid) * grid : tickAt(px)); setDraft({ tick: d.startTick, pitch: d.startPitch, duration: end - d.startTick }); return; }
    if (zp) updateEdge(d || erase.current ? 0 : px, py, !d && !erase.current);
    if (!d) {
      const n = noteAt(px, py);
      setHover(n ? { x: px, y: py, text: `${trackById.get(n.trackId)?.name ?? ""} · pitch ${n.pitch} · vel ${n.velocity} · tick ${n.tick} (${tickToSec(project, n.tick).toFixed(2)}s) · dur ${n.duration}` } : null);
      return;
    }
    if (d.kind === "select") {
      if (Math.abs(px - d.x0) > 4) d.moved = true;
      const t = snap(tickAt(px)); const [a, b] = t < d.startTick ? [t, d.startTick] : [d.startTick, t];
      const noteIds = project.notes.filter((n) => n.tick >= a && n.tick < b && editable(n)).map((n) => n.id);
      workstation.setSelection({ startTick: a, endTick: b, noteIds });
    } else { d.dTick = snap(tickAt(px) - d.startTick); d.dPitch = pitchAt(py) - d.startPitch; }
  };
  const onPointerUp = (e?: React.PointerEvent) => {
    if (erase.current) { const ids = [...erase.current]; erase.current = null; setHover(null); if (ids.length) workstation.userEdit([{ op: "removeNotes", ids }], { label: ids.length > 1 ? "erase notes" : "erase note" }); return; }
    const d = drag.current; drag.current = null; if (!d) return;
    if (d.kind === "draw") {
      const nd = draft; setDraft(null); if (!nd) return;
      const track = project.tracks.find((t) => t.id === (focusTrackId ?? sel.trackIds[0])) ?? project.tracks.find((t) => t.visible) ?? project.tracks[0];
      if (!track) return;
      clickAdded.current = Date.now();
      workstation.userEdit([{ op: "addNotes", notes: [{ trackId: track.id, channel: track.channel, tick: nd.tick, duration: nd.duration, pitch: nd.pitch, velocity: 96 }] }], { label: "draw note" });
      if (!sel.trackIds.includes(track.id)) workstation.setSelection({ trackIds: [track.id] });
      return;
    }
    if (d.kind === "select") {
      if (tool) return; // explicit tools: a click on empty space only clears/sets the range
      // A plain click (no drag) on empty space with an explicitly selected track and no selected notes adds a note.
      const track = project.tracks.find((t) => t.id === sel.trackIds[0]);
      if (!d.moved && !d.hadNotes && track && track.visible && e) {
        const r = canvas.current!.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
        if (px >= KEY_W) { clickAdded.current = Date.now(); workstation.userEdit([{ op: "addNotes", notes: [{ trackId: track.id, channel: track.channel, tick: snap(tickAt(px)), duration: project.ppq, pitch: pitchAt(py), velocity: 90 }] }], { label: "add note" }); }
      }
      return;
    }
    if (!d.dTick && !d.dPitch) return;
    const byId = new Map(project.notes.map((n) => [n.id, n]));
    const updates = d.noteIds.map((id) => { const n = byId.get(id)!; return d.kind === "move"
      ? { id, tick: Math.max(0, n.tick + d.dTick), pitch: Math.max(0, Math.min(127, n.pitch + d.dPitch)) }
      : { id, duration: Math.max(project.ppq / 16, n.duration + d.dTick) }; });
    try { workstation.userEdit([{ op: "updateNotes", updates }], { label: d.kind === "move" ? "move notes" : "resize notes" }); } catch (err) { console.warn(err); }
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    if (tool) { // any note (ghosts included) -> its track
      const t = tickAt(px), p = pitchAt(py); const hitN = visibleNotes(noteIndex, t, t).filter((n) => n.pitch === p && n.tick <= t && n.tick + n.duration >= t && trackById.get(n.trackId)?.visible !== false).pop();
      if (hitN) onNoteDoubleClick?.(hitN); return;
    }
    if (Date.now() - clickAdded.current < 700) return; // the first click of this double-click already added the note
    const n = noteAt(px, py);
    if (n) { workstation.userEdit([{ op: "removeNotes", ids: [n.id] }], { label: "delete note" }); return; }
    const track = project.tracks.find((t) => t.id === sel.trackIds[0]) ?? project.tracks.find((t) => t.visible && project.notes.some((x) => x.trackId === t.id)) ?? project.tracks[0];
    if (!track) return;
    workstation.userEdit([{ op: "addNotes", notes: [{ trackId: track.id, channel: track.channel, tick: snap(tickAt(px)), duration: project.ppq, pitch: pitchAt(py), velocity: 90 }] }], { label: "add note" });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const ids = sel.noteIds;
    if ((e.key === "Delete" || e.key === "Backspace") && ids.length) { workstation.userEdit([{ op: "removeNotes", ids }], { label: "delete notes" }); e.preventDefault(); }
    else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && ids.length) {
      const dp = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 12 : 1); const byId = new Map(project.notes.map((n) => [n.id, n]));
      workstation.userEdit([{ op: "updateNotes", updates: ids.map((id) => ({ id, pitch: Math.max(0, Math.min(127, byId.get(id)!.pitch + dp)) })) }], { label: "transpose" }); e.preventDefault();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (ids.length && e.altKey) { const dt = (e.key === "ArrowRight" ? 1 : -1) * project.ppq / 4; const byId = new Map(project.notes.map((n) => [n.id, n])); workstation.userEdit([{ op: "updateNotes", updates: ids.map((id) => ({ id, tick: Math.max(0, byId.get(id)!.tick + dt) })) }], { label: "nudge" }); }
      else { onManualScroll?.(); setView({ ...view, scrollTick: Math.max(0, view.scrollTick + (e.key === "ArrowRight" ? 1 : -1) * project.ppq * 4) }); }
      e.preventDefault();
    } else if (e.key === "+" || e.key === "=") setView({ ...view, pxPerTick: Math.min(2, view.pxPerTick * 1.25) });
    else if (e.key === "-") setView({ ...view, pxPerTick: Math.max(0.005, view.pxPerTick / 1.25) });
    else if (e.key === "Escape") workstation.setSelection({ noteIds: [], startTick: 0, endTick: 0 });
  };
  const dismissHint = () => { if (!hint) return; setHint(false); try { localStorage.setItem("gbk.rollZoomHint", "1"); } catch { /* private mode */ } };
  const stopPan = () => { cancelAnimationFrame(panRaf.current); panRaf.current = 0; edgeRef.current = { dx: 0, dy: 0 }; setEdge((e) => (e.dx || e.dy ? { dx: 0, dy: 0 } : e)); };
  function updateEdge(px: number, py: number, on: boolean) {
    const v = on ? edgeVector(px - KEY_W, py, width - KEY_W, height) : { dx: 0, dy: 0 };
    if (px < KEY_W) { v.dx = 0; v.dy = 0; } // over the keyboard: no pan
    edgeRef.current = v;
    const q = { dx: Math.round(v.dx * 10) / 10, dy: Math.round(v.dy * 10) / 10 };
    setEdge((e) => (e.dx === q.dx && e.dy === q.dy ? e : q));
    if ((v.dx || v.dy) && !panRaf.current) {
      let last = performance.now();
      const step = (now: number) => {
        const { dx, dy } = edgeRef.current; if (!dx && !dy) { panRaf.current = 0; return; }
        const L = live.current; const dt = Math.min(50, now - last); last = now;
        const nv = panStep(L.view, dx, dy, dt, L.maxScroll, rowAcc.current);
        if (nv !== L.view && (nv.scrollTick !== L.view.scrollTick || nv.lowPitch !== L.view.lowPitch)) { if (nv.scrollTick !== L.view.scrollTick) L.onManualScroll?.(); L.view = nv; L.setView(nv); }
        panRaf.current = requestAnimationFrame(step);
      };
      panRaf.current = requestAnimationFrame(step);
    }
  }
  useEffect(() => () => { cancelAnimationFrame(panRaf.current); clearTimeout(toastT.current); }, []);
  // Desktop: every wheel zooms (plain = time at the cursor; Shift/Alt = pitch at the cursor; ctrlKey = trackpad pinch) and never scrolls the page.
  const zoomWheel = useRef<(e: WheelEvent) => void>(() => {});
  zoomWheel.current = (e: WheelEvent) => {
    e.preventDefault();
    const r = canvas.current!.getBoundingClientRect(); const px = Math.max(KEY_W, e.clientX - r.left), py = Math.max(0, Math.min(height, e.clientY - r.top));
    const L = live.current; const v = L.view;
    const pitch = e.shiftKey || e.altKey; const raw = pitch && !e.deltaY ? e.deltaX : (!pitch && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 2 && !e.ctrlKey ? 0 : e.deltaY);
    if (!raw) { // horizontal trackpad swipe still scrolls time
      const nv = { ...v, scrollTick: Math.max(0, Math.min(L.maxScroll, v.scrollTick + e.deltaX / v.pxPerTick)) }; L.onManualScroll?.(); L.view = nv; L.setView(nv); return;
    }
    const f = wheelFactor(raw * (e.ctrlKey ? 4 : 1), e.deltaMode);
    let nv; let text;
    if (pitch) { nv = zoomPitchAt(v, f, py / Math.max(1, height)); const rows = nv.highPitch - nv.lowPitch + 1; text = `↕ ${rows} keys · ${Math.round((128 / rows) * 100) / 100}×`; }
    else {
      const maxS = Math.max(0, project.endTick + project.ppq * 8);
      nv = zoomTimeAt(v, f, px - KEY_W, maxS); L.onManualScroll?.();
      const bars = (width - KEY_W) / nv.pxPerTick / (project.ppq * 4); text = `⟷ ${bars >= 10 ? Math.round(bars) : bars.toFixed(1)} bars · ${Math.round(nv.pxPerTick * 1000) / 10}%`;
    }
    L.view = nv; L.setView(nv); dismissHint();
    setToast({ x: e.clientX - r.left, y: e.clientY - r.top, text }); clearTimeout(toastT.current); toastT.current = window.setTimeout(() => setToast(null), 900);
  };
  // Ctrl/⌘/Alt+wheel must not zoom or scroll the page: a non-passive listener (React's wheel handlers are passive).
  useEffect(() => { const c = canvas.current; if (!c) return; const f = (e: WheelEvent) => { if (zp) zoomWheel.current(e); else if (e.ctrlKey || e.metaKey || e.altKey) e.preventDefault(); }; c.addEventListener("wheel", f, { passive: false }); return () => c.removeEventListener("wheel", f); }, [zp]);
  const onWheel = (e: React.WheelEvent) => {
    if (zp) return; // handled by the native listener above
    const r = canvas.current!.getBoundingClientRect(); const px = Math.max(KEY_W, e.clientX - r.left), py = e.clientY - r.top;
    if (e.ctrlKey || e.metaKey) { // time zoom anchored at the pointer
      const at = view.scrollTick + (px - KEY_W) / view.pxPerTick; const ppt = Math.max(0.005, Math.min(2, view.pxPerTick * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      onManualScroll?.(); setView({ ...view, pxPerTick: ppt, scrollTick: Math.max(0, at - (px - KEY_W) / ppt) });
    } else if (e.altKey) { // pitch zoom anchored at the pointer row
      const span = view.highPitch - view.lowPitch + 1; const next = Math.max(8, Math.min(128, Math.round(span * (e.deltaY < 0 ? 1 / 1.15 : 1.15)))); if (next === span) return;
      const at = view.highPitch - py / rowH; const frac = py / Math.max(1, height); let hi = Math.round(at + frac * next); hi = Math.max(next - 1, Math.min(127, hi));
      setView({ ...view, highPitch: hi, lowPitch: hi - next + 1 });
    }
    else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { onManualScroll?.(); setView({ ...view, scrollTick: Math.max(0, view.scrollTick + (e.deltaX || e.deltaY) / view.pxPerTick) }); }
    else { const d = e.deltaY > 0 ? -2 : 2; const lo = Math.max(0, Math.min(127 - (view.highPitch - view.lowPitch), view.lowPitch + d)); setView({ ...view, lowPitch: lo, highPitch: lo + (view.highPitch - view.lowPitch) }); }
  };

  useEffect(() => { if (!hint) return; const t = setTimeout(dismissHint, 12000); return () => clearTimeout(t); }, [hint]);
  return (
    <div ref={wrap} className="ws-roll" style={{ position: "relative", height }} data-scroll-tick={Math.round(view.scrollTick)} data-px-per-tick={view.pxPerTick.toFixed(5)} data-pitch-range={`${view.lowPitch}-${view.highPitch}`} data-focus-track={focusTrackId ?? ""} data-tool={tool ?? ""} data-visible-ticks={Math.round((width - KEY_W) / view.pxPerTick)}>
      <canvas ref={canvas} tabIndex={0} role="application"
        aria-label="Piano roll editor. Drag to select a range, drag notes to move, drag note end to resize, click empty space to add a note on the selected track, double-click to add or delete, arrows transpose/scroll, alt+arrows nudge, +/- zoom, Delete removes."
        data-testid="piano-roll" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onDoubleClick={onDoubleClick} onKeyDown={onKeyDown} onWheel={onWheel} onPointerLeave={() => { setHover(null); if (zp) stopPan(); }}
        title={zp ? ROLL_HINT : undefined} data-edge={zp ? `${Math.sign(edge.dx)},${Math.sign(edge.dy)}` : undefined}
        style={{ width: "100%", height, display: "block", touchAction: "none", cursor: zp ? edgeCursor(edge) : undefined }} />
      {zp && (["left", "right", "top", "bottom"] as const).map((side) => {
        const a = side === "left" ? Math.max(0, -edge.dx) : side === "right" ? Math.max(0, edge.dx) : side === "top" ? Math.max(0, -edge.dy) : Math.max(0, edge.dy);
        const pos = side === "left" ? { left: KEY_W, top: 0, bottom: 0, width: EDGE_PX } : side === "right" ? { right: 0, top: 0, bottom: 0, width: EDGE_PX } : side === "top" ? { left: KEY_W, right: 0, top: 0, height: EDGE_PX } : { left: KEY_W, right: 0, bottom: 0, height: EDGE_PX };
        return <div key={side} className={`ws-edge ws-edge-${side}`} data-testid={`roll-edge-${side}`} data-active={a > 0 ? "1" : "0"} style={{ ...pos, opacity: a > 0 ? 0.35 + 0.65 * a : 0 }} aria-hidden="true">
          <span>{side === "left" ? "‹‹" : side === "right" ? "››" : side === "top" ? "︿" : "﹀"}</span></div>;
      })}
      {toast && <div className="ws-zoom-toast" data-testid="roll-zoom-toast" style={{ left: Math.max(KEY_W + 4, Math.min(toast.x + 14, width - 170)), top: Math.max(4, Math.min(toast.y - 30, height - 28)) }}>{toast.text}</div>}
      {zp && hint && <div className="ws-roll-hint" data-testid="roll-hint">🖱 {ROLL_HINT}</div>}
      {draft && <div className="ws-draft" data-testid="roll-draft" style={{ position: "absolute", pointerEvents: "none", left: x(draft.tick), top: y(draft.pitch), width: Math.max(2, draft.duration * view.pxPerTick), height: Math.max(2, rowH), background: (trackById.get(focusTrackId ?? sel.trackIds[0] ?? "")?.color ?? "#5b5bf6"), opacity: 0.7, borderRadius: 3 }} />}
      {hover && <div className="ws-tooltip" style={{ left: Math.min(hover.x + 12, width - 260), top: hover.y + 12 }}>{hover.text}</div>}
    </div>
  );
}

function edgeCursor(e: { dx: number; dy: number }): string | undefined {
  const v = e.dy < 0 ? "n" : e.dy > 0 ? "s" : "", h = e.dx < 0 ? "w" : e.dx > 0 ? "e" : "";
  return v || h ? `${v}${h}-resize` : undefined;
}
