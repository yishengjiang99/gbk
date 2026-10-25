import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Live content-box size of an element (the studio is a fixed 100dvh layout; children size from it). */
function useBox<T extends HTMLElement>() {
  const [box, setBox] = useState({ w: 0, h: 0 }); const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect(); ro.current = null;
    if (!el) { setBox({ w: 0, h: 0 }); return; }
    const m = () => setBox((o) => (o.w === el.clientWidth && o.h === el.clientHeight ? o : { w: el.clientWidth, h: el.clientHeight }));
    ro.current = new ResizeObserver(m); ro.current.observe(el); m();
  }, []);
  return [ref, box] as const;
}
function useMedia(q: string) {
  const [m, setM] = useState(() => typeof matchMedia === "function" && matchMedia(q).matches);
  useEffect(() => { const mq = matchMedia(q); const f = () => setM(mq.matches); mq.addEventListener("change", f); return () => mq.removeEventListener("change", f); }, [q]);
  return m;
}
const LANE_H = 48, LANE_BLOCK = LANE_H + 40, ROLL_MIN = 120;
import { followScroll } from "../../workstation/follow.ts";
import { useWorkstation, workstation } from "./useWorkstation.ts";
import { PianoRollEditor, type View } from "./PianoRollEditor.tsx";
import { AutomationLane, type LaneKind } from "./AutomationLane.tsx";
import { AgentPanel, useAgentToolsToggle } from "./AgentPanel.tsx";
import { LiveKeyboard } from "./LiveKeyboard.tsx";
import { FloatingWindow } from "./FloatingWindow.tsx";
import { selectedTrackId } from "../../workstation/live-input.ts";
import { SoundPanel } from "./SoundPanel.tsx";
import { ArtifactPanel } from "./ArtifactPanel.tsx";
import { VideoExportButton } from "./VideoExport.tsx";
import { ComposerPanel } from "../composer/ComposerPanel.tsx";
import { renderJobs, safeFilename } from "../../audio/render-job.ts";
import { funnelBeacon } from "../../telemetry/funnel.ts";
import { tickToBarBeat, tickToSec, barBeatToTick } from "../../workstation/timing.ts";

export function WorkstationView({ onOpenPlayer, composer = false, onExplore }: { onOpenPlayer: () => void; composer?: boolean; onExplore?: () => void }) {
  const state = useWorkstation();
  const p = state.project;
  const agent = useAgentToolsToggle();
  const [view, setView] = useState<View>({ scrollTick: 0, pxPerTick: 0.08, lowPitch: 28, highPitch: 100 });
  const rollPx = useRef(900);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [lanes, setLanes] = useState<LaneKind[]>([11, 1]);
  const pending = state.proposals.filter((x) => x.status === "pending");
  const focus = state.proposals.find((x) => x.id === focusId && x.status === "pending") ?? pending[pending.length - 1] ?? null;
  const setFocus = useCallback((id: string | null) => setFocusId(id), []);
  // One selection for everything (track list, piano roll, lanes, Sound panel, Keys panel): workstation.selection.
  const trackForLanes = p.tracks.find((t) => t.id === selectedTrackId(p));
  // Default zoom: ~4 bars of the first meter visible (not the whole song).
  useEffect(() => {
    const ts = p.timeSigs[0] ?? { numerator: 4, denominator: 4 };
    const barTicks = ((p.ppq * 4) / ts.denominator) * ts.numerator;
    setView((v) => ({ ...v, scrollTick: 0, pxPerTick: Math.max(0.005, Math.min(2, rollPx.current / (4 * barTicks))) }));
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
  const [keysOn, setKeysOn] = useState(false);
  const narrow = useMedia("(max-width: 900px)");
  const phone = useMedia("(max-width: 600px)");
  const [mainRef, mainBox] = useBox<HTMLElement>();
  const [rollRef, rollBox] = useBox<HTMLDivElement>();
  const tabs = useMemo(() => [...(narrow ? ["Tracks"] : []), ...(composer ? ["Composer"] : []), "Agent", "Sound", "Files"], [narrow, composer]);
  const [tab, setTab] = useState<string | null>(null);
  const want = tab ?? (composer ? "Composer" : "Agent");
  const activeTab = tabs.includes(want) ? want : tabs[0];
  const pendingCount = state.proposals.filter((x) => x.status === "pending").length;
  const lastPending = useRef(pendingCount);
  useEffect(() => { if (pendingCount > lastPending.current && !composer) setTab("Agent"); lastPending.current = pendingCount; }, [pendingCount]);
  // Lanes get what is left after the roll's minimum + Keys; extra lanes page instead of scrolling.
  const laneRoom = Math.max(0, Math.floor((mainBox.h - ROLL_MIN - 32) / LANE_BLOCK)); const laneFit = Math.max(1, laneRoom);
  const [lanePage, setLanePage] = useState(0);
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
  // Same headless renderer as gbk_render_wav: progress + artifact appear in the artifact panel; errors are shown, never swallowed.
  const exportWav = () => run(async () => {
    const j = renderJobs().submit(workstation.project, { sampleRate: 44100, channels: 2, format: "pcm16", tailSeconds: 3 }, { saveArtifact: true });
    const done = await renderJobs().wait(j.id);
    if (done.status !== "completed") throw new Error(`WAV export ${done.status}: ${done.error?.message ?? ""}`);
    const r = renderJobs().result(j.id);
    funnelBeacon("browser_render_completed", "studio");
    if (r) workstation.host.download?.(r.blob, safeFilename(done.projectName, "wav"));
  });

  // New project: always a blank, user-owned project. Unsaved edits (revision > 0) need a confirm first;
  // the previous project stays checkpointed locally when the host supports it.
  const newProject = () => run(async () => {
    const cur = workstation.project;
    const hasContent = cur.tracks.length > 0 || cur.notes.length > 0;
    if (hasContent && cur.revision > 0 && !workstation.readOnlyReason && !confirm("Start a new project? Unsaved changes to the current project may be lost.")) return;
    await workstation.createProject({ name: "Untitled", owner: "user", replaceCurrent: !workstation.host.checkpoint });
  });

  const transportCore = (<>
    <button onClick={() => run(() => workstation.seek(0))} aria-label="Rewind">⏮</button>
    {state.transport.starting && !state.transport.playing ? <button className="ws-playbtn" onClick={() => run(() => workstation.play())} aria-label="Loading sound…" aria-busy="true" data-testid="ws-play-loading">⏳</button>
      : state.transport.playing ? <button className="ws-playbtn" onClick={() => workstation.pause()} aria-label="Pause">⏸</button> : <button className="ws-playbtn" onClick={() => run(() => workstation.play())} aria-label="Play" data-testid="ws-play">▶</button>}
    <button onClick={() => workstation.stop()} aria-label="Stop">⏹</button>
    <span className="ws-pos" data-testid="ws-pos" data-pos-tick={pos}>{bb.bar}.{Math.floor(bb.beat) + 1} · {tickToSec(p, pos).toFixed(2)}s</span>
  </>);
  const transportExtras = (<>
          <button onClick={() => setKeysOn(!keysOn)} aria-pressed={keysOn} data-testid="keys-toggle" title="Piano keyboard (on-screen, computer keys A-K, Web MIDI)">🎹 Keys</button>
          <label className="ws-dim"><input type="checkbox" data-testid="follow-toggle" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow</label>
          <label className="ws-dim"><input type="checkbox" checked={p.loop.enabled} onChange={(e) => workstation.setLoop(p.selection.endTick > p.selection.startTick ? { enabled: e.target.checked, startTick: p.selection.startTick, endTick: p.selection.endTick } : { enabled: e.target.checked })} /> loop sel</label>
  </>);
  // Scrubber: whole-song seek bar. Moves the playhead (seeks playback if playing) and scrolls the roll there.
  const songEnd = Math.max(1, p.endTick, ...p.notes.map((n) => n.tick + n.duration));
  const scrubTo = (tick: number) => {
    const t = Math.max(0, Math.min(songEnd, Math.round(tick)));
    workstation.seek(t);
    setView((v) => { const span = rollPx.current / v.pxPerTick; return t < v.scrollTick || t > v.scrollTick + span ? { ...v, scrollTick: Math.max(0, t - span * 0.25) } : v; });
  };
  const scrubAt = (el: HTMLElement, x: number) => { const r = el.getBoundingClientRect(); const thumb = 13; scrubTo(((x - r.left - thumb) / Math.max(1, r.width - 2 * thumb)) * songEnd); };
  const posText = `bar ${bb.bar}.${Math.floor(bb.beat) + 1}, ${tickToSec(p, pos).toFixed(1)} of ${tickToSec(p, songEnd).toFixed(1)} seconds`;
  const scrubber = (
    <div className="ws-scrub" data-testid="scrubber-wrap">
      {(p.meta?.sections ?? []).map((sec) => { const t = barBeatToTick(p, sec.startBar); return t <= songEnd ? <span key={sec.name + sec.startBar} className="ws-scrub-mark" style={{ left: `${(t / songEnd) * 100}%` }} title={sec.name}>{sec.name}</span> : null; })}
      <input type="range" aria-label="Song position" data-testid="scrubber" min={0} max={songEnd} step={Math.max(1, Math.round(p.ppq / 4))} value={Math.min(pos, songEnd)} aria-valuetext={posText}
        onChange={(e) => scrubTo(+e.target.value)}
        // Tap/drag anywhere on the track (iOS range inputs only move by dragging the thumb).
        onPointerDown={(e) => { const el = e.currentTarget; e.preventDefault(); el.focus(); el.setPointerCapture?.(e.pointerId); scrubAt(el, e.clientX); }}
        onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture?.(e.pointerId)) scrubAt(e.currentTarget, e.clientX); }} />
    </div>);
  const [roHint, setRoHint] = useState<string | null>(null);
  useEffect(() => { let t: ReturnType<typeof setTimeout> | undefined; const f = () => { setRoHint("Read-only shared song — press Fork to edit your own copy."); clearTimeout(t); t = setTimeout(() => setRoHint(null), 2500); }; workstation.readOnlyHintListeners.add(f); return () => { workstation.readOnlyHintListeners.delete(f); clearTimeout(t); }; }, []);
  return (
    <div className="ws" data-testid="workstation">
      {roHint && <div role="status" aria-live="polite" data-testid="readonly-hint" style={{ position: "fixed", left: "50%", bottom: 80, transform: "translateX(-50%)", zIndex: 1000, pointerEvents: "none", background: "rgba(20,20,28,.92)", color: "#fff", padding: "8px 14px", borderRadius: 8, fontSize: 14 }}>{roHint}</div>}
      <header className="ws-header">
        <strong className="ws-title">{composer ? "GBK Composer" : "GBK Workstation"}</strong>
        {composer && onExplore && <button onClick={onExplore} data-testid="nav-explore">Explore</button>}
        <button className="ws-new" onClick={newProject} data-testid="new-project" title="Start a new, empty project">＋ New project</button>
        {workstation.readOnlyReason && <span className="ws-pill off" data-testid="readonly-pill" title={workstation.readOnlyReason}>read-only · <button className="ws-link" onClick={() => workstation.fork()}>Fork</button></span>}
        <span className="ws-name" title={p.name}>{p.name}</span>
        {!phone && <div className="ws-transport" role="toolbar" aria-label="Transport">
          {transportCore}
          {transportExtras}
        </div>}
        {phone && transportExtras}
        <span className="ws-dim">{p.ppq} PPQ · {Math.round(60e6 / (p.tempos[0]?.microPerQuarter ?? 500000))} bpm{p.tempos.length > 1 ? "*" : ""} · {p.timeSigs[0]?.numerator}/{p.timeSigs[0]?.denominator}</span>
        <button onClick={() => setView({ ...view, pxPerTick: view.pxPerTick * 1.25 })} aria-label="Zoom in">＋</button>
        <button onClick={() => setView({ ...view, pxPerTick: view.pxPerTick / 1.25 })} aria-label="Zoom out">－</button>
        <button disabled={!state.canUndo} onClick={() => workstation.undo()}>Undo</button>
        <button disabled={!state.canRedo} onClick={() => workstation.redo()}>Redo</button>
        <button onClick={exportMidi} data-testid="export-midi">Export MIDI</button>
        <button onClick={exportWav} data-testid="export-wav">Export WAV</button>
        <VideoExportButton />
        <label className={`ws-pill ${agent.on && agent.available ? "on" : "off"}`} data-testid="agent-mode" data-mode={agent.mode} title={agent.mode === "webmcp" ? "Expose gbk_* tools to in-browser agents via WebMCP (document.modelContext)" : "WebMCP not in this browser: tools are exposed in-page as window.gbkTools (shim)"}>
          <input type="checkbox" data-testid="agent-toggle" checked={agent.on} disabled={!agent.available} onChange={(e) => agent.setOn(e.target.checked)} /> Enable Agent Tools {agent.mode === "shim" ? "(shim)" : ""}
        </label>
        <button className="ws-player-btn" onClick={onOpenPlayer} data-testid="open-player">Player / Library</button>
      </header>
      {phone && <div className="ws-transport ws-transport-row" role="toolbar" aria-label="Transport" data-testid="transport-row">{transportCore}</div>}
      {scrubber}
      {keysOn && <FloatingWindow title="🎹 Keys" storageKey="gbk.keysWindowPos" testId="keys-window" onClose={() => setKeysOn(false)}>
        {() => <LiveKeyboard workstation={workstation} />}
      </FloatingWindow>}
      <div className="ws-body">
        {!narrow && <nav className="ws-tracks ws-flow" aria-label="Tracks">
          {p.tracks.length === 0 && <p className="ws-dim">Open the Player / Library to load a MIDI file, or generate a Bach fugue there. Agents can also create a new composition with gbk_create_project.</p>}
          {p.meta?.key && <div className="ws-dim" data-testid="ws-key">Key: {p.meta.key}{p.meta.sections?.length ? ` · ${p.meta.sections.length} sections` : ""}</div>}
          {p.tracks.map((t) => {
            const ov = state.overrides[t.id];
            const count = p.notes.filter((n) => n.trackId === t.id).length;
            return (
              <div key={t.id} className={`ws-track ${trackForLanes?.id === t.id ? "active" : ""}`} data-testid={`track-${t.name}`}>
                <div className="ws-row">
                  <span className="ws-swatch" style={{ background: t.color }} />
                  <button className="ws-link" onClick={() => workstation.setSelection({ trackIds: [t.id] })} title={t.name}>{t.name}</button>
                  <span className="ws-dim">ch{t.channel + 1} · {count}</span>
                </div>
                <div className="ws-row">
                  <label><input type="checkbox" checked={t.visible} onChange={(e) => workstation.userEdit([{ op: "updateTrack", trackId: t.id, visible: e.target.checked }], { label: "toggle visibility" })} />show</label>
                  <label><input type="checkbox" checked={t.mix.mute} onChange={(e) => workstation.setTrackMixDefault(t.id, { mute: e.target.checked })} />M</label>
                  <label><input type="checkbox" checked={t.mix.solo} onChange={(e) => workstation.setTrackMixDefault(t.id, { solo: e.target.checked })} />S</label>
                </div>
                <label className="ws-knob">vol <input type="range" min={0} max={127} value={ov?.volume ?? t.mix.volume} onChange={(e) => workstation.setTrackMixDefault(t.id, { volume: +e.target.value })} /></label>
                <label className="ws-knob">pan <input type="range" min={0} max={127} value={ov?.pan ?? t.mix.pan} onChange={(e) => workstation.setTrackMixDefault(t.id, { pan: +e.target.value })} /></label>
                {ov && <button className="ws-link" onClick={() => workstation.setOverride(t.id, null)}>clear live override</button>}
              </div>
            );
          })}
        </nav>}
        <main className="ws-main" ref={mainRef}>
          <div className="ws-roll-slot" ref={rollRef}>
            <PianoRollEditor project={p} proposal={focus} view={view} setView={setView} height={Math.max(ROLL_MIN, Math.floor(rollBox.h))} onManualScroll={() => setFollow(false)} onWidth={(px) => { rollPx.current = px; }} />
          </div>
          <div className="ws-lanes">
            {(() => {
              const pages = Math.max(1, Math.ceil(lanes.length / laneFit)); const pg = Math.min(lanePage, pages - 1);
              return (<>
                <div className="ws-row ws-dim">Automation for <b style={{ color: trackForLanes?.color }}>{trackForLanes?.name ?? "–"}</b>
                  <button onClick={() => { setLanes([...lanes, 7]); setLanePage(Math.floor(lanes.length / laneFit)); }}>+ lane</button>
                  {pages > 1 && <span className="ws-lane-pager" data-testid="lane-pager">
                    <button aria-label="Previous lanes" disabled={pg === 0} onClick={() => setLanePage(pg - 1)}>‹</button>
                    lanes {pg * laneFit + 1}–{Math.min(lanes.length, (pg + 1) * laneFit)} of {lanes.length}
                    <button aria-label="Next lanes" disabled={pg >= pages - 1} onClick={() => setLanePage(pg + 1)}>›</button></span>}
                </div>
                {!laneRoom && lanes.length > 0 && <span className="ws-dim" data-testid="lanes-no-room"> · {lanes.length} lane{lanes.length === 1 ? "" : "s"} hidden: close Keys for room</span>}
                {trackForLanes && laneRoom > 0 && lanes.map((l, i) => (i < pg * laneFit || i >= (pg + 1) * laneFit) ? null : (
                  <AutomationLane key={i} project={p} proposal={focus} view={view} trackId={trackForLanes.id} lane={l} height={LANE_H}
                    onChangeLane={(nl) => setLanes(lanes.map((x, j) => (j === i ? nl : x)))} onRemove={() => setLanes(lanes.filter((_, j) => j !== i))} />
                ))}
              </>);
            })()}
          </div>
        </main>
        <div className="ws-side">
          <div className="ws-tabs" role="tablist" aria-label="Panels">
            {tabs.map((t) => <button key={t} role="tab" aria-selected={t === activeTab} className={t === activeTab ? "on" : ""} data-testid={`tab-${t.toLowerCase()}`} onClick={() => setTab(t)}>{t}{t === "Agent" && pendingCount ? ` (${pendingCount})` : ""}</button>)}
          </div>
          <div className={`ws-tabbody ${activeTab === "Composer" ? "ws-tab-composer" : "ws-flow"}`} role="tabpanel" aria-label={activeTab}>
            {activeTab === "Tracks" && <nav className="ws-tracks" aria-label="Tracks">
          {p.tracks.length === 0 && <p className="ws-dim">Open the Player / Library to load a MIDI file, or generate a Bach fugue there. Agents can also create a new composition with gbk_create_project.</p>}
          {p.meta?.key && <div className="ws-dim" data-testid="ws-key">Key: {p.meta.key}{p.meta.sections?.length ? ` · ${p.meta.sections.length} sections` : ""}</div>}
          {p.tracks.map((t) => {
            const ov = state.overrides[t.id];
            const count = p.notes.filter((n) => n.trackId === t.id).length;
            return (
              <div key={t.id} className={`ws-track ${trackForLanes?.id === t.id ? "active" : ""}`} data-testid={`track-${t.name}`}>
                <div className="ws-row">
                  <span className="ws-swatch" style={{ background: t.color }} />
                  <button className="ws-link" onClick={() => workstation.setSelection({ trackIds: [t.id] })} title={t.name}>{t.name}</button>
                  <span className="ws-dim">ch{t.channel + 1} · {count}</span>
                </div>
                <div className="ws-row">
                  <label><input type="checkbox" checked={t.visible} onChange={(e) => workstation.userEdit([{ op: "updateTrack", trackId: t.id, visible: e.target.checked }], { label: "toggle visibility" })} />show</label>
                  <label><input type="checkbox" checked={t.mix.mute} onChange={(e) => workstation.setTrackMixDefault(t.id, { mute: e.target.checked })} />M</label>
                  <label><input type="checkbox" checked={t.mix.solo} onChange={(e) => workstation.setTrackMixDefault(t.id, { solo: e.target.checked })} />S</label>
                </div>
                <label className="ws-knob">vol <input type="range" min={0} max={127} value={ov?.volume ?? t.mix.volume} onChange={(e) => workstation.setTrackMixDefault(t.id, { volume: +e.target.value })} /></label>
                <label className="ws-knob">pan <input type="range" min={0} max={127} value={ov?.pan ?? t.mix.pan} onChange={(e) => workstation.setTrackMixDefault(t.id, { pan: +e.target.value })} /></label>
                {ov && <button className="ws-link" onClick={() => workstation.setOverride(t.id, null)}>clear live override</button>}
              </div>
            );
          })}
            </nav>}
            {composer && <div hidden={activeTab !== "Composer"} className="ws-tabfill"><ComposerPanel project={p} readOnly={workstation.readOnlyReason} /></div>}
            {activeTab === "Agent" && <AgentPanel state={state} focusProposal={focus} setFocus={setFocus} />}
            {activeTab === "Sound" && <SoundPanel project={p} trackId={trackForLanes?.id} proposal={focus} />}
            {activeTab === "Files" && <><div className="ws-row"><VideoExportButton /></div><ArtifactPanel /></>}
          </div>
        </div>
      </div>
    </div>
  );
}
