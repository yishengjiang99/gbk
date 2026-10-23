// Non-blocking, draggable floating window (no backdrop). Title bar drags via pointer events (mouse + touch),
// clamped to the viewport, position remembered in localStorage. Used for the on-screen Keys.
import { useEffect, useRef, useState, type ReactNode } from "react";

type Pos = { x: number; y: number };
const clamp = (p: Pos, el: HTMLElement | null): Pos => {
  const w = el?.offsetWidth ?? 320, h = el?.offsetHeight ?? 40;
  return { x: Math.round(Math.min(Math.max(0, p.x), Math.max(0, innerWidth - w))), y: Math.round(Math.min(Math.max(0, p.y), Math.max(0, innerHeight - h))) };
};

export function FloatingWindow({ title, storageKey, onClose, children, testId }: { title: ReactNode; storageKey: string; onClose: () => void; children: (minimized: boolean) => ReactNode; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [min, setMin] = useState(false);
  const [pos, setPos] = useState<Pos>(() => {
    try { const v = JSON.parse(localStorage.getItem(storageKey) ?? "null"); if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return v; } catch { /* ignore */ }
    return { x: Math.max(0, innerWidth - Math.min(innerWidth, 760) - 16), y: Math.max(0, innerHeight - 260) };
  });
  const drag = useRef<{ id: number; dx: number; dy: number } | null>(null);
  useEffect(() => { const f = () => setPos((p) => clamp(p, ref.current)); f(); addEventListener("resize", f); return () => removeEventListener("resize", f); }, [min]);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(pos)); } catch { /* ignore */ } }, [pos, storageKey]);
  return (
    <div ref={ref} className="ws-float" role="dialog" aria-modal="false" aria-label={typeof title === "string" ? title : "Window"} data-testid={testId} style={{ left: pos.x, top: pos.y }}>
      <div className="ws-float-bar" data-testid={testId && `${testId}-handle`}
        onPointerDown={(e) => { if ((e.target as HTMLElement).closest("button")) return; e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); drag.current = { id: e.pointerId, dx: e.clientX - pos.x, dy: e.clientY - pos.y }; }}
        onPointerMove={(e) => { const d = drag.current; if (d && d.id === e.pointerId) setPos(clamp({ x: e.clientX - d.dx, y: e.clientY - d.dy }, ref.current)); }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
        <span className="ws-float-title">{title}</span>
        <button aria-label={min ? "Expand" : "Minimize"} data-testid={testId && `${testId}-min`} onClick={() => setMin(!min)}>{min ? "▢" : "–"}</button>
        <button aria-label="Close" data-testid={testId && `${testId}-close`} onClick={onClose}>✕</button>
      </div>
      {!min && <div className="ws-float-body">{children(min)}</div>}
    </div>
  );
}
