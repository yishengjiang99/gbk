import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../../workstation/model.ts";
import type { Proposal } from "../../workstation/controller.ts";
import { workstation } from "./useWorkstation.ts";
import { lowerBound, visiblePoints } from "../../workstation/visible.ts";
import type { View } from "./PianoRollEditor.tsx";

const KEY_W = 36;
export const LANE_CHOICES = [1, 7, 10, 11, 64, 71, 74, 91, 93] as const;
const SWITCHES = new Set([64, 65, 66, 67, 68, 69]);
const NAMES: Record<number, string> = { 1: "Mod", 7: "Volume", 10: "Pan", 11: "Expression", 64: "Sustain", 71: "Resonance", 74: "Brightness", 91: "Reverb send", 93: "Chorus send" };
export type LaneKind = number | "bend" | "pressure";

interface Pt { id: string; tick: number; value: number }
interface Props { project: Project; proposal: Proposal | null; view: View; trackId: string; lane: LaneKind; onChangeLane: (l: LaneKind) => void; onRemove: () => void; width?: number }

function points(p: Project, trackId: string, lane: LaneKind): Pt[] {
  if (lane === "bend") return p.pitchBends.filter((b) => b.trackId === trackId);
  if (lane === "pressure") return p.channelPressure.filter((b) => b.trackId === trackId);
  return p.ccs.filter((c) => c.trackId === trackId && c.controller === lane);
}

export function AutomationLane({ project, proposal, view, trackId, lane, onChangeLane, onRemove, height = 72 }: Props & { height?: number }) {
  const H = height;
  const cv = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(800);
  const [live, setLive] = useState<number | null>(null);
  const drawPts = useRef<{ tick: number; value: number }[] | null>(null);
  const dragPt = useRef<Pt | null>(null);
  const max = lane === "bend" ? 16383 : 127;
  const pts = useMemo(() => points(project, trackId, lane), [project, trackId, lane]);
  const candPts = useMemo(() => (proposal && proposal.trackIds.includes(trackId) ? points(proposal.candidate, trackId, lane) : null), [proposal, trackId, lane]);
  const track = project.tracks.find((t) => t.id === trackId);
  const x = (t: number) => KEY_W + (t - view.scrollTick) * view.pxPerTick;
  const yv = (v: number) => H - 4 - (v / max) * (H - 8);
  const tickAt = (px: number) => Math.max(0, Math.round(view.scrollTick + (px - KEY_W) / view.pxPerTick));
  const valAt = (py: number) => Math.max(0, Math.min(max, Math.round(((H - 4 - py) / (H - 8)) * max)));
  const step = typeof lane === "number" && SWITCHES.has(lane);

  useEffect(() => {
    const el = cv.current?.parentElement; if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth)); ro.observe(el); setWidth(el.clientWidth); return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = cv.current; if (!c) return;
    const dpr = window.devicePixelRatio || 1; c.width = width * dpr; c.height = H * dpr;
    const g = c.getContext("2d")!; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#0f1115"; g.fillRect(0, 0, width, H);
    const sel = project.selection;
    if (sel.endTick > sel.startTick) { g.fillStyle = "rgba(120,170,255,0.12)"; g.fillRect(x(sel.startTick), 0, (sel.endTick - sel.startTick) * view.pxPerTick, H); }
    g.strokeStyle = "#2a2e38"; g.beginPath(); g.moveTo(KEY_W, yv(max / 2)); g.lineTo(width, yv(max / 2)); g.stroke();
    const endTick = view.scrollTick + (width - KEY_W) / view.pxPerTick;
    const curve = (list: { tick: number; value: number }[], color: string, dashed: boolean) => {
      if (!list.length) return;
      g.setLineDash(dashed ? [5, 3] : []); g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath();
      let prev: { tick: number; value: number } | null = null;
      for (const p of list) {
        if (p.tick > endTick && prev && prev.tick > endTick) break;
        if (!prev) g.moveTo(Math.max(KEY_W, x(p.tick)), yv(p.value));
        if (prev && step) g.lineTo(x(p.tick), yv(prev.value));
        g.lineTo(x(p.tick), yv(p.value)); prev = p;
      }
      if (prev) g.lineTo(width, yv(prev.value));
      g.stroke(); g.setLineDash([]);
      if (!dashed && view.pxPerTick * project.ppq > 6) { g.fillStyle = color; for (const p of list) if (p.tick >= view.scrollTick && p.tick <= endTick) g.fillRect(x(p.tick) - 2, yv(p.value) - 2, 4, 4); }
    };
    const margin = (width * 0.25) / view.pxPerTick;
    curve(visiblePoints(pts, view.scrollTick - margin, endTick + margin), track?.color ?? "#4fc3f7", false);
    if (candPts) curve(visiblePoints(candPts, view.scrollTick - margin, endTick + margin), "#7cffb2", true);
    if (drawPts.current) curve(drawPts.current, "#fff", true);
    g.fillStyle = "#1b1e25"; g.fillRect(0, 0, KEY_W, H);
    g.fillStyle = "#aaa"; g.font = "9px sans-serif"; g.fillText(String(max), 2, 10); g.fillText("0", 2, H - 3);
    const pos = workstation.getState().transport.positionTick; g.fillStyle = "#ff4081"; g.fillRect(x(pos), 0, 2, H);
  }, [pts, candPts, view, width, project.selection, live]);

  // Live value during playback (rAF-throttled via controller subscription, not per-event React state).
  useEffect(() => workstation.subscribe((s) => {
    const v: number | null = pts[lowerBound(pts, s.transport.positionTick + 1) - 1]?.value ?? null;
    setLive((old) => (old === v ? old : v));
  }), [pts]);

  const commitPoint = (tick: number, value: number) => {
    if (!track) return;
    if (typeof lane !== "number") return; // bend/pressure editing: drawn via pointer only (uses notes API in future)
    workstation.userEdit([{ op: "setCC", trackId, channel: track.channel, controller: lane, startTick: tick, endTick: tick, mode: "merge", points: [{ tick, value }] }], { label: `CC${lane} point` });
  };
  const hit = (px: number, py: number) => pts.find((p) => Math.abs(x(p.tick) - px) < 5 && Math.abs(yv(p.value) - py) < 6);

  const onDown = (e: React.PointerEvent) => {
    const r = cv.current!.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; if (px < KEY_W) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const h = hit(px, py);
    if (h && (e.altKey || e.button === 2)) { if (typeof lane === "number") workstation.userEdit([{ op: "removeCC", ids: [h.id] }], { label: `delete CC${lane} point` }); return; }
    if (h) { dragPt.current = h; return; }
    if (e.shiftKey) { drawPts.current = [{ tick: tickAt(px), value: valAt(py) }]; return; }
    commitPoint(tickAt(px), valAt(py));
  };
  const onMove = (e: React.PointerEvent) => {
    const r = cv.current!.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    if (drawPts.current) { const t = tickAt(px); const last = drawPts.current[drawPts.current.length - 1]; if (t > last.tick + project.ppq / 16) { drawPts.current.push({ tick: t, value: valAt(py) }); setLive(valAt(py)); } }
    else if (dragPt.current) setLive(valAt(py));
  };
  const onUp = (e: React.PointerEvent) => {
    const r = cv.current!.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top;
    if (drawPts.current && track && typeof lane === "number") {
      const d = drawPts.current; drawPts.current = null;
      if (d.length > 1) workstation.userEdit([{ op: "setCC", trackId, channel: track.channel, controller: lane, startTick: d[0].tick, endTick: d[d.length - 1].tick, mode: "replace", points: d }], { label: `draw CC${lane}` });
    } else if (dragPt.current && typeof lane === "number" && track) {
      const p = dragPt.current; dragPt.current = null; const t = tickAt(px), v = valAt(py);
      workstation.userEdit([{ op: "removeCC", ids: [p.id] }, { op: "setCC", trackId, channel: track.channel, controller: lane, startTick: t, endTick: t, mode: "merge", points: [{ tick: t, value: v }] }], { label: `move CC${lane} point` });
    }
    drawPts.current = null; dragPt.current = null;
  };
  const onKey = (e: React.KeyboardEvent) => {
    // Keyboard: Enter adds a point at the playhead with the last value (+/-: adjust by 1/8 of range).
    if (typeof lane !== "number") return;
    const pos = workstation.getState().transport.positionTick; const cur = live ?? 64;
    if (e.key === "Enter") commitPoint(pos, cur);
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { commitPoint(pos, Math.max(0, Math.min(127, cur + (e.key === "ArrowUp" ? 8 : -8)))); e.preventDefault(); }
  };

  return (
    <div className="ws-lane" data-testid={`lane-${lane}`}>
      <div className="ws-lane-head">
        <select aria-label="Automation controller" value={String(lane)} onChange={(e) => onChangeLane(e.target.value === "bend" || e.target.value === "pressure" ? e.target.value : Number(e.target.value))}>
          {LANE_CHOICES.map((c) => <option key={c} value={c}>CC{c} {NAMES[c]}</option>)}
          <option value="bend">Pitch bend (14-bit)</option>
          <option value="pressure">Channel pressure</option>
          {typeof lane === "number" && !LANE_CHOICES.includes(lane as never) && <option value={lane}>CC{lane}</option>}
        </select>
        <input aria-label="Custom CC number" type="number" min={0} max={127} placeholder="CC#" style={{ width: 52 }} onKeyDown={(e) => { if (e.key === "Enter") { const v = Number((e.target as HTMLInputElement).value); if (v >= 0 && v <= 127) onChangeLane(v); } }} />
        <span className="ws-live" aria-live="off">{live ?? "–"}</span>
        <span className="ws-dim">{pts.length} pts{candPts ? ` → ${candPts.length} proposed` : ""}</span>
        <button onClick={onRemove} aria-label="Remove lane">×</button>
      </div>
      <canvas ref={cv} style={{ width: "100%", height: H, display: "block", touchAction: "none" }} tabIndex={0}
        aria-label={`Automation lane ${typeof lane === "number" ? `CC${lane}` : lane}. Click adds a point, drag moves, alt-click deletes, shift-drag draws, Enter/arrows edit at playhead.`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()} />
    </div>
  );
}
