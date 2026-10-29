// Chat-first phone studio (<500px or the iOS app; WorkstationView renders it when compact). One conversation with the
// AI Composer: every reply that changes the song is a version card (v1, v2, ...) with Play / Open editor / Publish.
// Header = title + play pill + ⋯. Tracks, Mixer, Sound and Automation live in the editor sheet. The composer input
// is ALWAYS visible (docs/social/feed-design.md): sheets open above the input bar, never over it.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWorkstation, workstation } from "../workstation/useWorkstation.ts";
import { useAgentSession, type ChatItem } from "../../agent/useAgentSession.ts";
import { songAutosaver } from "../../agent/autosave.ts";
import { openShared } from "../../agent/share-client.ts";
import { takeRemixHandoff, type RemixHandoff } from "../../agent/remix-handoff.ts";
import { needSignIn, takePending } from "../auth/gate.ts";
import { PianoRollEditor, type View } from "../workstation/PianoRollEditor.tsx";
import { AutomationLane, type LaneKind } from "../workstation/AutomationLane.tsx";
import { AgentPanel } from "../workstation/AgentPanel.tsx";
import { SoundPanel } from "../workstation/SoundPanel.tsx";
import { AddTrackButton } from "../workstation/AddTrack.tsx";
import { LiveKeyboard, liveRig } from "../workstation/LiveKeyboard.tsx";
import { VideoExportButton } from "../workstation/VideoExport.tsx";
import { useWebHum } from "../workstation/HumButton.tsx";
import { openMidiFile } from "../workstation/MidiImportChooser.tsx";
import { ComposerSettings } from "../composer/ComposerSettings.tsx";
import { saveForPublish } from "../composer/SharePanel.tsx";
import { PublishDialog } from "../songs/PublishDialog.tsx";
import { ensureGuestSession, inNativeApp, nativePublish } from "../../agent/native-guest.ts";
import { MySongs } from "../songs/MySongs.tsx";
import { nativeHum, type HumState } from "../../hum/native-bridge.ts";
import { MIDI_UNSUPPORTED_MESSAGE } from "../../workstation/midi-input.ts";
import { isMidiFile } from "../../workstation/midi-import.ts";
import { tickToSec } from "../../workstation/timing.ts";
import type { Project } from "../../workstation/model.ts";
import type { Proposal } from "../../workstation/controller.ts";
import type { SavedSong } from "../../agent/share-client.ts";
import { reportError } from "../../telemetry/error-reporter.ts";
import { fmtTime, friendlyError, plainStep, songSeconds, trackChips, versionLog, type SongVersion } from "./studio-logic.ts";
import "./mobile-studio.css";
import { RecentProjects } from "./RecentProjects.tsx";
import { startNew } from "../../workstation/studio-api.ts";

export const SUGGESTIONS = [
  { icon: "🌙", text: "A calm lo-fi beat for studying" },
  { icon: "🎻", text: "Turn “Twinkle Twinkle” into a string quartet" },
  { icon: "🥁", text: "Upbeat pop groove, 120 bpm" },
];
type Sheet = null | "plus" | "more" | "editor" | "settings" | "export" | "rename" | "songs" | "midi" | "recent";
type EditorTab = "Tracks" | "Mixer" | "Sound" | "Automation" | "Agent";
type Native = { gbkNative?: object; gbkMidiNative?: { bluetooth?: unknown; openBluetoothPairing?: () => void }; webkit?: { messageHandlers?: Record<string, { postMessage: (m: unknown) => void } | undefined> } };
const win = () => window as unknown as Native;

export interface MobileStudioProps {
  view: View; setView: (v: View) => void; onRollWidth: (px: number) => void; onManualScroll: () => void;
  focus: Proposal | null; setFocus: (id: string | null) => void; lanes: LaneKind[]; setLanes: (l: LaneKind[]) => void; laneTrackId?: string;
  onExplore?: () => void; newProject: () => Promise<boolean>; exportMidi: () => void; exportWav: () => Promise<void>;
}

export function MobileStudio(props: MobileStudioProps) {
  const state = useWorkstation(); const p = state.project; const t = state.transport;
  const s = useAgentSession();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [tab, setTab] = useState<EditorTab>("Tracks");
  const [fullRoll, setFullRoll] = useState(false);
  const [toast, setToast] = useState<{ text: string; undo?: boolean } | null>(null);
  const say = (text: string, undo = false) => setToast({ text, undo });
  useEffect(() => { if (!toast) return; const h = setTimeout(() => setToast(null), toast.undo ? 6000 : 4000); return () => clearTimeout(h); }, [toast]);
  const [, bump] = useState(0); useEffect(() => versionLog.subscribe(() => bump((x) => x + 1)), []);
  const [publish, setPublish] = useState<SavedSong | null>(null);
  const [busy, setBusy] = useState("");

  // ---- conversation ---------------------------------------------------------------------------------------------
  useEffect(() => { if (s.auth.authenticated) songAutosaver.start(); else songAutosaver.stop(); }, [s.auth.authenticated]);
  const prevRun = useRef<string | null>(null);
  useEffect(() => { // a finished reply that changed the song becomes the next version card
    const was = prevRun.current; prevRun.current = s.run?.runId ?? null;
    if (!was || s.run) return;
    const last = s.items[s.items.length - 1]; if (last?.role === "error") return;
    versionLog.record(was, workstation.project); void songAutosaver.flush().catch(() => undefined);
  }, [s.run, s.items]);
  const [text, setText] = useState(() => { const d = sessionStorage.getItem("gbk.composerDraft") ?? ""; sessionStorage.removeItem("gbk.composerDraft"); return d; });
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const f = () => { const h = takeRemixHandoff(); if (h) { void applyRemixRef.current(h); return; } const d = sessionStorage.getItem("gbk.composerDraft"); if (d) sessionStorage.removeItem("gbk.composerDraft"); if (sessionStorage.getItem("gbk.composerFresh")) { sessionStorage.removeItem("gbk.composerFresh"); void (async () => { await newSongRef.current(); if (d) setText(d); input.current?.focus(); })(); return; } if (d) setText(d); input.current?.focus(); }; window.addEventListener("gbk:focus-composer", f); return () => window.removeEventListener("gbk:focus-composer", f); }, []);
  useEffect(() => { if (s.conn.state === "connected" && sessionStorage.getItem("gbk.focusComposer")) { sessionStorage.removeItem("gbk.focusComposer"); input.current?.focus(); } }, [s.conn.state]);
  useEffect(() => { if (s.conn.state !== "connected") return; const q = takePending("compose"); if (q && s.send(q.text)) { setText(""); sessionStorage.removeItem("gbk.composerDraft"); } }, [s.conn.state]);
  useEffect(() => { if (s.auth.authenticated && takePending("publish")) void doPublish(); }, [s.auth.authenticated]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = !!s.run;
  const send = (raw = text) => {
    const v = raw.trim(); if (!v) { input.current?.focus(); return; }
    if (!s.auth.authenticated) { sessionStorage.setItem("gbk.composerDraft", v); needSignIn("Sign in to compose with the AI. It's free, with a daily limit.", { kind: "compose", text: v }); return; }
    if (workstation.readOnlyReason) { say("This shared song is read-only. Tap “Make a copy” to change it."); return; }
    if (s.conn.state !== "connected") { say("Still connecting to the composer. Try again in a moment."); s.reconnect(); return; }
    if (running) return;
    if (s.send(v)) setText(""); else say("Couldn't send that. Check your connection and try again.");
  };
  // Input height follows its content (1-5 lines), so the bar never covers the chat.
  useEffect(() => { const el = input.current; if (!el) return; el.style.height = "auto"; el.style.height = `${Math.min(120, Math.max(44, el.scrollHeight + 2))}px`; }, [text]);

  // ---- layout: sheets sit above the input bar --------------------------------------------------------------------
  const root = useRef<HTMLDivElement>(null); const foot = useRef<HTMLElement>(null); const chat = useRef<HTMLDivElement>(null);
  useEffect(() => { const f = foot.current, r = root.current; if (!f || !r || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => r.style.setProperty("--ms-foot", `${f.offsetHeight}px`)); ro.observe(f); r.style.setProperty("--ms-foot", `${f.offsetHeight}px`); return () => ro.disconnect(); }, []);
  useEffect(() => { const c = chat.current; if (c) c.scrollTop = c.scrollHeight; }, [s.items, running, versionLog.list(p.id).length]);
  useEffect(() => { const on = () => { setTab("Agent"); setSheet("editor"); }; addEventListener("gbk-approval-request", on); return () => removeEventListener("gbk-approval-request", on); }, []);

  // ---- playback --------------------------------------------------------------------------------------------------
  const versions = versionLog.list(p.id);
  const [preview, setPreview] = useState<{ n: number; ac: AbortController } | null>(null);
  const stopPreview = () => { preview?.ac.abort(); setPreview(null); };
  const playCurrent = () => { stopPreview(); if (t.playing) workstation.pause(); else workstation.play().catch((e) => { reportError(e, { where: "studio.play" }); say("Sound is still loading. Try Play again in a moment."); }); };
  const playVersion = (v: SongVersion, current: boolean) => {
    if (current) return playCurrent();
    if (preview?.n === v.n) return stopPreview();
    stopPreview(); const ac = new AbortController(); setPreview({ n: v.n, ac });
    workstation.previewProject(v.snapshot, ac.signal).catch((e) => { reportError(e, { where: "studio.previewVersion" }); say("Couldn't play that version right now."); }).finally(() => setPreview((x) => (x?.ac === ac ? null : x)));
  };
  const pos = tickToSec(p, t.positionTick), total = songSeconds(p);
  const restore = (v: SongVersion) => { stopPreview(); if (workstation.restoreSnapshot(v.snapshot, `restore v${v.n}`)) { say(`Restored v${v.n}.`, true); return true; } return false; };
  const makeCurrent = (v: SongVersion | null) => !v || v.revision === p.revision || restore(v);

  // ---- actions ---------------------------------------------------------------------------------------------------
  const doPublish = async (v: SongVersion | null = null) => {
    setSheet(null);
    const native = inNativeApp();
    if (!native && !s.auth.authenticated) { needSignIn("Sign in to publish and share your song.", { kind: "publish" }); return; }
    if (workstation.readOnlyReason) { say("Make a copy of this song first, then publish your version."); return; }
    if (!makeCurrent(v)) return;
    if (!workstation.project.tracks.length) { say("Make something first, then publish it."); return; }
    setBusy("Saving your song…");
    try {
      if (native && !s.auth.authenticated) { try { await ensureGuestSession(); } catch (e) { say((e as Error).message); return; } void s.refreshAuth(); }
      const saved = await saveForPublish();
      // App hand-off: only after the private save finished, so the native sheet can publish this exact share.
      if (native && nativePublish({ projectId: workstation.project.id, slug: saved.slug, title: saved.title || workstation.project.name, labels: [], tags: [] })) return;
      setPublish(saved); } catch (e) { reportError(e, { where: "studio.publish" }); say("Couldn't save your song. Check your connection and try again."); } finally { setBusy(""); }
  };
  const openEditor = (v: SongVersion | null = null) => { if (makeCurrent(v)) { setTab("Tracks"); setSheet("editor"); } };
  const newSong = async () => { setSheet(null); stopPreview(); if (await props.newProject()) { if (s.auth.authenticated) s.reset(); setText(""); } };
  const newSongRef = useRef(newSong); newSongRef.current = newSong;
  // Remix landing when the Studio mounts after the flag was set (the focus event may already have fired):
  // start the fresh session once, then put back the draft the initializer loaded (newSong clears the input).
  useEffect(() => { if (!sessionStorage.getItem("gbk.composerFresh")) return; sessionStorage.removeItem("gbk.composerFresh"); const d = text; void (async () => { await newSongRef.current(); if (d) setText(d); })(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // #162: a remix handoff names the song, not just a prompt. Load the user's editable fork of it, start a
  // FRESH agent session on that fork (never newProject() — that would empty the song back out), and prefill
  // the original prompt. If the song cannot load, fall back to a prompt-only landing in a FRESH session
  // (newSong, the #161 flow) with a toast — never on top of the previous chat.
  const remixBusy = useRef(false);
  const applyRemix = async (h: RemixHandoff) => {
    if (remixBusy.current) return; remixBusy.current = true;
    setSheet(null); stopPreview(); sessionStorage.removeItem("gbk.composerDraft");
    try {
      const info = await openShared(h.slug, true);
      versionLog.recordOriginal(workstation.project);
      s.reset();
      s.setRemixOf({ slug: h.slug, title: info.title });
      setText(h.prompt);
      say(`Remixing “${info.title}” — your copy is loaded.`);
    } catch (e) {
      reportError(e, { where: "studio.remixLoad", slug: h.slug });
      await newSongRef.current(); // #161: even when the song fails to load, the landing is a FRESH session, never the previous chat
      setText(h.prompt);
      say("Couldn't load that song, so the prompt is in the composer on its own.");
    } finally { remixBusy.current = false; input.current?.focus(); }
  };
  const applyRemixRef = useRef(applyRemix); applyRemixRef.current = applyRemix;
  // Remix landing when the Studio mounts after the handoff was written (the focus event may already have fired).
  useEffect(() => { const h = takeRemixHandoff(); if (h) void applyRemixRef.current(h); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const exportWav = () => { setSheet(null); setBusy("Rendering WAV…"); props.exportWav().catch((e) => { reportError(e, { where: "studio.exportWav" }); say("Couldn't render the WAV. Please try again."); }).finally(() => setBusy("")); };

  // ---- + sheet: sheet music, MIDI file, MIDI keyboard ---------------------------------------------------------------
  const imgIn = useRef<HTMLInputElement>(null); const midiIn = useRef<HTMLInputElement>(null);
  const scanSheet = () => { setSheet(null); imgIn.current?.click(); };
  const readSheetImage = async (f: File) => {
    setBusy("Reading your sheet music…");
    try {
      const { isSupportedSheetMusicImageFile, parseSheetMusicToMidi } = await import("../../sheet-music-reader.ts");
      if (!isSupportedSheetMusicImageFile(f)) { say("Use a JPEG or PNG photo of the sheet music."); return; }
      const r = await parseSheetMusicToMidi(f);
      openMidiFile(new File([r.midiData], `${r.fileName.replace(/\.(mid|midi)$/i, "")}.mid`, { type: "audio/midi" }));
    } catch (e) { reportError(e, { where: "studio.scanSheet" }); say("Couldn't read notes from that photo. Try a sharper, well-lit, straight-on photo of one page."); }
    finally { setBusy(""); }
  };
  const midiSupported = liveRig(workstation).midi.supported; const bt = win().gbkMidiNative;
  const hasBt = !!bt?.bluetooth && typeof bt.openBluetoothPairing === "function";

  // ---- Hum (mic): iOS native recorder via the hum bridge, else the in-browser flow ----------------------------------
  const isNative = nativeHum();
  const web = useWebHum((m) => say(m));
  const [nst, setNst] = useState<HumState>({ phase: "idle", elapsed: 0, progress: 0 });
  useEffect(() => { const f = (e: Event) => setNst((e as CustomEvent<HumState>).detail); window.addEventListener("gbk:hum-state", f); return () => window.removeEventListener("gbk:hum-state", f); }, []);
  const hum = isNative ? { ...nst, start: () => win().webkit?.messageHandlers?.hum?.postMessage({ type: "toggle" }), stop: () => win().webkit?.messageHandlers?.hum?.postMessage({ type: "toggle" }), cancel: () => win().webkit?.messageHandlers?.hum?.postMessage({ type: "cancel" }) } : web;
  const humTap = () => { if (hum.phase === "idle") void hum.start(); else if (hum.phase === "recording") void hum.stop(); };

  // ---- render -------------------------------------------------------------------------------------------------------
  const title = p.tracks.length || p.name !== "Untitled" ? p.name : "New song";
  const latest = versions[versions.length - 1];
  const original = versions.find((v) => v.label === "Original");
  const showCurrent = p.tracks.length > 0 && !running && (!latest || latest.revision !== p.revision);
  const loading = !t.audioReady && !t.playing;
  const ro = workstation.readOnlyReason; const from = p.meta?.sharedFrom;
  return (
    <div className="ms" ref={root} data-testid="workstation" data-compact="1" data-sheet={sheet ?? ""}>
      <header className="ms-head" data-testid="compact-head">
        {props.onExplore && <button className="ms-btn ms-back" aria-label="Back to Explore" data-testid="studio-back" onClick={() => { stopPreview(); props.onExplore!(); }}>‹</button>}
        <h1 className="ms-title" data-testid="studio-title" title={title}>{title}</h1>
        <button className={`ms-btn ms-pill${t.playing ? " on" : ""}`} data-testid="play-pill" disabled={!p.tracks.length || (loading && !t.starting)} aria-label={t.playing ? "Pause" : "Play"} onClick={playCurrent}>
          {t.playing ? <>❚❚ <span data-testid="play-time">{fmtTime(pos)}</span></> : t.starting ? "Loading…" : loading && p.tracks.length ? `Loading${t.sf2Progress != null ? ` ${Math.round(t.sf2Progress * 100)}%` : "…"}` : "▶︎ Play"}
        </button>
        <button className="ms-btn ms-new" data-testid="studio-new" aria-label="New project" onClick={() => { stopPreview(); setSheet(null); void startNew(); }}>＋ New</button>
        <button className="ms-btn" aria-label="More" data-testid="studio-overflow" aria-haspopup="dialog" aria-expanded={sheet === "more"} onClick={() => setSheet(sheet === "more" ? null : "more")}>⋯</button>
      </header>

      <main className="ms-chat" ref={chat} data-testid="studio-chat" aria-live="polite">
        {ro && <div className="ms-note" data-testid="readonly-banner" role="status">You're listening to <b>{from?.title ?? p.name}</b>{from?.owner ? <> by {from.owner}</> : null}. Make your own copy to change it. <button className="ms-btn ms-small" data-testid="fork-btn" onClick={() => workstation.fork()}>Make a copy</button></div>}
        {!s.items.length && !p.tracks.length && <div className="ms-empty" data-testid="studio-empty">
          <h2>What should we make?</h2><p>Describe a song, hum a melody, or import sheet music.</p>
          <div className="ms-sug">{SUGGESTIONS.map((x) => <button key={x.text} data-testid="suggestion" onClick={() => send(x.text)}>{x.icon} {x.text}</button>)}</div>
        </div>}
        {original && <VersionCard v={original} p={p} playing={original.revision === p.revision ? t.playing : preview?.n === original.n} pos={pos} total={total} current={original.revision === p.revision}
          onPlay={() => playVersion(original, original.revision === p.revision)} onEdit={() => openEditor(original)} onPublish={() => void doPublish(original)} onRestore={() => restore(original)} />}
        {s.items.map((m) => <Message key={m.id} m={m} p={p} live={m.runId != null && m.runId === s.run?.runId} onRetry={(x) => send(x)}
          card={(v) => <VersionCard v={v} p={p} playing={v.revision === p.revision ? t.playing : preview?.n === v.n} pos={pos} total={total} current={v.revision === p.revision}
            onPlay={() => playVersion(v, v.revision === p.revision)} onEdit={() => openEditor(v)} onPublish={() => void doPublish(v)} onRestore={() => restore(v)} />} />)}
        {showCurrent && <VersionCard p={p} playing={t.playing} pos={pos} total={total} current onPlay={playCurrent} onEdit={() => openEditor()} onPublish={() => void doPublish()} />}
        {s.auth.authenticated && s.conn.state !== "connected" && s.conn.state !== "connecting" && s.conn.state !== "idle" && <div className="ms-note" data-testid="conn-note">{s.conn.state === "reconnecting" ? "Reconnecting to the composer…" : "The composer is offline right now."} {s.conn.state !== "reconnecting" && <button className="ms-btn ms-small" onClick={s.reconnect}>Try again</button>}</div>}
      </main>

      {(sheet || fullRoll) && <div className="ms-scrim" data-testid="sheet-scrim" onClick={() => { setSheet(null); setFullRoll(false); }} />}
      {sheet === "plus" && <SheetBox id="plus" label="Add to your song">
        {!win().gbkNative && <Row icon="📷" title="Import sheet music" sub="Scan or pick a photo" testId="plus-sheet-music" onClick={scanSheet} />}
        <Row icon="🎼" title="Import MIDI file" sub=".mid or .midi" testId="plus-midi-file" onClick={() => { setSheet(null); midiIn.current?.click(); }} />
        <Row icon="🎹" title="Connect MIDI keyboard" sub={hasBt ? "USB or Bluetooth" : "USB"} testId="plus-midi-keyboard" onClick={() => setSheet("midi")} />
      </SheetBox>}
      {sheet === "midi" && <SheetBox id="midi" label="MIDI keyboard" title="MIDI keyboard">
        {midiSupported ? <LiveKeyboard workstation={workstation} /> : <p className="ms-mut" data-testid="midi-unsupported">{MIDI_UNSUPPORTED_MESSAGE}.</p>}
        {hasBt && <Row icon="ᛒ" title="Pair a Bluetooth keyboard" sub="Opens Bluetooth MIDI pairing" testId="bt-midi" onClick={() => bt!.openBluetoothPairing!()} />}
      </SheetBox>}
      {sheet === "recent" && <SheetBox id="recent" label="Recent projects" title="Recent projects"><div data-testid="recent-list"><RecentProjects className="ms-row" onDone={() => setSheet(null)} /></div></SheetBox>}
      {sheet === "more" && <SheetBox id="more" label="More">
        <Row icon="📤" title="Publish & share" sub="Get a public link" testId="more-publish" onClick={() => void doPublish()} />
        <Row icon="⬇️" title="Export" sub="MIDI, WAV, video" testId="more-export" onClick={() => setSheet("export")} />
        <Row icon="🕘" title="Recent projects" sub="Saved on this device" testId="more-recent" onClick={() => setSheet("recent")} />
        <Row icon="📁" title="My songs" testId="more-songs" onClick={() => { if (!s.auth.authenticated) { setSheet(null); needSignIn("Sign in to see your saved songs."); } else setSheet("songs"); }} />
        <Row icon="✏️" title="Rename" testId="more-rename" onClick={() => setSheet("rename")} />
        <Row icon="🆕" title="New song" testId="new-project" onClick={() => void newSong()} />
        <Row icon="⚙️" title="Settings" sub="Model, usage, account" testId="more-settings" onClick={() => setSheet("settings")} />
      </SheetBox>}
      {sheet === "export" && <SheetBox id="export" label="Export" title="Export">
        <Row icon="🎼" title="MIDI file" testId="export-midi" disabled={!p.tracks.length} onClick={() => { setSheet(null); props.exportMidi(); }} />
        <Row icon="🔊" title="WAV audio" testId="export-wav" disabled={!p.tracks.length} onClick={exportWav} />
        <div className="ms-row"><span className="ms-ic">🎬</span><div className="ms-grow">Video<small>Moving piano roll with sound</small></div><VideoExportButton compact /></div>
      </SheetBox>}
      {sheet === "rename" && <SheetBox id="rename" label="Rename" title="Rename song"><RenameForm name={p.name} onDone={(n) => { setSheet(null); if (n != null && !workstation.rename(n) && workstation.readOnlyReason) say("Make a copy of this song to rename it."); }} /></SheetBox>}
      {sheet === "songs" && <SheetBox id="songs" label="My songs"><MySongs compact /></SheetBox>}
      {sheet === "settings" && <SheetBox id="settings" label="Settings" title="Settings">
        {s.auth.authenticated
          ? <ComposerSettings open info={s.info} model={s.model} setModel={s.setModel} usage={s.usage} user={s.auth.name ?? s.auth.user} onLogout={() => void s.logout()} onReset={s.reset} />
          : <p className="ms-mut" data-testid="settings-guest">You're browsing as a guest. You'll be asked to sign in when you compose or publish.</p>}
        <p className="ms-mut">Theme follows your device (light or dark).</p>
      </SheetBox>}
      {/* Editor: always mounted (hidden when closed) so an agent approval request can always surface. */}
      <section className={`ms-sheet ms-editor${fullRoll ? " full" : ""}`} data-testid="sheet-editor" role="dialog" aria-label="Editor" hidden={sheet !== "editor" && !fullRoll}>
        <div className="ms-grab" />
        <div className="ms-edhead"><h3>{title}{latest && latest.revision === p.revision ? ` v${latest.n}` : ""}</h3>
          <button className="ms-btn ms-small" disabled={!state.canUndo} onClick={() => workstation.undo()} data-testid="editor-undo">Undo</button>
          <button className="ms-btn ms-small" disabled={!state.canRedo} onClick={() => workstation.redo()}>Redo</button>
          <button className="ms-btn ms-small" aria-label="Close editor" data-testid="editor-close" onClick={() => { setSheet(null); setFullRoll(false); }}>✕</button></div>
        <div className="ms-roll" data-testid="editor-roll">
          {(sheet === "editor" || fullRoll) && <PianoRollEditor project={p} proposal={props.focus} view={props.view} setView={props.setView} height={fullRoll ? Math.max(240, Math.round((root.current?.clientHeight ?? 700) - 270)) : 170} onManualScroll={props.onManualScroll} onWidth={props.onRollWidth} />}
        </div>
        <div className="ms-row2"><button className="ms-btn ms-small" data-testid="full-roll" onClick={() => setFullRoll(!fullRoll)}>{fullRoll ? "Exit full screen" : "Full-screen piano roll"}</button>
          <button className="ms-btn ms-small" aria-label="Zoom in" onClick={() => props.setView({ ...props.view, pxPerTick: props.view.pxPerTick * 1.25 })}>＋</button>
          <button className="ms-btn ms-small" aria-label="Zoom out" onClick={() => props.setView({ ...props.view, pxPerTick: props.view.pxPerTick / 1.25 })}>－</button></div>
        {!fullRoll && <>
          <div className="ms-seg" role="tablist" aria-label="Editor">
            {(["Tracks", "Mixer", "Sound", "Automation", ...(state.proposals.some((x) => x.status === "pending") || tab === "Agent" ? ["Agent"] : [])] as EditorTab[]).map((x) =>
              <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? "on" : ""} data-testid={`tab-${x.toLowerCase()}`} onClick={() => setTab(x)}>{x}</button>)}
          </div>
          <div className="ms-edbody">
            {tab === "Tracks" && <div data-testid="editor-tracks"><div className="ms-row2"><AddTrackButton testId="add-track" /></div>
              {p.tracks.map((tr) => <div key={tr.id} className={`ms-trk${props.laneTrackId === tr.id ? " sel" : ""}`} data-testid={`track-${tr.name}`}>
                <span className="ms-sw" style={{ background: tr.color }} /><button className="ms-link" onClick={() => workstation.setSelection({ trackIds: [tr.id] })}>{tr.name}</button>
                <span className="ms-mut">{p.notes.filter((n) => n.trackId === tr.id).length} notes</span>
                <button className="ms-btn ms-small" aria-label={`${tr.visible ? "Hide" : "Show"} ${tr.name}`} onClick={() => workstation.userEdit([{ op: "updateTrack", trackId: tr.id, visible: !tr.visible }], { label: "toggle visibility" })}>{tr.visible ? "Hide" : "Show"}</button></div>)}
              {!p.tracks.length && <p className="ms-mut">No tracks yet. Ask the composer, hum, or add a track.</p>}</div>}
            {tab === "Mixer" && <div data-testid="editor-mixer">{p.tracks.map((tr) => { const ov = state.overrides[tr.id]; return <div key={tr.id} className="ms-mix">
              <div className="ms-row2"><span className="ms-sw" style={{ background: tr.color }} /><b className="ms-grow">{tr.name}</b>
                <button className="ms-btn ms-small" aria-pressed={tr.mix.mute} aria-label={`Mute ${tr.name}`} onClick={() => workstation.setTrackMixDefault(tr.id, { mute: !tr.mix.mute })}>M</button>
                <button className="ms-btn ms-small" aria-pressed={tr.mix.solo} aria-label={`Solo ${tr.name}`} onClick={() => workstation.setTrackMixDefault(tr.id, { solo: !tr.mix.solo })}>S</button></div>
              <label>Volume <input type="range" min={0} max={127} value={ov?.volume ?? tr.mix.volume} onChange={(e) => workstation.setTrackMixDefault(tr.id, { volume: +e.target.value })} /></label>
              <label>Pan <input type="range" min={0} max={127} value={ov?.pan ?? tr.mix.pan} onChange={(e) => workstation.setTrackMixDefault(tr.id, { pan: +e.target.value })} /></label></div>; })}
              {!p.tracks.length && <p className="ms-mut">No tracks to mix yet.</p>}</div>}
            {tab === "Sound" && <SoundPanel project={p} trackId={props.laneTrackId} proposal={props.focus} />}
            {tab === "Automation" && <div data-testid="editor-automation">
              {props.laneTrackId ? <>{props.lanes.map((l, i) => <AutomationLane key={i} project={p} proposal={props.focus} view={props.view} trackId={props.laneTrackId!} lane={l} height={48}
                onChangeLane={(nl) => props.setLanes(props.lanes.map((x, j) => (j === i ? nl : x)))} onRemove={() => props.setLanes(props.lanes.filter((_, j) => j !== i))} />)}
                <button className="ms-btn ms-small" onClick={() => props.setLanes([...props.lanes, 7])}>+ Lane</button></> : <p className="ms-mut">Pick a track in Tracks to edit its automation.</p>}</div>}
            <div hidden={tab !== "Agent"}><AgentPanel state={state} focusProposal={props.focus} setFocus={props.setFocus} /></div>
          </div></>}
      </section>

      <footer className="ms-foot" ref={foot} data-testid="composer-bar" data-state={s.auth.authenticated ? s.conn.state : "signed-out"}>
        {hum.phase !== "idle" && <div className="ms-rec" data-testid="hum-strip" role="status">
          {hum.phase === "recording" ? <>● {fmtTime(hum.elapsed)} <span className="ms-wave" /> Listening… tap ✓ when done</> : <>Turning your melody into notes{hum.progress > 0 ? ` ${Math.round(hum.progress * 100)}%` : "…"}</>}
          {hum.phase === "recording" && <button className="ms-btn ms-small" aria-label="Cancel recording" data-testid="hum-cancel" onClick={() => hum.cancel()}>✕</button>}
        </div>}
        {busy && <div className="ms-rec ms-busy" role="status" data-testid="studio-busy">{busy}</div>}
        {toast && <div className="ms-toast" role="status" data-testid="studio-toast">{toast.text}{toast.undo && <button className="ms-btn ms-small" data-testid="toast-undo" onClick={() => { workstation.undo(); setToast(null); }}>Undo</button>}</div>}
        <form className="ms-bar" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <button type="button" className="ms-btn" aria-label="Add" data-testid="plus-btn" aria-expanded={sheet === "plus"} onClick={() => setSheet(sheet === "plus" ? null : "plus")}>＋</button>
          <textarea ref={input} data-testid="composer-input" rows={1} maxLength={12000} value={text} aria-label="Describe a song or a change"
            placeholder={running ? "Composing… keep typing" : ro ? "Make a copy to change this song…" : p.tracks.length ? "Describe a change…" : "Describe a song…"}
            onChange={(e) => { setText(e.target.value); if (!s.auth.authenticated) sessionStorage.setItem("gbk.composerDraft", e.target.value); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
          {running ? <button type="button" className="ms-btn ms-stop" aria-label="Stop composing" data-testid="composer-stop" onClick={s.stop}>■</button>
            : text.trim() ? <button type="submit" className="ms-btn ms-send" aria-label="Send" data-testid="composer-send">↑</button>
            : <button type="button" className={`ms-btn${hum.phase === "recording" ? " ms-send" : ""}`} data-testid="hum-btn" data-native={isNative ? "1" : "0"} data-phase={hum.phase} disabled={hum.phase === "transcribing"}
                aria-label={hum.phase === "recording" ? "Done humming" : "Hum a melody"} onClick={humTap}>{hum.phase === "recording" ? "✓" : "🎤"}</button>}
        </form>
      </footer>
      <input ref={imgIn} type="file" accept="image/jpeg,image/png" hidden data-testid="sheet-image-input" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void readSheetImage(f); }} />
      <input ref={midiIn} type="file" accept=".mid,.midi,audio/midi,audio/x-midi,audio/mid" hidden data-testid="midi-file-input" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; if (isMidiFile(f)) openMidiFile(f); else say("Pick a .mid or .midi file."); }} />
      {publish && <PublishDialog song={publish} onClose={() => setPublish(null)} onPublished={() => { setPublish(null); say("Published! Your song is on Explore."); }} />}
    </div>
  );
}

function SheetBox({ id, label, title, children }: { id: string; label: string; title?: string; children: ReactNode }) {
  return <section className="ms-sheet" role="dialog" aria-label={label} data-testid={`sheet-${id}`}><div className="ms-grab" />{title && <h3>{title}</h3>}{children}</section>;
}
function Row({ icon, title, sub, testId, onClick, disabled }: { icon: string; title: string; sub?: string; testId: string; onClick: () => void; disabled?: boolean }) {
  return <button className="ms-row" data-testid={testId} disabled={disabled} onClick={onClick}><span className="ms-ic" aria-hidden>{icon}</span><span className="ms-grow">{title}{sub && <small>{sub}</small>}</span></button>;
}
function RenameForm({ name, onDone }: { name: string; onDone: (n: string | null) => void }) {
  const [v, setV] = useState(name);
  return <form className="ms-rename" onSubmit={(e) => { e.preventDefault(); onDone(v); }}>
    <input autoFocus data-testid="rename-input" value={v} maxLength={120} onChange={(e) => setV(e.target.value)} aria-label="Song name" />
    <div className="ms-acts"><button type="button" onClick={() => onDone(null)}>Cancel</button><button type="submit" className="pri" data-testid="rename-save" disabled={!v.trim()}>Save</button></div></form>;
}
function Steps({ m }: { m?: ChatItem }) {
  // Consecutive repeats of the same step ("Assigning instruments" x4) collapse into one line.
  const steps: { key: string; task: string; status: string; n: number }[] = [];
  for (const x of m?.steps ?? []) { const last = steps[steps.length - 1]; const task = plainStep(x.task);
    if (last && last.task === task) { last.n++; if (x.status !== "done") last.status = x.status; } else steps.push({ key: x.callId, task, status: x.status, n: 1 }); }
  return <ul className="ms-steplist" data-testid="composer-steps">
    {!steps.length && <li className="now">● Reading your request…</li>}
    {steps.map((x) => <li key={x.key} className={x.status === "done" ? "ok" : x.status === "running" ? "now" : x.status === "failed" ? "bad" : ""} data-status={x.status}>
      {x.status === "done" ? "✓" : x.status === "running" ? "●" : x.status === "failed" ? "!" : "○"} {x.task}{x.n > 1 ? ` (${x.n})` : ""}{x.status === "running" ? "…" : ""}</li>)}
  </ul>;
}
function Message({ m, p, live, onRetry, card }: { m: ChatItem; p: Project; live: boolean; onRetry: (t: string) => void; card: (v: SongVersion) => ReactNode }) {
  if (m.role === "user") return <div className="ms-me" data-testid="user-msg">{m.text}</div>;
  if (m.role === "error") return <div className="ms-ai"><div className="ms-err" role="alert" data-testid="studio-error">{friendlyError(m.text)} {m.retryText && <button className="ms-btn ms-small" onClick={() => onRetry(m.retryText!)}>Try again</button>}</div></div>;
  const v = versionLog.forRun(p.id, m.runId);
  return <div className="ms-ai" data-role="assistant">
    {(m.text || live) && <p data-testid="assistant-text">{m.text || "Working on it…"}</p>}
    {live && <div className="ms-steps" data-testid="composer-run" role="status"><Steps m={m} /></div>}
    {v && card(v)}
  </div>;
}

function VersionCard({ v, p, current, playing, pos, total, onPlay, onEdit, onPublish, onRestore }: { v?: SongVersion; p: Project; current: boolean; playing: boolean; pos: number; total: number; onPlay: () => void; onEdit: () => void; onPublish: () => void; onRestore?: () => void }) {
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
      <button className="pri" data-testid="version-publish" onClick={onPublish}>Publish</button>
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
