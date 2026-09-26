import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  CharacterString,
  marqueeIsLong,
  marqueeLoopText,
  marqueeStepOffset,
} from "./characters";

// ---------------------------------------------------------------------------
// WinampMain — the classic Winamp main window, wired to OUR engine.
// Presentation borrows webamp's skin CSS (MIT, see NOTICE.md); every control
// calls back into our own transport/playlist/audio state. No webamp audio or
// store code is used.
//
// Accessibility note: the skin's transport row has separate Play and Pause
// sprites. To keep a single accessible Play/Pause toggle (the app's e2e
// contract), the Pause sprite is a visual duplicate hidden from assistive
// tech; the Play sprite carries the dynamic Play/Pause/Cancel label.
// ---------------------------------------------------------------------------

export type WinampStatus = "play" | "pause" | "stop";

export interface WinampMainProps {
  marqueeText: string;
  status: WinampStatus;
  working: boolean;
  songTime: number;
  duration: number;
  onSeek: (sec: number) => void;
  onPlayPause: () => void;
  playButtonLabel: string;
  playButtonTitle: string;
  onStop: () => void;
  onPrev: () => void;
  onNext: () => void;
  onEject: () => void;
  transportDisabled: boolean;
  volume: number; // 0..1
  onVolumeChange: (v: number) => void;
  shuffle: boolean;
  onToggleShuffle: () => void;
  repeat: boolean;
  onToggleRepeat: () => void;
  playlistOpen: boolean;
  onTogglePlaylist: () => void;
  timeData: number[];
  menu: ReactNode;
}

function WinampActionButton({
  id,
  label,
  title,
  onClick,
  selected,
  disabled,
  hiddenFromAT,
  tabIndex,
}: {
  id: string;
  label: string;
  title: string;
  onClick: () => void;
  selected?: boolean;
  disabled?: boolean;
  hiddenFromAT?: boolean;
  tabIndex?: number;
}) {
  const [active, setActive] = useState(false);
  return (
    <button
      type="button"
      id={id}
      aria-label={label}
      aria-hidden={hiddenFromAT || undefined}
      tabIndex={tabIndex}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`${active ? "winamp-active" : ""}${selected ? " selected" : ""}`.trim() || undefined}
      onPointerDown={() => setActive(true)}
      onPointerUp={() => setActive(false)}
      onPointerLeave={() => setActive(false)}
    />
  );
}

function DigitTime({ seconds }: { seconds: number }) {
  const s = Math.max(0, Math.floor(seconds));
  const digits = [
    Math.floor(s / 600),
    Math.floor(s / 60) % 10,
    Math.floor(s / 10) % 6,
    s % 10,
  ];
  const ids = [
    "minute-first-digit",
    "minute-second-digit",
    "second-first-digit",
    "second-second-digit",
  ];
  return (
    <div id="time" className="winamp-time" aria-hidden="true">
      {digits.map((d, i) => (
        <div key={ids[i]} id={ids[i]} className={`digit digit-${d}`} />
      ))}
    </div>
  );
}

function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Marquee({ text }: { text: string }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!marqueeIsLong(text)) {
      setStep(0);
      return;
    }
    const handle = window.setInterval(() => setStep((s) => s + 1), 220);
    return () => window.clearInterval(handle);
  }, [text]);
  const offset = marqueeStepOffset(text, step);
  return (
    <div id="marquee" className="text" title="Song Title">
      <div
        style={{
          whiteSpace: "nowrap",
          willChange: "transform",
          transform: `translateX(${-offset}px)`,
        }}
      >
        <CharacterString text={marqueeLoopText(text)} />
      </div>
    </div>
  );
}

function Visualizer({ timeData }: { timeData: number[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, w, h);
    if (!timeData.length) return;
    ctx.strokeStyle = "#39ff14";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const n = timeData.length;
    for (let i = 0; i < n; i += 1) {
      const x = (i / (n - 1)) * (w - 1);
      const v = Math.max(-1, Math.min(1, timeData[i]));
      const y = (1 - (v + 1) / 2) * (h - 1);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [timeData]);
  return <canvas ref={canvasRef} id="visualizer" width={76} height={16} aria-hidden="true" />;
}

export default function WinampMain(props: WinampMainProps) {
  const {
    marqueeText,
    status,
    working,
    songTime,
    duration,
    onSeek,
    onPlayPause,
    playButtonLabel,
    playButtonTitle,
    onStop,
    onPrev,
    onNext,
    onEject,
    transportDisabled,
    volume,
    onVolumeChange,
    shuffle,
    onToggleShuffle,
    repeat,
    onToggleRepeat,
    playlistOpen,
    onTogglePlaylist,
    timeData,
    menu,
  } = props;

  const [menuOpen, setMenuOpen] = useState(false);
  const [shade, setShade] = useState(false);

  // Volume sprite: 28 frames, 15px each (same math as webamp's MainVolume).
  const volumeSprite = Math.round(Math.max(0, Math.min(1, volume)) * 28);
  const volumeOffset = (volumeSprite - 1) * 15;

  const windowClass = `window ${status}${shade ? " shade" : ""}`;

  return (
    <div id="main-window" className={windowClass}>
      <div id="title-bar" className="selected">
        <div
          id="option"
          role="button"
          tabIndex={0}
          aria-label="Player menu"
          title="Menu"
          onClick={() => setMenuOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setMenuOpen((v) => !v);
            }
          }}
        />
        {shade && (
          <div className="winamp-shade-readout" aria-hidden="true">
            <CharacterString text={marqueeText.slice(0, 30)} />
          </div>
        )}
        <div
          id="shade"
          role="button"
          tabIndex={0}
          aria-label={shade ? "Expand player" : "Shade player"}
          title={shade ? "Expand" : "Shade"}
          onClick={() => setShade((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setShade((v) => !v);
            }
          }}
        />
      </div>

      {menuOpen && (
        <>
          {createPortal(
            <div
              className="winamp-menu-backdrop"
              onClick={() => setMenuOpen(false)}
              aria-hidden="true"
            />,
            document.body
          )}
          <div className="winamp-menu-panel" role="menu" aria-label="Player menu">
            {menu}
          </div>
        </>
      )}

      <div className="webamp-status">
        {!working && <div id="play-pause" />}
        <div id="work-indicator" className={working ? "selected" : ""} />
        <DigitTime seconds={songTime} />
      </div>

      <Visualizer timeData={timeData} />

      <div className="media-info">
        <Marquee text={marqueeText} />
      </div>

      <div id="volume" style={{ backgroundPosition: `0 -${volumeOffset}px` }}>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(Math.max(0, Math.min(1, volume)) * 100)}
          onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
          aria-label="Volume"
          title="Volume"
        />
      </div>
      {/* Balance knob is a visual stub: the engine exposes no master pan. */}
      <input
        id="balance"
        type="range"
        min={-100}
        max={100}
        step={1}
        value={0}
        onChange={() => undefined}
        aria-label="Balance (not connected)"
        title="Balance is not wired to the audio engine"
        disabled
      />

      <div className="windows">
        <WinampActionButton
          id="playlist-button"
          label={playlistOpen ? "Hide playlist" : "Show playlist"}
          title="Toggle Playlist"
          onClick={onTogglePlaylist}
          selected={playlistOpen}
        />
      </div>

      <input
        id="position"
        type="range"
        min={0}
        max={Math.max(0.01, duration)}
        step={0.01}
        value={Math.max(0, Math.min(Math.max(0.01, duration), songTime))}
        onChange={(e) => onSeek(Number(e.target.value))}
        disabled={duration <= 0}
        aria-label="Playback position"
        title="Playback position"
      />

      <div className="actions" aria-hidden={shade || undefined}>
        <WinampActionButton id="previous" label="Previous track" title="Previous Track" onClick={onPrev} disabled={transportDisabled} />
        <WinampActionButton
          id="play"
          label={playButtonLabel}
          title={playButtonTitle}
          onClick={onPlayPause}
          disabled={transportDisabled}
        />
        <WinampActionButton
          id="pause"
          label="Pause"
          title="Pause"
          onClick={onPlayPause}
          hiddenFromAT
          tabIndex={-1}
          disabled={transportDisabled}
        />
        <WinampActionButton id="stop" label="Stop" title="Stop" onClick={onStop} disabled={transportDisabled} />
        <WinampActionButton id="next" label="Next track" title="Next Track" onClick={onNext} disabled={transportDisabled} />
      </div>
      <WinampActionButton
        id="eject"
        label="Open audio file"
        title="Open file (upload MIDI)"
        onClick={onEject}
      />

      <div className="shuffle-repeat">
        <WinampActionButton
          id="shuffle"
          label={shuffle ? "Disable shuffle" : "Enable shuffle"}
          title="Toggle Shuffle"
          onClick={onToggleShuffle}
          selected={shuffle}
        />
        <WinampActionButton
          id="repeat"
          label={repeat ? "Disable repeat" : "Enable repeat"}
          title="Toggle Repeat"
          onClick={onToggleRepeat}
          selected={repeat}
        />
      </div>

      {shade && (
        <div className="winamp-shade-controls">
          <span className="winamp-shade-time">{fmtClock(songTime)}</span>
          <button type="button" onClick={onPrev} aria-label="Previous track" disabled={transportDisabled}>
            &#9198;
          </button>
          <button type="button" onClick={onPlayPause} aria-label={playButtonLabel} disabled={transportDisabled}>
            {playButtonLabel === "Pause" ? "\u23F8" : "\u25B6"}
          </button>
          <button type="button" onClick={onStop} aria-label="Stop" disabled={transportDisabled}>
            &#9632;
          </button>
          <button type="button" onClick={onNext} aria-label="Next track" disabled={transportDisabled}>
            &#9197;
          </button>
        </div>
      )}
    </div>
  );
}
