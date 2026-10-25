import { useEffect, useMemo, useRef, useState } from "react";
import type { Note, Project } from "../../workstation/model.ts";
import { bars as barList, tickToSec } from "../../workstation/timing.ts";
import { diffNotes } from "../../workstation/diff.ts";
import { buildNoteIndex, visibleNotes } from "../../workstation/visible.ts";
import type { Proposal } from "../../workstation/controller.ts";
import { workstation } from "./useWorkstation.ts";

export interface View { scrollTick: number; pxPerTick: number; lowPitch: number; highPitch: number }
const KEY_W = 36;

interface Props { project: Project; proposal: Proposal | null; view: View; setView: (v: View) => void; height: number; onManualScroll?: () => void; onWidth?: (px: number) => void }

export function PianoRollEditor({ project, proposal, view, setView, height, onManualScroll, onWidth }: Props) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const drag = useRef<null | { kind: "select" | "move" | "resize"; startTick: number; startPitch: number; noteIds: string[]; dTick: number; dPitch: number; x0: number }>(null);
  const sel = project.selection;
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
  const snap = (t: number) => { const q = project.ppq / 4; return Math.round(t / q) * q; };
  const noteAt = (px: number, py: number): Note | undefined => {
    const t = tickAt(px), p = pitchAt(py);
    const cand = visibleNotes(noteIndex, t, t);
    for (let i = cand.length - 1; i >= 0; i--) { const n = cand[i]; if (n.pitch === p && n.tick <= t && n.tick + n.duration >= t && trackById.get(n.trackId)?.visible !== false) return n; }
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
      g.fillStyle = "#14161b"; g.fillRect(0, 0, width, height);
      for (let p = view.lowPitch; p <= view.highPitch; p++) if ([1, 3, 6, 8, 10].includes(p % 12)) { g.fillStyle = "#101216"; g.fillRect(KEY_W, y(p), width, rowH); }
      // selection
      if (sel.endTick > sel.startTick) { g.fillStyle = "rgba(120,170,255,0.12)"; g.fillRect(x(sel.startTick), 0, (sel.endTick - sel.startTick) * view.pxPerTick, height); }
      if (project.loop.enabled) { g.strokeStyle = "#ffb74d"; g.strokeRect(x(project.loop.startTick), 1, (project.loop.endTick - project.loop.startTick) * view.pxPerTick, height - 2); }
      // bars/beats (LOD: skip beats when dense)
      g.font = "10px sans-serif";
      for (const b of barsMemo) {
        if (b.tick + b.length < view.scrollTick) continue; if (b.tick > endTick) break;
        g.fillStyle = "#3a3f4b"; g.fillRect(x(b.tick), 0, 1, height);
        if (b.ticksPerBeat * view.pxPerTick > 8) { g.fillStyle = "#23262e"; for (let k = 1; k < b.numerator; k++) g.fillRect(x(b.tick + k * b.ticksPerBeat), 0, 1, height); }
        if (b.length * view.pxPerTick > 24 || b.index % 4 === 1) { g.fillStyle = "#8a90a0"; g.fillText(String(b.index), x(b.tick) + 3, 10); }
      }
      // notes (culled)
      const removed = new Set(diff?.removed.map((n) => n.id) ?? []);
      const moved = new Map(diff?.moved.map((m) => [m.before.id, m.after]) ?? []);
      const selIds = new Set(sel.noteIds);
      const margin = (width * 0.25) / view.pxPerTick;
      for (const n of visibleNotes(noteIndex, view.scrollTick - margin, endTick + margin)) {
        if (n.tick > endTick || n.tick + n.duration < view.scrollTick || n.pitch < view.lowPitch || n.pitch > view.highPitch) continue;
        const t = trackById.get(n.trackId); if (t && !t.visible) continue;
        const alpha = 0.35 + (n.velocity / 127) * 0.65;
        g.globalAlpha = alpha; g.fillStyle = t?.color ?? "#ccc";
        g.fillRect(x(n.tick), y(n.pitch) + 0.5, Math.max(2, n.duration * view.pxPerTick - 1), Math.max(1, rowH - 1));
        g.globalAlpha = 1;
        if (selIds.has(n.id)) { g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.strokeRect(x(n.tick), y(n.pitch) + 0.5, Math.max(2, n.duration * view.pxPerTick - 1), Math.max(1, rowH - 1)); }
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
        g.fillStyle = "#ffd180"; g.fillText(`§ ${sec.name}${sec.energy !== undefined ? ` (${Math.round(sec.energy * 100)}%)` : ""}`, x(t0) + 4, 22);
      });
      g.fillStyle = "#80d8ff";
      for (const t of project.tempos) if (t.tick > 0 && t.tick >= view.scrollTick && t.tick <= endTick) { g.fillRect(x(t.tick), height - 14, 1, 14); g.fillText(`♩=${Math.round(60e6 / t.microPerQuarter)}`, x(t.tick) + 3, height - 4); }
      for (const t of project.timeSigs) if (t.tick > 0 && t.tick >= view.scrollTick && t.tick <= endTick) g.fillText(`${t.numerator}/${t.denominator}`, x(t.tick) + 3, height - 16);
      // keyboard
      for (let p = view.lowPitch; p <= view.highPitch; p++) {
        g.fillStyle = [1, 3, 6, 8, 10].includes(p % 12) ? "#222" : "#ddd"; g.fillRect(0, y(p), KEY_W - 2, rowH - 0.5);
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
  }, [project, diff, view, width, height, barsMemo, noteIndex]);

  const onPointerDown = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    if (px < KEY_W) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const n = noteAt(px, py);
    if (n) {
      const ids = sel.noteIds.includes(n.id) ? sel.noteIds : [n.id];
      if (!sel.noteIds.includes(n.id)) workstation.setSelection({ noteIds: ids, trackIds: [n.trackId] });
      const nearEnd = Math.abs(x(n.tick + n.duration) - px) < 5;
      drag.current = { kind: nearEnd ? "resize" : "move", startTick: tickAt(px), startPitch: pitchAt(py), noteIds: ids, dTick: 0, dPitch: 0, x0: px };
    } else {
      const t = snap(tickAt(px));
      drag.current = { kind: "select", startTick: t, startPitch: pitchAt(py), noteIds: [], dTick: 0, dPitch: 0, x0: px };
      workstation.setSelection({ startTick: t, endTick: t, noteIds: [] });
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    const d = drag.current;
    if (!d) {
      const n = noteAt(px, py);
      setHover(n ? { x: px, y: py, text: `${trackById.get(n.trackId)?.name ?? ""} · pitch ${n.pitch} · vel ${n.velocity} · tick ${n.tick} (${tickToSec(project, n.tick).toFixed(2)}s) · dur ${n.duration}` } : null);
      return;
    }
    if (d.kind === "select") {
      const t = snap(tickAt(px)); const [a, b] = t < d.startTick ? [t, d.startTick] : [d.startTick, t];
      const noteIds = project.notes.filter((n) => n.tick >= a && n.tick < b && trackById.get(n.trackId)?.visible !== false).map((n) => n.id);
      workstation.setSelection({ startTick: a, endTick: b, noteIds });
    } else { d.dTick = snap(tickAt(px) - d.startTick); d.dPitch = pitchAt(py) - d.startPitch; }
  };
  const onPointerUp = () => {
    const d = drag.current; drag.current = null; if (!d) return;
    if (d.kind === "select") return;
    if (!d.dTick && !d.dPitch) return;
    const byId = new Map(project.notes.map((n) => [n.id, n]));
    const updates = d.noteIds.map((id) => { const n = byId.get(id)!; return d.kind === "move"
      ? { id, tick: Math.max(0, n.tick + d.dTick), pitch: Math.max(0, Math.min(127, n.pitch + d.dPitch)) }
      : { id, duration: Math.max(project.ppq / 16, n.duration + d.dTick) }; });
    try { workstation.userEdit([{ op: "updateNotes", updates }], { label: d.kind === "move" ? "move notes" : "resize notes" }); } catch (err) { console.warn(err); }
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const r = canvas.current!.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
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
  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) setView({ ...view, pxPerTick: Math.max(0.005, Math.min(2, view.pxPerTick * (e.deltaY < 0 ? 1.15 : 1 / 1.15))) });
    else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { onManualScroll?.(); setView({ ...view, scrollTick: Math.max(0, view.scrollTick + (e.deltaX || e.deltaY) / view.pxPerTick) }); }
    else { const d = e.deltaY > 0 ? -2 : 2; const lo = Math.max(0, Math.min(127 - (view.highPitch - view.lowPitch), view.lowPitch + d)); setView({ ...view, lowPitch: lo, highPitch: lo + (view.highPitch - view.lowPitch) }); }
  };

  return (
    <div ref={wrap} className="ws-roll" style={{ position: "relative", height }} data-scroll-tick={Math.round(view.scrollTick)} data-visible-ticks={Math.round((width - KEY_W) / view.pxPerTick)}>
      <canvas ref={canvas} style={{ width: "100%", height, display: "block", touchAction: "none" }} tabIndex={0} role="application"
        aria-label="Piano roll editor. Drag to select a range, drag notes to move, drag note end to resize, double-click to add or delete, arrows transpose/scroll, alt+arrows nudge, +/- zoom, Delete removes."
        data-testid="piano-roll" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onDoubleClick={onDoubleClick} onKeyDown={onKeyDown} onWheel={onWheel} onPointerLeave={() => setHover(null)} />
      {hover && <div className="ws-tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>{hover.text}</div>}
    </div>
  );
}
