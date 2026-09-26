import { useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// PianoRoll — a canvas piano-roll view (pitch x time) for the loaded MIDI,
// rendered in a Winamp-styled window. Notes come from our own parsed Song
// model; the playhead follows our transport clock. Toggleable via the
// Winamp chrome piano-roll button.
// ---------------------------------------------------------------------------

export interface PianoRollNote {
  note: number; // MIDI pitch 0..127
  velocity: number;
  startSec: number;
  durationSec: number;
}

export interface PianoRollTrack {
  name: string;
  notes: PianoRollNote[];
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function pitchName(midi: number): string {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}
function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(midi % 12);
}

const TRACK_COLORS = ["#39ff14", "#00c8ff", "#ff9f1c", "#ff4d6d", "#c77dff", "#ffe14d"];

export default function PianoRoll({
  tracks,
  songTime,
  duration,
  onSeek,
  onClose,
}: {
  tracks: PianoRollTrack[];
  songTime: number;
  duration: number;
  onSeek: (sec: number) => void;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = wrap.clientWidth;
    const cssH = 220;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    ctx.scale(dpr, dpr);

    const keyGutter = 44;
    const w = cssW - keyGutter;
    const h = cssH;

    let lo = 127;
    let hi = 0;
    for (const t of tracks) {
      for (const n of t.notes) {
        if (n.note < lo) lo = n.note;
        if (n.note > hi) hi = n.note;
      }
    }
    if (hi <= lo) {
      lo = 48;
      hi = 72;
    }
    lo = Math.max(0, lo - 2);
    hi = Math.min(127, hi + 2);
    const rows = hi - lo + 1;
    const rowH = h / rows;
    const span = Math.max(0.001, duration);

    // Background
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, cssW, h);

    // Piano keys gutter
    for (let p = lo; p <= hi; p += 1) {
      const y = h - (p - lo + 1) * rowH;
      ctx.fillStyle = isBlackKey(p) ? "#161616" : "#e8e4da";
      ctx.fillRect(0, y, keyGutter - 4, rowH);
      if ((p % 12) === 0) {
        ctx.fillStyle = isBlackKey(p) ? "#9a9a9a" : "#555";
        ctx.font = "8px monospace";
        ctx.fillText(pitchName(p), 4, y + rowH - 2);
      }
    }

    // Beat grid (1s lines)
    ctx.strokeStyle = "#1e1e1e";
    ctx.lineWidth = 1;
    for (let s = 0; s <= span; s += 1) {
      const x = keyGutter + (s / span) * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // Notes
    tracks.forEach((t, ti) => {
      ctx.fillStyle = TRACK_COLORS[ti % TRACK_COLORS.length];
      for (const n of t.notes) {
        const x = keyGutter + (n.startSec / span) * w;
        const nw = Math.max(1.5, (n.durationSec / span) * w);
        const y = h - (n.note - lo + 1) * rowH + 1;
        const nh = Math.max(1, rowH - 2);
        ctx.globalAlpha = 0.55 + (n.velocity / 127) * 0.45;
        ctx.fillRect(x, y, nw, nh);
      }
      ctx.globalAlpha = 1;
    });

    // Playhead
    const px = keyGutter + (Math.max(0, Math.min(span, songTime)) / span) * w;
    ctx.strokeStyle = "#ff3333";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }, [tracks, songTime, duration]);

  const seekFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || duration <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const keyGutter = 44;
    const frac = Math.max(
      0,
      Math.min(1, (e.clientX - rect.left - keyGutter) / (rect.width - keyGutter))
    );
    onSeek(frac * duration);
  };

  return (
    <section className="winamp-piano-window" aria-label="Piano roll">
      <div className="winamp-piano-titlebar">
        <span className="winamp-piano-title">Piano Roll</span>
        <button
          type="button"
          className="winamp-piano-close"
          onClick={onClose}
          aria-label="Close piano roll"
          title="Close piano roll"
        >
          &#215;
        </button>
      </div>
      <div ref={wrapRef} className="winamp-piano-body">
        <canvas
          ref={canvasRef}
          onPointerDown={seekFromEvent}
          aria-label="Piano roll. Activate to seek."
          role="img"
        />
      </div>
      <div className="winamp-piano-hint">Click the roll to seek</div>
    </section>
  );
}
