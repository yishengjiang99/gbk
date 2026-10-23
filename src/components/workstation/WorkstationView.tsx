import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { followScroll } from "../../workstation/follow.ts";
import { useWorkstation, workstation } from "./useWorkstation.ts";
import { PianoRollEditor, type View } from "./PianoRollEditor.tsx";
import { AutomationLane, type LaneKind } from "./AutomationLane.tsx";
import { AgentPanel, useAgentToolsToggle } from "./AgentPanel.tsx";
import { tickToBarBeat, tickToSec } from "../../workstation/timing.ts";

export function WorkstationView({ onOpenPlayer }: { onOpenPlayer: () => void }) {
  const state = useWorkstation();
  const p = state.project;
  const agent = useAgentToolsToggle();
  const [view, setView] = useState<View>({ scrollTick: 0, pxPerTick: 0.08, lowPitch: 28, highPitch: 100 });
  const rollPx = useRef(900);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [lanes, setLanes] = useState<LaneKind[]>([11, 1]);
  const [laneTrack, setLaneTrack] = useState<string>("");
  const pending = state.proposals.filter((x) => x.status === "pending");
  const focus = state.proposals.find((x) => x.id === focusId && x.status === "pending") ?? pending[pending.length - 1] ?? null;
  const setFocus = useCallback((id: string | null) => setFocusId(id), []);
  const trackForLanes = p.tracks.find((t) => t.id === laneTrack) ?? p.tracks.find((t) => p.selection.trackIds.includes(t.id)) ?? p.tracks.find((t) => p.notes.some((n) => n.trackId === t.id)) ?? p.tracks[0];
  // Default zoom: ~4 bars of the first meter visible (not the whole song).
  useEffect(() => {
    const ts = p.timeSigs[0] ?? { numerator: 4, denominator: 4 };
    const barTicks = ((p.ppq * 4) / ts.denominator) * ts.numerator;
    setView((v) => ({ ...v, scrollTick: 0, pxPerTick: Math.max(0.005, Math.min(2, rollPx.current / (4 * barTicks))) }));
    setLaneTrack("");
  }, [p.id]);
  // Auto lanes: show the controllers the selected track actually uses (plus bend/pressure when present).
  useEffect(() => {
    if (!trackForLanes) return;
    const counts = new Map<number, number>();
    for (const c of p.ccs) if (c.trackId === trackForLanes.id && c.controller !== 0 && c.controller !== 32) counts.set(c.controller, (counts.get(c.controller) ?? 0) + 1);
    const next: LaneKind[] = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k);
    if (p.pitchBends.some((b) => b.trackId === trackForLanes.id)) next.push("bend");
    if (p.channelPressure.some((b) => b.trackId === trackForLanes.id)) next.push("pressure");
    setLanes(next.length ? next : [11, 1]);
  }, [p.id, trackForLanes?.id]);
  // Playhead follow (page-style), rAF-driven: React only re-renders when the page flips.
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true); followRef.current = follow;
  const viewRef = useRef(view); viewRef.current = view;
  useEffect(() => {
    let raf = 0; let lastPos = -1; let wasPlaying = false;
    const loop = () => {
      const t = workstation.getState().transport;
      if (t.playing && !wasPlaying) setFollow(true); // playback (re)start re-enables follow
      wasPlaying = t.playing;
      const moved = t.positionTick !== lastPos;
      if (followRef.current && moved) {
        const v = viewRef.current;
        const next = followScroll(t.positionTick, v.scrollTick, rollPx.current / v.pxPerTick);
        if (next !== null) setView((cur) => ({ ...cur, scrollTick: next }));
      }
      lastPos = t.positionTick;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const pos = state.transport.positionTick;
  const bb = useMemo(() => tickToBarBeat(p, pos), [p, pos]);
  const run = (f: () => unknown) => { try { const r = f(); if (r instanceof Promise) r.catch((e: Error) => alert(e.message)); } catch (e) { alert((e as Error).message); } };
  const exportMidi = () => { const { bytes, filename } = workstation.prepareMidiExport(); workstation.host.download?.(bytes, filename); };
  const exportWav = () => run(async () => { const b = await workstation.host.renderWav!(workstation.project); workstation.host.download?.(b, `${p.name || "gbk"}.wav`); });

  return (
    <div className="ws" data-testid="workstation">
      <header className="ws-header">
        <strong className="ws-title">GBK Workstation</strong>
        <span className="ws-name" title={p.name}>{p.name}</span>
        <div className="ws-transport" role="toolbar" aria-label="Transport">
          <button onClick={() => run(() => workstation.seek(0))} aria-label="Rewind">⏮</button>
          {state.transport.playing ? <button onClick={() => workstation.pause()} aria-label="Pause">⏸</button> : <button onClick={() => run(() => workstation.play())} aria-label="Play" data-testid="ws-play">▶</button>}
          <button onClick={() => workstation.stop()} aria-label="Stop">⏹</button>
          <span className="ws-pos" data-testid="ws-pos" data-pos-tick={pos}>{bb.bar}.{Math.floor(bb.beat) + 1} · {tickToSec(p, pos).toFixed(2)}s</span>
          <label className="ws-dim"><input type="checkbox" data-testid="follow-toggle" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow</label>
          <label className="ws-dim"><input type="checkbox" checked={p.loop.enabled} onChange={(e) => workstation.setLoop(p.selection.endTick > p.selection.startTick ? { enabled: e.target.checked, startTick: p.selection.startTick, endTick: p.selection.endTick } : { enabled: e.target.checked })} /> loop sel</label>
        </div>
        <span className="ws-dim">{p.ppq} PPQ · {Math.round(60e6 / (p.tempos[0]?.microPerQuarter ?? 500000))} bpm{p.tempos.length > 1 ? "*" : ""} · {p.timeSigs[0]?.numerator}/{p.timeSigs[0]?.denominator}</span>
        <button onClick={() => setView({ ...view, pxPerTick: view.pxPerTick * 1.25 })} aria-label="Zoom in">＋</button>
        <button onClick={() => setView({ ...view, pxPerTick: view.pxPerTick / 1.25 })} aria-label="Zoom out">－</button>
        <button disabled={!state.canUndo} onClick={() => workstation.undo()}>Undo</button>
        <button disabled={!state.canRedo} onClick={() => workstation.redo()}>Redo</button>
        <button onClick={exportMidi} data-testid="export-midi">Export MIDI</button>
        <button onClick={exportWav} data-testid="export-wav">Export WAV</button>
        <label className={`ws-pill ${agent.on && agent.available ? "on" : "off"}`} title={agent.available ? "Expose gbk_* tools to in-browser agents via WebMCP" : "WebMCP not available in this browser"}>
          <input type="checkbox" data-testid="agent-toggle" checked={agent.on} disabled={!agent.available} onChange={(e) => agent.setOn(e.target.checked)} /> Enable Agent Tools {agent.available ? "" : "(unavailable)"}
        </label>
        <button className="ws-player-btn" onClick={onOpenPlayer} data-testid="open-player">Player / Library</button>
      </header>
      <div className="ws-body">
        <nav className="ws-tracks" aria-label="Tracks">
          {p.tracks.length === 0 && <p className="ws-dim">Open the Player / Library to load a MIDI file, or generate a Bach fugue there.</p>}
          {p.tracks.map((t) => {
            const ov = state.overrides[t.id];
            const count = p.notes.filter((n) => n.trackId === t.id).length;
            return (
              <div key={t.id} className={`ws-track ${trackForLanes?.id === t.id ? "active" : ""}`} data-testid={`track-${t.name}`}>
                <div className="ws-row">
                  <span className="ws-swatch" style={{ background: t.color }} />
                  <button className="ws-link" onClick={() => { setLaneTrack(t.id); workstation.setSelection({ trackIds: [t.id] }); }} title={t.name}>{t.name}</button>
                  <span className="ws-dim">ch{t.channel + 1} · {count}</span>
                </div>
                <div className="ws-row">
                  <label><input type="checkbox" checked={t.visible} onChange={(e) => workstation.edit([{ op: "updateTrack", trackId: t.id, visible: e.target.checked }], { label: "toggle visibility" })} />show</label>
                  <label><input type="checkbox" checked={t.mix.mute} onChange={(e) => workstation.setTrackMixDefault(t.id, { mute: e.target.checked })} />M</label>
                  <label><input type="checkbox" checked={t.mix.solo} onChange={(e) => workstation.setTrackMixDefault(t.id, { solo: e.target.checked })} />S</label>
                </div>
                <label className="ws-knob">vol <input type="range" min={0} max={127} value={ov?.volume ?? t.mix.volume} onChange={(e) => workstation.setTrackMixDefault(t.id, { volume: +e.target.value })} /></label>
                <label className="ws-knob">pan <input type="range" min={0} max={127} value={ov?.pan ?? t.mix.pan} onChange={(e) => workstation.setTrackMixDefault(t.id, { pan: +e.target.value })} /></label>
                {ov && <button className="ws-link" onClick={() => workstation.setOverride(t.id, null)}>clear live override</button>}
              </div>
            );
          })}
        </nav>
        <main className="ws-main">
          <PianoRollEditor project={p} proposal={focus} view={view} setView={setView} height={360} onManualScroll={() => setFollow(false)} onWidth={(px) => { rollPx.current = px; }} />
          <div className="ws-lanes">
            <div className="ws-row ws-dim">Automation for <b style={{ color: trackForLanes?.color }}>{trackForLanes?.name ?? "–"}</b>
              <button onClick={() => setLanes([...lanes, 7])}>+ lane</button>
            </div>
            {trackForLanes && lanes.map((l, i) => (
              <AutomationLane key={i} project={p} proposal={focus} view={view} trackId={trackForLanes.id} lane={l}
                onChangeLane={(nl) => setLanes(lanes.map((x, j) => (j === i ? nl : x)))} onRemove={() => setLanes(lanes.filter((_, j) => j !== i))} />
            ))}
          </div>
        </main>
        <AgentPanel state={state} focusProposal={focus} setFocus={setFocus} />
      </div>
    </div>
  );
}
