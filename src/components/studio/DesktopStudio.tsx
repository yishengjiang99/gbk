// Desktop studio (>=500px, not the iOS app): one CSS grid, no page scroll.
//   header (70px): logo/Explore, title, undo/redo, transport, clock, tempo/meter/key, mic, Import / Export / Publish / ⋯
//   A (1 col): tracks (mute/solo/volume) above the SoundFont patch browser
//   B (3 cols): piano roll with tools, snap, quantize, time + pitch zoom, track focus (ghost notes), velocity lane
//   C (full width): AI Composer (steps, log, always-visible input, Hum) + one automation lane that follows the roll view
// Everything goes through the real workstation controller, SF2 player, agent session and share/publish client.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWorkstation, workstation } from "../workstation/useWorkstation.ts";
import { useAgentSession, type ChatItem } from "../../agent/useAgentSession.ts";
import { songAutosaver } from "../../agent/autosave.ts";
import { needSignIn, takePending } from "../auth/gate.ts";
import { PianoRollEditor, ROLL_KEY_W, rollDark, type RollTool, type View } from "../workstation/PianoRollEditor.tsx";
import { AutomationLane, type LaneKind } from "../workstation/AutomationLane.tsx";
import { AgentPanel } from "../workstation/AgentPanel.tsx";
import { AddTrackButton } from "../workstation/AddTrack.tsx";
import { LiveKeyboard, liveRig } from "../workstation/LiveKeyboard.tsx";
import { FloatingWindow } from "../workstation/FloatingWindow.tsx";
import { VideoExportButton } from "../workstation/VideoExport.tsx";
import { useWebHum } from "../workstation/HumButton.tsx";
import { openMidiFile } from "../workstation/MidiImportChooser.tsx";
import { ComposerSettings } from "../composer/ComposerSettings.tsx";
import { ComposerProgress } from "../composer/ComposerProgress.tsx";
import { ComposerArtifacts } from "../composer/ComposerArtifacts.tsx";
import { STARTER_PROMPTS } from "../composer/ComposerPanel.tsx";
import { saveForPublish } from "../composer/SharePanel.tsx";
import { PublishDialog } from "../songs/PublishDialog.tsx";
import { MySongs } from "../songs/MySongs.tsx";
import { ensureGuestSession, inNativeApp, nativePublish } from "../../agent/native-guest.ts";
import { MIDI_UNSUPPORTED_MESSAGE } from "../../workstation/midi-input.ts";
import { isMidiFile } from "../../workstation/midi-import.ts";
import { bars as barList, tickToBarBeat, tickToSec } from "../../workstation/timing.ts";
import { lowerBound } from "../../workstation/visible.ts";
import { selectedTrackId } from "../../workstation/live-input.ts";
import type { Note, Project } from "../../workstation/model.ts";
import type { Proposal } from "../../workstation/controller.ts";
import type { SavedSong } from "../../agent/share-client.ts";
import { appUrl } from "../../agent/routes.ts";
import { Metronome } from "../../audio/metronome.ts";
import { sfChoice } from "../../audio/sf-choice.ts";
import { deploymentBase } from "../../audio/soundfont-loader.ts";
import { reportError } from "../../telemetry/error-reporter.ts";
import { friendlyError } from "./studio-logic.ts";
import "./desktop-studio.css";

export interface DesktopStudioProps {
  view: View; setView: (v: View | ((v: View) => View)) => void; rollWidth: () => number; onRollWidth: (px: number) => void; onManualScroll: () => void;
  focus: Proposal | null; setFocus: (id: string | null) => void; lanes: LaneKind[]; laneTrackId?: string;
  onExplore?: () => void; onOpenPlayer: () => void; newProject: () => Promise<boolean>; exportMidi: () => void; exportWav: () => Promise<void>;
  agentTools: { available: boolean; mode: string; on: boolean; setOn: (on: boolean) => void };
}
type Menu = null | "import" | "export" | "more";
type Panel = null | "songs" | "settings" | "agent";
const LANES: { k: number; label: string }[] = [{ k: 7, label: "Volume" }, { k: 10, label: "Pan" }, { k: 11, label: "Expression" }, { k: 91, label: "Reverb" }, { k: 1, label: "CC1 Mod wheel" }, { k: 64, label: "CC64 Sustain" }];
const GM_GROUPS = ["Piano", "Chromatic percussion", "Organ", "Guitar", "Bass", "Strings", "Ensemble", "Brass", "Reed", "Pipe", "Synth lead", "Synth pad", "Synth effects", "Ethnic", "Percussive", "Sound effects"];
const KEYS = ["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"].flatMap((k) => [`${k} major`]).concat(["A", "E", "B", "F#", "C#", "G#", "D#", "Bb", "F", "C", "G", "D"].map((k) => `${k} minor`));
const METERS = ["4/4", "3/4", "2/4", "6/8", "5/4", "7/8", "12/8"];
const MIN_PPT = 0.005, MAX_PPT = 2;
const pptToSlider = (ppt: number) => Math.round((Math.log(ppt / MIN_PPT) / Math.log(MAX_PPT / MIN_PPT)) * 100);
const sliderToPpt = (v: number) => MIN_PPT * Math.pow(MAX_PPT / MIN_PPT, v / 100);
const clampPpt = (x: number) => Math.max(MIN_PPT, Math.min(MAX_PPT, x));

function useMedia(q: string) {
  const [m, setM] = useState(() => typeof matchMedia === "function" && matchMedia(q).matches);
  useEffect(() => { const mq = matchMedia(q); const f = () => setM(mq.matches); f(); mq.addEventListener("change", f); return () => mq.removeEventListener("change", f); }, [q]);
  return m;
}
function useBox<T extends HTMLElement>() {
  const [box, setBox] = useState({ w: 0, h: 0 }); const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect(); ro.current = null; if (!el) return;
    const m = () => setBox((o) => (o.w === el.clientWidth && o.h === el.clientHeight ? o : { w: el.clientWidth, h: el.clientHeight }));
    ro.current = new ResizeObserver(m); ro.current.observe(el); m();
  }, []);
  return [ref, box] as const;
}
const typing = (t: EventTarget | null) => { const e = t as HTMLElement | null; return !!e && (e.tagName === "INPUT" || e.tagName === "TEXTAREA" || e.tagName === "SELECT" || e.isContentEditable); };
/** Agent tool -> composer phase (Understand -> Plan -> Compose -> Arrange -> Done). */
function phaseOf(tool: string): number {
  if (/get_|list_|capabilit|inspect|describe|read/.test(tool)) return 0;
  if (/create_project|plan|section|tempo|meter|key/.test(tool)) return 1;
  if (/generate_arrangement|notes|melody|harmon|counterpoint|bass|drum|compose|hum/.test(tool)) return 2;
  return 3; // instruments, cc curves, effects, commits, renders
}
const PHASES = ["Understand", "Plan", "Compose", "Arrange", "Done"];
const trackProgram = (p: Project, trackId: string) => p.programs.filter((e) => e.trackId === trackId).sort((a, b) => a.tick - b.tick)[0];

export function DesktopStudio(props: DesktopStudioProps) {
  const state = useWorkstation(); const p = state.project; const t = state.transport;
  const s = useAgentSession();
  const { view, setView } = props;
  const wide = useMedia("(min-width: 1280px)");
  const ro = workstation.readOnlyReason;
  const [menu, setMenu] = useState<Menu>(null); const [panel, setPanel] = useState<Panel>(null);
  const [toast, setToast] = useState<string | null>(null);
  const say = (x: string) => setToast(x);
  useEffect(() => { if (!toast) return; const h = setTimeout(() => setToast(null), 5000); return () => clearTimeout(h); }, [toast]);
  const [busy, setBusy] = useState("");
  const [keysOn, setKeysOn] = useState(false); const [, bump] = useState(0);
  const sel = selectedTrackId(p); const selTrack = p.tracks.find((x) => x.id === sel) ?? null;

  // ---- roll: tools, snap, zoom, focus ------------------------------------------------------------------------------
  const [tool, setTool] = useState<RollTool>("draw");
  const [snapDiv, setSnapDiv] = useState(4); // notes per quarter (0 = off)
  const snapTicks = snapDiv ? Math.round(p.ppq / snapDiv) : 0;
  const [focusId, setFocusId] = useState<string | null>(null);
  const focusTrack = p.tracks.find((x) => x.id === focusId) ?? null;
  useEffect(() => { if (focusId && !focusTrack) setFocusId(null); }, [focusId, focusTrack]);
  useEffect(() => { setFocusId(null); }, [p.id]);
  const [rollRef, rollBox] = useBox<HTMLDivElement>();
  const span = view.highPitch - view.lowPitch + 1;
  const fit = (notes: Note[]) => {
    if (!notes.length) return;
    let t0 = Infinity, t1 = 0, lo = 127, hi = 0;
    for (const n of notes) { t0 = Math.min(t0, n.tick); t1 = Math.max(t1, n.tick + n.duration); lo = Math.min(lo, n.pitch); hi = Math.max(hi, n.pitch); }
    lo -= 2; hi += 2; if (hi - lo + 1 < 14) { const c = Math.round((lo + hi) / 2); lo = c - 7; hi = c + 6; }
    lo = Math.max(0, lo); hi = Math.min(127, hi);
    const w = Math.max(200, props.rollWidth()); const pad = p.ppq / 2;
    props.onManualScroll();
    setView({ scrollTick: Math.max(0, t0 - pad / 2), pxPerTick: clampPpt(w / Math.max(p.ppq, t1 - t0 + pad)), lowPitch: lo, highPitch: hi });
  };
  const fitVisible = () => fit(p.notes.filter((n) => (focusId ? n.trackId === focusId : p.tracks.find((x) => x.id === n.trackId)?.visible !== false)));
  const focusOn = (id: string) => { workstation.setSelection({ trackIds: [id], noteIds: [] }); setFocusId(id); fit(p.notes.filter((n) => n.trackId === id)); };
  const showAll = () => { setFocusId(null); fit(p.notes.filter((n) => p.tracks.find((x) => x.id === n.trackId)?.visible !== false)); };
  const zoomTime = (f: number | null, slider?: number) => setView((v) => {
    const w = Math.max(100, props.rollWidth()); const mid = v.scrollTick + w / v.pxPerTick / 2; const ppt = clampPpt(slider != null ? sliderToPpt(slider) : v.pxPerTick * (f ?? 1));
    return { ...v, pxPerTick: ppt, scrollTick: Math.max(0, mid - w / ppt / 2) };
  });
  const zoomPitch = (rows: number) => setView((v) => {
    const n = Math.max(8, Math.min(128, Math.round(rows))); const c = (v.lowPitch + v.highPitch) / 2;
    let lo = Math.round(c - n / 2); lo = Math.max(0, Math.min(128 - n, lo)); return { ...v, lowPitch: lo, highPitch: lo + n - 1 };
  });
  const quantize = () => {
    if (!snapTicks) { say("Pick a snap value to quantize to."); return; }
    const ids = new Set(p.selection.noteIds); const pool = ids.size ? p.notes.filter((n) => ids.has(n.id)) : p.notes.filter((n) => n.trackId === (focusId ?? sel));
    const updates = pool.map((n) => ({ id: n.id, tick: Math.round(n.tick / snapTicks) * snapTicks })).filter((u, i) => u.tick !== pool[i].tick);
    if (!pool.length) { say("Select notes (or a track) to quantize."); return; }
    if (!updates.length) { say("Already on the grid."); return; }
    workstation.userEdit([{ op: "updateNotes", updates }], { label: "quantize" });
  };

  // ---- transport, tempo, meter, key ---------------------------------------------------------------------------------
  const pos = t.positionTick; const bb = tickToBarBeat(p, pos); const secs = tickToSec(p, pos);
  const bpm = Math.round(60e6 / (p.tempos[0]?.microPerQuarter ?? 500000));
  const setBpm = (v: number) => {
    const b = Math.max(20, Math.min(300, Math.round(v))); if (!Number.isFinite(b) || b === bpm) return;
    const rest = p.tempos.filter((x) => x.tick > 0);
    workstation.userEdit([{ op: "setTempoMap", events: [{ tick: 0, microPerQuarter: Math.round(60e6 / b) }, ...rest] }], { label: `tempo ${b}` });
  };
  const [bpmText, setBpmText] = useState(String(bpm)); useEffect(() => setBpmText(String(bpm)), [bpm]);
  const taps = useRef<number[]>([]);
  const tap = () => { const n = performance.now(); taps.current = [...taps.current.filter((x) => n - x < 2500), n]; const xs = taps.current; if (xs.length > 1) setBpm(60000 / ((n - xs[0]) / (xs.length - 1))); };
  const ts0 = p.timeSigs[0] ?? { tick: 0, numerator: 4, denominator: 4 }; const meter = `${ts0.numerator}/${ts0.denominator}`;
  const setMeter = (m: string) => { const [a, b] = m.split("/").map(Number); workstation.userEdit([{ op: "setTimeSigMap", events: [{ tick: 0, numerator: a, denominator: b }, ...p.timeSigs.filter((x) => x.tick > 0)] }], { label: `meter ${m}` }); };
  const key = p.meta?.key ?? "";
  const setKey = (k: string) => workstation.userEdit([{ op: "setMeta", key: k }], { label: `key ${k}` });
  const songEnd = Math.max(p.endTick, ...p.notes.map((n) => n.tick + n.duration), p.ppq * 4);
  const play = () => { if (t.playing) { workstation.pause(); return; } workstation.play().catch((e) => { reportError(e, { where: "desktop.play" }); say("Sound is still loading. Try Play again in a moment."); }); };
  const rig = liveRig(workstation);
  useEffect(() => rig.session.subscribe(() => bump((x) => x + 1)), [rig]);
  const armed = rig.session.snapshot().armed;
  const toggleRec = () => { const on = !armed; rig.session.setArmed(on); void rig.sink.prepare().catch(() => undefined); if (on) { setKeysOn(true); say("Recording armed: play the on-screen keys, your computer keyboard or a MIDI keyboard while the song plays."); } };
  const toggleLoop = () => { const has = p.selection.endTick > p.selection.startTick; workstation.setLoop(p.loop.enabled ? { enabled: false } : { enabled: true, startTick: has ? p.selection.startTick : 0, endTick: has ? p.selection.endTick : songEnd }); };
  const metro = useMemo(() => new Metronome(workstation), []);
  useEffect(() => { (window as { __gbkMetronome?: Metronome }).__gbkMetronome = metro; }, [metro]);
  useEffect(() => () => metro.setOn(false), [metro]);
  const [metroOn, setMetroOn] = useState(false);

  // ---- mic / hum ----------------------------------------------------------------------------------------------------
  const hum = useWebHum((m) => say(m));
  const humTap = () => { if (hum.phase === "idle") void hum.start(); else if (hum.phase === "recording") void hum.stop(); };

  // ---- SoundFont bank + patch browser ---------------------------------------------------------------------------------
  const [fonts, setFonts] = useState<{ id: string; label: string; file: string; path: string; bytes: number }[]>([]);
  const [sfCur, setSfCur] = useState(sfChoice.get()); useEffect(() => sfChoice.subscribe(setSfCur), []);
  useEffect(() => { let live = true; fetch(`${deploymentBase()}static/soundfont-manifest.json`).then((r) => (r.ok ? r.json() : [])).then((xs) => { if (live && Array.isArray(xs)) setFonts(xs.map((e) => ({ ...e, path: e.path.startsWith("/") ? e.path : `${deploymentBase()}${e.path}` }))); }).catch(() => undefined); return () => { live = false; }; }, []);
  const curFont = fonts.find((f) => sfCur && (f.path === sfCur.path || f.file === sfCur.label || f.label === sfCur.label));
  const [presets, setPresets] = useState(() => workstation.host.listPresets?.() ?? []);
  useEffect(() => { let live = true; const r = () => { if (live) setPresets(workstation.host.listPresets?.() ?? []); };
    void workstation.host.ensureSoundFont?.().then(r).catch((e) => reportError(e, { where: "desktop.ensureSoundFont" })); r(); return () => { live = false; }; }, [sfCur]);
  const [q, setQ] = useState(""); const [closed, setClosed] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const m = new Map<string, typeof presets>(); const ql = q.trim().toLowerCase();
    for (const x of [...presets].sort((a, b) => a.bank - b.bank || a.program - b.program)) {
      const g = x.bank === 128 ? "Drum kits" : x.bank === 0 ? GM_GROUPS[Math.floor(x.program / 8)] ?? "Other" : `Variations (bank ${x.bank})`;
      if (ql && !x.name.toLowerCase().includes(ql) && !g.toLowerCase().includes(ql)) continue;
      m.set(g, [...(m.get(g) ?? []), x]);
    }
    return [...m.entries()];
  }, [presets, q]);
  const presetName = (trackId: string) => { const tr = p.tracks.find((x) => x.id === trackId); const pr = trackProgram(p, trackId); const bank = tr?.channel === 9 ? 128 : pr?.bankMsb ?? 0; const prog = pr?.program ?? 0;
    return presets.find((x) => x.bank === bank && x.program === prog)?.name.trim() ?? (tr?.channel === 9 ? "Drums" : `Program ${prog + 1}`); };
  const pickPatch = (x: { bank: number; program: number; name: string }) => {
    if (!selTrack) { say("Add or select a track first."); return; }
    if (workstation.userEdit([{ op: "setProgram", trackId: selTrack.id, program: x.program, bankMsb: x.bank, bankLsb: 0 }], { label: `instrument ${x.name.trim()}` })) say(`${selTrack.name}: ${x.name.trim()}`);
  };
  const curPr = selTrack ? trackProgram(p, selTrack.id) : undefined; const curBank = selTrack?.channel === 9 ? 128 : curPr?.bankMsb ?? 0;

  // ---- agent ---------------------------------------------------------------------------------------------------------
  useEffect(() => { if (s.auth.authenticated) songAutosaver.start(); else songAutosaver.stop(); }, [s.auth.authenticated]);
  const [publish, setPublish] = useState<SavedSong | null>(null); const [shared, setShared] = useState<SavedSong | null>(null); const [songsKey, setSongsKey] = useState(0);
  const prevRun = useRef<string | null>(null);
  useEffect(() => { // a finished run on a saved private song offers Publish (never automatic)
    const was = prevRun.current; prevRun.current = s.run?.runId ?? null;
    if (!was || s.run) return;
    if (s.items[s.items.length - 1]?.role === "error") return;
    void songAutosaver.flush().then((song) => { if (song && !song.public && !workstation.readOnlyReason && workstation.project.tracks.length) setPublish(song); }).catch(() => undefined);
  }, [s.run, s.items]);
  const [text, setText] = useState(() => { const d = sessionStorage.getItem("gbk.composerDraft") ?? ""; sessionStorage.removeItem("gbk.composerDraft"); return d; });
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const f = () => { const d = sessionStorage.getItem("gbk.composerDraft"); if (d) { sessionStorage.removeItem("gbk.composerDraft"); setText(d); } input.current?.focus(); }; window.addEventListener("gbk:focus-composer", f); return () => window.removeEventListener("gbk:focus-composer", f); }, []);
  useEffect(() => { if (s.conn.state === "connected" && sessionStorage.getItem("gbk.focusComposer")) { sessionStorage.removeItem("gbk.focusComposer"); input.current?.focus(); } }, [s.conn.state]);
  useEffect(() => { if (s.conn.state !== "connected") return; const x = takePending("compose"); if (x && s.send(x.text)) { setText(""); sessionStorage.removeItem("gbk.composerDraft"); } }, [s.conn.state]);
  useEffect(() => { if (s.auth.authenticated && takePending("publish")) void doPublish(); }, [s.auth.authenticated]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = !!s.run;
  const send = (raw = text) => {
    const v = raw.trim(); if (!v) { input.current?.focus(); return; }
    if (!s.auth.authenticated) { sessionStorage.setItem("gbk.composerDraft", v); needSignIn("Sign in to compose with the AI. It's free, with a daily limit.", { kind: "compose", text: v }); return; }
    if (ro) { say("This shared song is read-only. Press Fork to change your own copy."); return; }
    if (s.conn.state !== "connected") { say("Still connecting to the composer. Try again in a moment."); s.reconnect(); return; }
    if (running) return;
    if (s.send(v)) setText(""); else say("Couldn't send that. Check your connection and try again.");
  };
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { const c = log.current; if (c) c.scrollTop = c.scrollHeight; }, [s.items, running, shared, busy]);
  useEffect(() => { const on = () => setPanel("agent"); addEventListener("gbk-approval-request", on); return () => removeEventListener("gbk-approval-request", on); }, []);
  const lastAssistant = [...s.items].reverse().find((m) => m.role === "assistant");
  const steps = (running ? lastAssistant?.steps : null) ?? [];
  const phase = running ? Math.max(0, ...steps.map((x) => phaseOf(x.tool))) : lastAssistant ? 4 : -1;
  const pending = state.proposals.filter((x) => x.status === "pending").length;

  const doPublish = async () => {
    setMenu(null);
    const native = inNativeApp();
    if (!native && !s.auth.authenticated) { needSignIn("Sign in to publish and share your song.", { kind: "publish" }); return; }
    if (workstation.readOnlyReason) { say("Fork this song first, then publish your version."); return; }
    if (!workstation.project.tracks.length) { say("Make something first, then publish it."); return; }
    setBusy("Saving your song…");
    try {
      if (native && !s.auth.authenticated) { try { await ensureGuestSession(); } catch (e) { say((e as Error).message); return; } void s.refreshAuth(); }
      const saved = await saveForPublish();
      if (native && nativePublish({ projectId: workstation.project.id, slug: saved.slug, title: saved.title || workstation.project.name, labels: [], tags: [] })) return;
      setPublish(saved);
    } catch (e) { reportError(e, { where: "desktop.publish" }); say("Couldn't save your song. Check your connection and try again."); } finally { setBusy(""); }
  };
  const exportWav = () => { setMenu(null); setBusy("Rendering WAV…"); props.exportWav().catch((e) => { reportError(e, { where: "desktop.exportWav" }); say("Couldn't render the WAV. Please try again."); }).finally(() => setBusy("")); };
  const newSong = async () => { setMenu(null); if (await props.newProject()) { if (s.auth.authenticated) s.reset(); setText(""); setFocusId(null); } };

  // ---- import ----------------------------------------------------------------------------------------------------------
  const imgIn = useRef<HTMLInputElement>(null); const midiIn = useRef<HTMLInputElement>(null);
  const readSheetImage = async (f: File) => {
    setBusy("Reading your sheet music…");
    try {
      const { isSupportedSheetMusicImageFile, parseSheetMusicToMidi } = await import("../../sheet-music-reader.ts");
      if (!isSupportedSheetMusicImageFile(f)) { say("Use a JPEG or PNG image of the sheet music."); return; }
      const r = await parseSheetMusicToMidi(f);
      openMidiFile(new File([r.midiData], `${r.fileName.replace(/\.(mid|midi)$/i, "")}.mid`, { type: "audio/midi" }));
    } catch (e) { reportError(e, { where: "desktop.scanSheet" }); say("Couldn't read notes from that image. Try a sharper, straight-on image of one page."); }
    finally { setBusy(""); }
  };
  const midiOk = rig.midi.supported; const midiReady = rig.midi.status.kind === "ready";
  const connectMidi = () => { setMenu(null); setKeysOn(true); void rig.sink.prepare().catch(() => undefined); if (!midiReady) void rig.midi.enable().then(() => bump((x) => x + 1)); };
  const bt = (window as { gbkMidiNative?: { bluetooth?: unknown; openBluetoothPairing?: () => void } }).gbkMidiNative;

  // ---- automation lane (follows the roll's view) -------------------------------------------------------------------------
  const autoLane = LANES.some((l) => l.k === props.lanes[0]) ? (props.lanes[0] as number) : 7;
  const [lane, setLane] = useState<number>(autoLane); useEffect(() => setLane(autoLane), [autoLane, p.id]);
  const [laneShow, setLaneShow] = useState(true); const [laneWrite, setLaneWrite] = useState(false);
  const laneTrack = focusTrack ?? selTrack;
  // Read is per (track, lane) in the controller: off = playback leaves this lane's CCs out of the engine stream.
  const laneRead = laneTrack ? workstation.automationRead(laneTrack.id, lane) : true;
  const setLaneRead = (on: boolean) => { if (laneTrack) workstation.setAutomationRead(laneTrack.id, lane, on); };
  // Live audition of a Write take for the mixer lanes (volume fader / pan / expression); every lane is recorded.
  const MIX_OF: Record<number, "volume" | "pan" | "expression"> = { 7: "volume", 10: "pan", 11: "expression" };
  const lanePts = useMemo(() => (laneTrack ? p.ccs.filter((c) => c.trackId === laneTrack.id && c.controller === lane).sort((a, b) => a.tick - b.tick) : []), [p.ccs, laneTrack?.id, lane]);
  const defaultVal = lane === 7 ? laneTrack?.mix.volume ?? 100 : lane === 10 ? laneTrack?.mix.pan ?? 64 : lane === 11 ? laneTrack?.mix.expression ?? 127 : 0;
  const valueAt = (tick: number) => lanePts[lowerBound(lanePts, tick + 1) - 1]?.value ?? defaultVal;
  const [laneVal, setLaneVal] = useState(defaultVal);
  const writeBuf = useRef<{ tick: number; value: number }[]>([]);
  const commitWrite = useCallback(() => {
    const b = writeBuf.current; writeBuf.current = []; const tr = laneTrack; if (!b.length || !tr) return;
    if (MIX_OF[lane]) workstation.setOverride(tr.id, null);
    workstation.userEdit([{ op: "setCC", trackId: tr.id, channel: tr.channel, controller: lane, startTick: b[0].tick, endTick: b[b.length - 1].tick, mode: b.length > 1 ? "replace" : "merge", points: b }], { label: `write CC${lane}` });
  }, [laneTrack, lane]);
  useEffect(() => { if (!t.playing) commitWrite(); }, [t.playing, commitWrite]);
  useEffect(() => { if (!laneRead || laneWrite) return; setLaneVal(valueAt(pos)); }); // eslint-disable-line react-hooks/exhaustive-deps
  const onLaneSlider = (v: number) => {
    setLaneVal(v); if (!laneWrite || !laneTrack) return;
    const st = workstation.getState().transport, tk = st.positionTick; const b = writeBuf.current;
    if (st.playing && MIX_OF[lane]) workstation.setOverride(laneTrack.id, { [MIX_OF[lane]]: v });
    if (b.length && tk <= b[b.length - 1].tick) b[b.length - 1] = { tick: b[b.length - 1].tick, value: v }; else b.push({ tick: tk, value: v });
  };
  const [laneRef, laneBox] = useBox<HTMLDivElement>();

  // ---- keyboard shortcuts + outside clicks ---------------------------------------------------------------------------------
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setMenu(null); return; }
      if (typing(e.target)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) workstation.redo(); else workstation.undo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === "Space") { e.preventDefault(); play(); return; }
      if (keysOn) return; // the Keys window owns letter keys (notes)
      const k = ({ d: "draw", v: "select", e: "erase" } as Record<string, RollTool>)[e.key.toLowerCase()]; if (k) setTool(k);
    };
    window.addEventListener("keydown", kd); return () => window.removeEventListener("keydown", kd);
  });
  useEffect(() => { if (!menu) return; const f = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest?.(".ds-menu")) setMenu(null); }; document.addEventListener("pointerdown", f); return () => document.removeEventListener("pointerdown", f); }, [menu]);

  // ---- render ----------------------------------------------------------------------------------------------------------------
  const loading = !t.audioReady && !t.playing; const from = p.meta?.sharedFrom; const forkOf = p.meta?.forkOf;
  const meterCtl = <select className="ds-sel" data-testid="ts-select" aria-label="Time signature" title="Time signature" value={meter} onChange={(e) => setMeter(e.target.value)}>{(METERS.includes(meter) ? METERS : [meter, ...METERS]).map((m) => <option key={m}>{m}</option>)}</select>;
  const keyCtl = <select className="ds-sel" data-testid="key-select" aria-label="Key" title="Key" value={key} onChange={(e) => setKey(e.target.value)}>{!key && <option value="">Key…</option>}{(KEYS.includes(key) || !key ? KEYS : [key, ...KEYS]).map((k) => <option key={k}>{k}</option>)}</select>;
  const tapCtl = <button className="ds-btn" data-testid="bpm-tap" title="Tap 2+ times to set the tempo" onClick={tap}>Tap</button>;
  return (
    <div className="ds" data-testid="workstation" data-compact="0" data-layout="grid">
      {/* ================= header ================= */}
      <header className="ds-head">
        {props.onExplore && <button className="ds-logo" data-testid="nav-explore" title="Back to Explore" onClick={props.onExplore}>← gbk</button>}
        <TitleInput name={p.name} onRename={(n) => { if (!workstation.rename(n) && workstation.readOnlyReason) say("Fork this song to rename it."); }} />
        <span className="ds-sep" />
        <div className="ds-grp">
          <button className="ds-btn ds-ic" data-testid="studio-undo" disabled={!state.canUndo} title="Undo (Ctrl/⌘+Z)" aria-label="Undo" onClick={() => workstation.undo()}>↶</button>
          <button className="ds-btn ds-ic" data-testid="studio-redo" disabled={!state.canRedo} title="Redo (Ctrl/⌘+Shift+Z)" aria-label="Redo" onClick={() => workstation.redo()}>↷</button>
        </div>
        <span className="ds-sep" />
        <div className="ds-grp" role="toolbar" aria-label="Transport">
          {loading && !t.starting ? <button className="ds-btn ds-ic" disabled aria-busy="true" data-testid="ws-play-wait" title="Play unlocks once the SoundFont has downloaded" aria-label="Loading SoundFont">{t.sf2Progress != null ? `${Math.round(t.sf2Progress * 100)}%` : "⏳"}</button>
            : t.starting && !t.playing ? <button className="ds-btn ds-ic" aria-busy="true" data-testid="ws-play-loading" aria-label="Loading sound…" onClick={play}>⏳</button>
            : <button className={`ds-btn ds-ic${t.playing ? " on" : ""}`} data-testid="ws-play" aria-label={t.playing ? "Pause" : "Play"} title={t.playing ? "Pause (Space)" : "Play (Space)"} onClick={play}>{t.playing ? "❚❚" : "▶"}</button>}
          <button className="ds-btn ds-ic" data-testid="ws-stop" aria-label="Stop" title="Stop and go back to the start" onClick={() => workstation.stop()}>■</button>
          <button className={`ds-btn ds-ic ds-rec${armed ? " on" : ""}`} data-testid="rec-toggle" aria-pressed={armed} aria-label="Record" title="Record: arm, then play the keys or a MIDI keyboard while the song plays" onClick={toggleRec}>●</button>
          <button className={`ds-btn ds-ic${p.loop.enabled ? " on" : ""}`} data-testid="loop-toggle" aria-pressed={p.loop.enabled} aria-label="Loop" title="Loop the selected range (or the whole song)" onClick={toggleLoop}>⟲</button>
          <button className={`ds-btn ds-ic${metroOn ? " on" : ""}`} data-testid="metro-toggle" aria-pressed={metroOn} aria-label="Metronome" title="Metronome click while playing" onClick={() => { metro.setOn(!metroOn); setMetroOn(metro.on); }}>𝅘𝅥</button>
        </div>
        <div className="ds-clock" data-testid="ws-pos" data-pos-tick={pos} title="Position: bar.beat · minutes:seconds">{bb.bar}.{Math.floor(bb.beat) + 1} · {Math.floor(secs / 60)}:{(secs % 60).toFixed(1).padStart(4, "0")}</div>
        <div className="ds-grp" title="Tempo (beats per minute)">
          <button className="ds-btn ds-ic" aria-label="Slower" data-testid="bpm-down" onClick={() => setBpm(bpm - 1)}>−</button>
          <input className="ds-num" data-testid="bpm-input" aria-label="Tempo in BPM" type="number" min={20} max={300} value={bpmText} onChange={(e) => setBpmText(e.target.value)} onBlur={() => setBpm(+bpmText || bpm)} onKeyDown={(e) => { if (e.key === "Enter") setBpm(+bpmText || bpm); }} />
          <button className="ds-btn ds-ic" aria-label="Faster" data-testid="bpm-up" onClick={() => setBpm(bpm + 1)}>+</button>
          <span className="ds-small ds-hide-narrow">BPM</span>
          {wide && tapCtl}
        </div>
        {wide && meterCtl}{wide && keyCtl}
        <button className={`ds-btn${hum.phase === "recording" ? " ds-rec on" : ""}`} data-testid="mic-toggle" aria-pressed={hum.phase === "recording"} disabled={hum.phase === "transcribing"} title="Microphone: sing or hum a melody, it becomes a new track" onClick={humTap}>
          🎤<span className="ds-hide-narrow"> {hum.phase === "recording" ? "Mic on" : hum.phase === "transcribing" ? `${Math.round(hum.progress * 100)}%` : "Mic off"}</span></button>
        <span className="ds-spacer" />
        <div className="ds-menu">
          <button className="ds-btn" data-testid="import-menu" aria-haspopup="menu" aria-expanded={menu === "import"} onClick={() => setMenu(menu === "import" ? null : "import")}>Import ▾</button>
          {menu === "import" && <div className="ds-pop" role="menu">
            <button role="menuitem" data-testid="import-sheet-music" onClick={() => { setMenu(null); imgIn.current?.click(); }}>📷 Sheet music image</button>
            <button role="menuitem" data-testid="import-midi-file" onClick={() => { setMenu(null); midiIn.current?.click(); }}>🎼 MIDI file (.mid)</button>
            <button role="menuitem" data-testid="midi-toggle" disabled={!midiOk} title={midiOk ? "Play and record with a MIDI keyboard (Web MIDI)" : MIDI_UNSUPPORTED_MESSAGE} onClick={connectMidi}>🎹 Connect MIDI keyboard{midiReady ? " ✓" : ""}</button>
            {!!bt?.bluetooth && typeof bt.openBluetoothPairing === "function" && <button role="menuitem" data-testid="bt-midi" onClick={() => { setMenu(null); bt.openBluetoothPairing!(); }}>ᛒ Pair a Bluetooth keyboard</button>}
            <button role="menuitem" data-testid="keys-toggle" aria-pressed={keysOn} onClick={() => { setMenu(null); setKeysOn(!keysOn); }}>⌨ On-screen keys {keysOn ? "(open)" : ""}</button>
          </div>}
        </div>
        <div className="ds-menu">
          <button className="ds-btn" data-testid="export-menu" aria-haspopup="menu" aria-expanded={menu === "export"} onClick={() => setMenu(menu === "export" ? null : "export")}>Export</button>
          {menu === "export" && <div className="ds-pop" role="menu">
            <button role="menuitem" data-testid="export-midi" disabled={!p.tracks.length} onClick={() => { setMenu(null); props.exportMidi(); }}>🎼 MIDI file</button>
            <button role="menuitem" data-testid="export-wav" disabled={!p.tracks.length} onClick={exportWav}>🔊 WAV audio</button>
            <div className="ds-pop-row">🎬 Video <VideoExportButton compact /></div>
          </div>}
        </div>
        <button className="ds-btn on" data-testid="studio-publish" title="Publish and get a share link" onClick={() => void doPublish()}>Publish</button>
        <div className="ds-menu">
          <button className="ds-btn ds-ic" data-testid="studio-overflow" aria-label="More" aria-haspopup="menu" aria-expanded={menu === "more"} onClick={() => setMenu(menu === "more" ? null : "more")}>⋯</button>
          {menu === "more" && <div className="ds-pop ds-pop-r" role="menu">
            {!wide && <div className="ds-pop-row" data-testid="more-tempo-meter">{tapCtl}{meterCtl}{keyCtl}</div>}
            <button role="menuitem" data-testid="more-songs" onClick={() => { setMenu(null); if (!s.auth.authenticated) needSignIn("Sign in to see your saved songs."); else setPanel("songs"); }}>🎵 My songs</button>
            <button role="menuitem" data-testid="new-project" onClick={() => void newSong()}>＋ New song</button>
            <button role="menuitem" data-testid="open-player" onClick={() => { setMenu(null); props.onOpenPlayer(); }}>📚 Player / Library</button>
            <button role="menuitem" data-testid="more-agent" onClick={() => { setMenu(null); setPanel("agent"); }}>🤖 Agent proposals{pending ? ` (${pending})` : ""}</button>
            <label className="ds-pop-row" data-testid="agent-mode" data-mode={props.agentTools.mode} title={props.agentTools.mode === "webmcp" ? "Expose gbk_* tools to in-browser agents via WebMCP" : "Tools are exposed in-page as window.gbkTools (shim)"}>
              <input type="checkbox" data-testid="agent-toggle" checked={props.agentTools.on} disabled={!props.agentTools.available} onChange={(e) => props.agentTools.setOn(e.target.checked)} /> Agent tools{props.agentTools.mode === "shim" ? " (in-page)" : " (WebMCP)"}</label>
            <hr />
            <button role="menuitem" data-testid="more-settings" onClick={() => { setMenu(null); setPanel("settings"); }}>⚙ Settings</button>
          </div>}
        </div>
      </header>

      {/* ================= A: tracks + instruments ================= */}
      <aside className="ds-side" aria-label="Tracks and instruments">
        <section className="ds-sec ds-tracks" data-scroll-ok>
          <div className="ds-sech">Tracks <AddTrackButton testId="add-track" /></div>
          {!p.tracks.length && <p className="ds-small">No tracks yet. Ask the composer, hum, import a file, or add a track.</p>}
          {p.tracks.map((tr) => {
            const anySolo = p.tracks.some((x) => x.mix.solo); const quiet = tr.mix.mute || (anySolo && !tr.mix.solo); const ov = state.overrides[tr.id];
            return <div key={tr.id} className={`ds-trk${sel === tr.id ? " sel" : ""}${focusId === tr.id ? " foc" : ""}`} data-testid={`track-${tr.name}`} data-focused={focusId === tr.id ? "1" : "0"}
              title="Click to focus the piano roll on this track" onClick={(e) => { if ((e.target as HTMLElement).closest("button, input")) return; focusOn(tr.id); }}>
              <span className="ds-sw" style={{ background: tr.color, opacity: quiet ? 0.3 : 1 }} />
              <div className="ds-tmeta"><button className="ds-tn" data-testid="track-focus" onClick={() => focusOn(tr.id)}>{tr.name}</button><div className="ds-small ds-ell">{presetName(tr.id)} · {p.notes.filter((n) => n.trackId === tr.id).length} notes</div></div>
              <div className="ds-ms">
                <button className={`ds-btn ds-m${tr.mix.mute ? " on" : ""}`} aria-pressed={tr.mix.mute} aria-label={`Mute ${tr.name}`} title="Mute" onClick={() => workstation.setTrackMixDefault(tr.id, { mute: !tr.mix.mute })}>M</button>
                <button className={`ds-btn ds-s${tr.mix.solo ? " on" : ""}`} aria-pressed={tr.mix.solo} aria-label={`Solo ${tr.name}`} title="Solo (only hear this)" onClick={() => workstation.setTrackMixDefault(tr.id, { solo: !tr.mix.solo })}>S</button>
              </div>
              <input type="range" className="ds-vol" min={0} max={127} aria-label={`${tr.name} volume`} title="Track volume" value={ov?.volume ?? tr.mix.volume} onChange={(e) => workstation.setTrackMixDefault(tr.id, { volume: +e.target.value })} />
            </div>;
          })}
        </section>
        <section className="ds-sec ds-patches" data-scroll-ok data-testid="patch-browser">
          <div className="ds-sech">Instruments <span className="ds-small">SoundFont (SF2)</span></div>
          <select className="ds-sel ds-full" data-testid="sf-select" aria-label="SoundFont bank" title="Which SoundFont plays the song" value={curFont?.path ?? ""}
            onChange={(e) => { const f = fonts.find((x) => x.path === e.target.value); if (f) { sfChoice.request(f.path, f.file, f.bytes); say(`Loading ${f.label}…`); } }}>
            {!curFont && <option value="">{sfCur?.label ?? "Loading SoundFont…"}</option>}
            {fonts.map((f) => <option key={f.id} value={f.path}>{f.label}{f.bytes > 50e6 ? ` (${Math.round(f.bytes / 1e6)} MB)` : ""}</option>)}
          </select>
          <input className="ds-search" data-testid="patch-search" placeholder="Search instruments…" aria-label="Search instruments" value={q} onChange={(e) => setQ(e.target.value)} />
          {!presets.length && <p className="ds-small">Loading instruments…</p>}
          {groups.map(([g, xs]) => <div key={g} className="ds-cat">
            <button className="ds-cath" aria-expanded={!closed[g] || !!q} onClick={() => setClosed({ ...closed, [g]: !closed[g] })}>{closed[g] && !q ? "▸" : "▾"} {g}</button>
            {(!closed[g] || q) && xs.map((x) => <button key={x.index} className={`ds-pt${selTrack && x.bank === curBank && x.program === (curPr?.program ?? 0) ? " cur" : ""}`} data-testid="patch" title={selTrack ? `Use ${x.name.trim()} for ${selTrack.name}` : "Select a track first"} onClick={() => pickPatch(x)}>
              <span className="ds-ell">{x.name.trim()}</span><span className="ds-small">{x.bank === 128 ? "kit" : x.program + 1}</span></button>)}
          </div>)}
        </section>
      </aside>

      {/* ================= B: piano roll ================= */}
      <main className="ds-main" aria-label="Piano roll">
        <div className="ds-tools" role="toolbar" aria-label="Piano roll tools">
          <div className="ds-grp">
            {(["draw", "select", "erase"] as RollTool[]).map((x) => <button key={x} className={`ds-btn${tool === x ? " on" : ""}`} data-testid={`tool-${x}`} aria-pressed={tool === x} title={{ draw: "Draw notes (D): click-drag sets the length", select: "Select and move notes (V)", erase: "Erase notes (E): click or drag over notes" }[x]} onClick={() => setTool(x)}>{{ draw: "✏ Draw", select: "⬚ Select", erase: "⌫ Erase" }[x]}</button>)}
          </div>
          <select className="ds-sel" data-testid="snap-select" aria-label="Snap" title="Snap notes to the grid" value={snapDiv} onChange={(e) => setSnapDiv(+e.target.value)}>
            <option value={1}>Snap 1/4</option><option value={2}>Snap 1/8</option><option value={4}>Snap 1/16</option><option value={8}>Snap 1/32</option><option value={0}>Snap off</option></select>
          <button className="ds-btn" data-testid="quantize" title="Line up the selected notes (or the focused track) to the snap grid" onClick={quantize}>Quantize</button>
          <span className="ds-sep" />
          <span className="ds-small" title="Time zoom (Ctrl/⌘ + wheel)">Time</span>
          <button className="ds-btn ds-ic" data-testid="zoom-time-out" aria-label="Zoom out (time)" onClick={() => zoomTime(1 / 1.3)}>−</button>
          <input type="range" className="ds-zoom" data-testid="zoom-time" aria-label="Time zoom" min={0} max={100} value={pptToSlider(view.pxPerTick)} onChange={(e) => zoomTime(null, +e.target.value)} />
          <button className="ds-btn ds-ic" data-testid="zoom-time-in" aria-label="Zoom in (time)" onClick={() => zoomTime(1.3)}>+</button>
          <span className="ds-small" title="Pitch zoom (Alt + wheel)">Pitch</span>
          <button className="ds-btn ds-ic" data-testid="zoom-pitch-out" aria-label="Zoom out (pitch)" onClick={() => zoomPitch(span * 1.25)}>−</button>
          <input type="range" className="ds-zoom" data-testid="zoom-pitch" aria-label="Pitch zoom" min={0} max={120} value={128 - span} onChange={(e) => zoomPitch(128 - +e.target.value)} />
          <button className="ds-btn ds-ic" data-testid="zoom-pitch-in" aria-label="Zoom in (pitch)" onClick={() => zoomPitch(span / 1.25)}>+</button>
          <button className="ds-btn" data-testid="zoom-fit" title="Zoom so every note fits" onClick={fitVisible}>⤢ Zoom to fit</button>
          <span className="ds-focus" data-testid="focus-chip" style={focusTrack ? { borderColor: focusTrack.color } : undefined}>{focusTrack ? `Focused: ${focusTrack.name}` : "All tracks"}</span>
          {focusTrack && <button className="ds-btn" data-testid="show-all" title="Back to the overview of every track" onClick={showAll}>Show all tracks</button>}
        </div>
        {(ro || forkOf) && <div className="ds-banner" role="status">
          {ro && from ? <span data-testid="readonly-banner">Viewing <b>{from.title}</b> by {from.owner} (read-only). <button className="ds-btn" data-testid="fork-btn" onClick={() => workstation.fork()}>Fork</button></span>
            : ro ? <span data-testid="readonly-banner">{ro} <button className="ds-btn" data-testid="fork-btn" onClick={() => workstation.fork()}>Fork</button></span>
            : <span className="ds-small" data-testid="forked-from">forked from <a href={appUrl(`s/${forkOf}`)}>{forkOf}</a> · your fork is private until you publish it</span>}
        </div>}
        <Ruler project={p} view={view} snapTicks={snapTicks} />
        <div className="ds-roll" ref={rollRef}>
          {!p.tracks.length && <div className="ds-empty" data-testid="roll-empty"><span className="ds-small">No tracks yet.</span><AddTrackButton cta testId="roll-add-track" /></div>}
          {rollBox.h > 0 && <PianoRollEditor project={p} proposal={props.focus} view={view} setView={setView} height={Math.max(60, rollBox.h)} onManualScroll={props.onManualScroll} onWidth={props.onRollWidth}
            tool={tool} snapTicks={snapTicks} focusTrackId={focusId} themeAuto onNoteDoubleClick={(n) => focusOn(n.trackId)} />}
        </div>
        <VelocityLane project={p} view={view} trackId={focusId ?? sel} />
      </main>

      {/* ================= C: agent + automation ================= */}
      <footer className="ds-foot">
        <section className="ds-agent" aria-label="AI Composer">
          <div className="ds-steps" data-testid="composer-phases">
            {PHASES.map((x, i) => <span key={x} className={i < phase || (phase === 4 && i === 4) ? "done" : i === phase && running ? "act" : ""}>{x}</span>)}
            <span className="ds-spacer" />
            <span className={`ds-conn ${s.auth.authenticated ? s.conn.state : "guest"}`} data-testid="composer-conn" data-state={s.auth.authenticated ? s.conn.state : "signed-out"}>{s.auth.authenticated ? ({ idle: "Offline", connecting: "Connecting…", connected: "Connected", reconnecting: "Reconnecting…", offline: "Disconnected", unauthorized: "Signed out" } as Record<string, string>)[s.conn.state] ?? s.conn.state : "Guest"} ●</span>
          </div>
          <div className="ds-log" ref={log} data-testid="composer-log" data-scroll-ok aria-live="polite">
            {!s.items.length && <div className="ds-small">Ask the composer anything, e.g. “add a walking bass under the piano”.</div>}
            {!s.items.length && s.auth.authenticated && <div className="ds-starters" data-testid="starter-prompts">{STARTER_PROMPTS.map((x) => <button key={x.label} className="ds-btn" disabled={running || s.conn.state !== "connected"} title={x.text} onClick={() => send(x.text)}>{x.label}</button>)}</div>}
            {s.items.map((m) => <LogItem key={m.id} m={m} onRetry={(x) => send(x)} />)}
            {s.run && <div className="ds-run" data-testid="composer-run" role="status">● {s.run.task}{s.run.maxSteps ? ` · step ${s.run.step}/${s.run.maxSteps}` : ""}</div>}
            {s.auth.authenticated && s.conn.state !== "connected" && s.conn.state !== "connecting" && s.conn.state !== "idle" && <div className="ds-err">{s.conn.state === "reconnecting" ? "Reconnecting to the composer…" : "The composer is offline right now."} {s.conn.state !== "reconnecting" && <button className="ds-btn" onClick={s.reconnect}>Try again</button>}</div>}
            {shared && <div data-testid="share-link">Published: <a href={shared.url} target="_blank" rel="noreferrer">{shared.url}</a> <button className="ds-btn" onClick={() => void navigator.clipboard?.writeText(shared.url ?? "")}>Copy</button></div>}
            {busy && <div className="ds-run" role="status" data-testid="studio-busy">{busy}</div>}
            {hum.phase !== "idle" && <div className="ds-run" role="status" data-testid="hum-strip">{hum.phase === "recording" ? `● Listening… ${Math.floor(hum.elapsed)}s, press Stop humming when done` : `Turning your melody into notes${hum.progress > 0 ? ` ${Math.round(hum.progress * 100)}%` : "…"}`}</div>}
          </div>
          {toast && <div className="ds-toast" role="status" data-testid="studio-toast">{toast}</div>}
          <form className="ds-ain" data-testid="composer-bar" data-state={s.auth.authenticated ? s.conn.state : "signed-out"} onSubmit={(e) => { e.preventDefault(); send(); }}>
            <button type="button" className={`ds-btn${hum.phase === "recording" ? " ds-rec on" : ""}`} data-testid="hum-btn" data-phase={hum.phase} disabled={hum.phase === "transcribing"} title="Hum a melody and turn it into notes" onClick={humTap}>{hum.phase === "recording" ? "■ Stop humming" : "🎙 Hum"}</button>
            {hum.phase === "recording" && <button type="button" className="ds-btn" data-testid="hum-cancel" aria-label="Cancel humming" onClick={() => hum.cancel()}>✕</button>}
            <textarea ref={input} data-testid="composer-input" rows={1} maxLength={12000} value={text} aria-label="Tell the composer what to write or change"
              placeholder={running ? "Composing…" : ro ? "Fork this song to edit it with the AI…" : p.tracks.length ? "Tell the composer what to write or change…" : "Describe a song…"}
              onChange={(e) => { setText(e.target.value); if (!s.auth.authenticated) sessionStorage.setItem("gbk.composerDraft", e.target.value); }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
            {running ? <button type="button" className="ds-btn ds-rec on" data-testid="composer-stop" onClick={s.stop}>■ Stop</button>
              : <button type="submit" className="ds-btn on" data-testid="composer-send" disabled={s.auth.authenticated && (!text.trim() || s.conn.state !== "connected")}>Send ➤</button>}
          </form>
        </section>
        <section className="ds-auto" aria-label="Automation">
          <div className="ds-autobar">
            <b>Automation</b>
            <select className="ds-sel" data-testid="lane-select" aria-label="Automation lane" title="Which control this lane changes" value={lane} onChange={(e) => setLane(+e.target.value)}>{LANES.map((l) => <option key={l.k} value={l.k}>{l.label}</option>)}</select>
            <button className={`ds-btn${laneShow ? " on" : ""}`} data-testid="lane-show" aria-pressed={laneShow} title="Show this lane" onClick={() => setLaneShow(!laneShow)}>Show</button>
            <button className={`ds-btn${laneRead ? " on" : ""}`} data-testid="lane-read" aria-pressed={laneRead} title="The slider follows the lane at the playhead" onClick={() => setLaneRead(!laneRead)}>Read</button>
            <button className={`ds-btn${laneWrite ? " on" : ""}`} data-testid="lane-write" aria-pressed={laneWrite} title="Slider moves are written into the lane at the playhead (while playing: one take)" onClick={() => { if (laneWrite) commitWrite(); setLaneWrite(!laneWrite); }}>Write</button>
            <span className="ds-small">Value</span>
            <input type="range" className="ds-zoom" data-testid="lane-value" aria-label="Value at the playhead" min={0} max={127} value={laneVal} disabled={!laneTrack}
              title={laneWrite ? "Writes into the lane at the playhead" : "Turn on Write to record moves into the lane"}
              onChange={(e) => onLaneSlider(+e.target.value)} onPointerUp={() => { if (!workstation.getState().transport.playing) commitWrite(); }} onKeyUp={() => { if (!workstation.getState().transport.playing) commitWrite(); }} />
            <span className="ds-small ds-num-out">{laneVal}</span>
            <span className="ds-small ds-ell">{laneTrack ? laneTrack.name : ""}</span>
          </div>
          <div className="ds-lane" ref={laneRef}>
            {!laneTrack ? <div className="ds-small ds-pad">Select a track to draw its automation.</div>
              : !laneShow ? <div className="ds-small ds-pad">Lane hidden. Press Show.</div>
              : laneBox.h > 10 && <AutomationLane bare project={p} proposal={props.focus} view={view} trackId={laneTrack.id} lane={lane as LaneKind} height={laneBox.h} onChangeLane={(l) => typeof l === "number" && setLane(l)} onRemove={() => setLaneShow(false)} />}
          </div>
        </section>
      </footer>

      {/* ================= floating windows, panels, dialogs ================= */}
      {keysOn && <FloatingWindow title="🎹 Keys" storageKey="gbk.keysWindowPos" testId="keys-window" onClose={() => setKeysOn(false)}>{() => <LiveKeyboard workstation={workstation} />}</FloatingWindow>}
      <SidePanel open={panel === "songs"} title="My songs" testId="panel-songs" onClose={() => setPanel(null)}>
        {s.auth.authenticated && <details data-testid="my-songs-studio" open><summary>My songs</summary><MySongs compact refreshKey={songsKey} /></details>}
      </SidePanel>
      <SidePanel open={panel === "settings"} title="Settings" testId="panel-settings" onClose={() => setPanel(null)}>
        {s.auth.authenticated
          ? <ComposerSettings open info={s.info} model={s.model} setModel={s.setModel} usage={s.usage} user={s.auth.name ?? s.auth.user} onLogout={() => void s.logout()} onReset={s.reset} />
          : <p className="ds-small" data-testid="settings-guest">You're browsing as a guest. You'll be asked to sign in when you compose or publish.</p>}
        <p className="ds-small">Theme follows your device (light or dark).</p>
      </SidePanel>
      {/* Always mounted so an agent commit can always ask for approval; a request opens the panel. */}
      <SidePanel open={panel === "agent"} title={`Agent proposals${pending ? ` (${pending})` : ""}`} testId="panel-agent" onClose={() => setPanel(null)}>
        <AgentPanel state={state} focusProposal={props.focus} setFocus={props.setFocus} />
      </SidePanel>
      <input ref={imgIn} type="file" accept="image/jpeg,image/png" hidden data-testid="sheet-image-input" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void readSheetImage(f); }} />
      <input ref={midiIn} type="file" accept=".mid,.midi,audio/midi,audio/x-midi,audio/mid" hidden data-testid="midi-file-input" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; if (isMidiFile(f)) openMidiFile(f); else say("Pick a .mid or .midi file."); }} />
      {publish && <PublishDialog song={publish} onClose={() => { setPublish(null); setSongsKey((x) => x + 1); }} onPublished={(x) => { setPublish(null); setShared(x); setSongsKey((k) => k + 1); say("Published! Your song is on Explore."); }} />}
    </div>
  );
}

function TitleInput({ name, onRename }: { name: string; onRename: (n: string) => void }) {
  const [v, setV] = useState(name); const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setV(name); }, [name, editing]);
  const done = () => { setEditing(false); const n = v.trim(); if (n && n !== name) onRename(n); else setV(name); };
  return <input className="ds-title" data-testid="studio-title" aria-label="Song title (click to rename)" title="Click to rename this song" maxLength={120} value={v}
    onFocus={() => setEditing(true)} onChange={(e) => setV(e.target.value)} onBlur={done}
    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setV(name); setEditing(false); requestAnimationFrame(() => (e.target as HTMLInputElement).blur()); } }} />;
}

function SidePanel({ open, title, testId, onClose, children }: { open: boolean; title: string; testId: string; onClose: () => void; children: ReactNode }) {
  return <section className="ds-panel" role="dialog" aria-label={title} data-testid={testId} hidden={!open || undefined} data-scroll-ok>
    <div className="ds-sech">{title}<button className="ds-btn ds-ic" aria-label="Close" data-testid={`${testId}-close`} onClick={onClose}>✕</button></div>
    {children}
  </section>;
}

function LogItem({ m, onRetry }: { m: ChatItem; onRetry: (t: string) => void }) {
  if (m.role === "user") return <div className="ds-u" data-testid="user-msg">You: {m.text}</div>;
  if (m.role === "error") return <div className="ds-err" role="alert" data-testid="studio-error">{friendlyError(m.text)} {m.retryText && <button className="ds-btn" onClick={() => onRetry(m.retryText!)}>Try again</button>}</div>;
  return <div className="ds-a" data-role="assistant">
    <ComposerProgress steps={m.steps ?? []} />
    {m.text && <div data-testid="assistant-text">Composer: {m.text}</div>}
    <ComposerArtifacts artifacts={m.artifacts ?? []} />
  </div>;
}

/** Bar ruler on the roll's time axis (same zoom + scroll). Click or drag to move the playhead (snaps to the grid;
 * Shift = free). Works while playing: the player seeks there. */
function Ruler({ project, view, snapTicks }: { project: Project; view: View; snapTicks: number }) {
  const cv = useRef<HTMLCanvasElement>(null); const [ref, box] = useBox<HTMLDivElement>(); const drag = useRef(false);
  const W = box.w, H = box.h;
  const x = (tick: number) => ROLL_KEY_W + (tick - view.scrollTick) * view.pxPerTick;
  const endTick = view.scrollTick + Math.max(0, W - ROLL_KEY_W) / view.pxPerTick;
  const barsMemo = useMemo(() => barList(project, Math.max(project.endTick, endTick) + project.ppq * 4), [project.timeSigs, project.ppq, project.endTick, endTick]);
  useEffect(() => {
    const c = cv.current; if (!c || !W || !H) return; const dpr = devicePixelRatio || 1; c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext("2d")!; let raf = 0;
    const draw = () => {
      g.setTransform(dpr, 0, 0, dpr, 0, 0); const dk = rollDark(true);
      g.fillStyle = dk ? "#1a1d25" : "#f4f5f7"; g.fillRect(0, 0, W, H);
      const lp = project.loop; if (lp.enabled && lp.endTick > lp.startTick) { g.fillStyle = "rgba(91,91,246,0.22)"; g.fillRect(x(lp.startTick), 0, (lp.endTick - lp.startTick) * view.pxPerTick, H); }
      g.font = "10px system-ui, sans-serif"; g.textBaseline = "middle";
      const minLabelPx = 28; let lastLabel = -1e9;
      for (const b of barsMemo) {
        if (b.tick > endTick) break; const bx = x(b.tick); if (bx < ROLL_KEY_W - 1) continue;
        g.fillStyle = dk ? "#3a3f4b" : "#c9ccd3"; g.fillRect(bx, H * 0.35, 1, H * 0.65);
        if (b.ticksPerBeat * view.pxPerTick > 8) for (let k = 1; k * b.ticksPerBeat < b.length; k++) g.fillRect(x(b.tick + k * b.ticksPerBeat), H * 0.7, 1, H * 0.3);
        if (bx - lastLabel >= minLabelPx) { g.fillStyle = dk ? "#aab0bd" : "#5a5f6b"; g.fillText(String(b.index), bx + 3, H * 0.4); lastLabel = bx; }
      }
      g.fillStyle = dk ? "#12151c" : "#e6e8ec"; g.fillRect(0, 0, ROLL_KEY_W, H);
      const pos = workstation.getState().transport.positionTick, px = x(pos);
      if (px >= ROLL_KEY_W - 1 && px <= W) { g.fillStyle = "#ff4081"; g.beginPath(); g.moveTo(px - 5, 0); g.lineTo(px + 5, 0); g.lineTo(px, 7); g.fill(); g.fillRect(px, 0, 2, H); }
    };
    const loop = () => { draw(); raf = workstation.getState().transport.playing ? requestAnimationFrame(loop) : 0; };
    loop();
    const unsub = workstation.subscribe((st) => { if (st.transport.playing) { if (!raf) raf = requestAnimationFrame(loop); } else { cancelAnimationFrame(raf); raf = 0; draw(); } });
    return () => { cancelAnimationFrame(raf); unsub(); };
  }, [project, view, W, H, barsMemo]); // eslint-disable-line react-hooks/exhaustive-deps
  const seekAt = (e: React.PointerEvent) => {
    const r = cv.current!.getBoundingClientRect(); const px = Math.max(ROLL_KEY_W, e.clientX - r.left);
    let tk = view.scrollTick + (px - ROLL_KEY_W) / view.pxPerTick; if (snapTicks > 0 && !e.shiftKey) tk = Math.round(tk / snapTicks) * snapTicks;
    workstation.seek(Math.max(0, Math.round(tk)));
  };
  return <div className="ds-ruler" ref={ref} data-testid="roll-ruler" title="Click or drag to move the playhead (Shift: no snap)">
    <canvas ref={cv} style={{ width: "100%", height: "100%", display: "block", touchAction: "none", cursor: "col-resize" }} aria-label="Timeline ruler: click or drag to seek"
      onPointerDown={(e) => { if (e.button !== 0) return; (e.target as Element).setPointerCapture(e.pointerId); drag.current = true; seekAt(e); }}
      onPointerMove={(e) => { if (drag.current) seekAt(e); }}
      onPointerUp={() => { drag.current = false; }} onPointerCancel={() => { drag.current = false; }} />
  </div>;
}

/** Velocity stems for the focused/selected track, on the roll's time axis. Drag up/down (or across) to set velocities. */
function VelocityLane({ project, view, trackId }: { project: Project; view: View; trackId: string | null }) {
  const cv = useRef<HTMLCanvasElement>(null); const [ref, box] = useBox<HTMLDivElement>();
  const [edit, setEdit] = useState<Map<string, number> | null>(null);
  const track = project.tracks.find((x) => x.id === trackId);
  const notes = useMemo(() => project.notes.filter((n) => n.trackId === trackId), [project.notes, trackId]);
  const x = (tick: number) => ROLL_KEY_W + (tick - view.scrollTick) * view.pxPerTick;
  const H = box.h, W = box.w;
  useEffect(() => {
    const c = cv.current; if (!c || !W || !H) return; const dpr = devicePixelRatio || 1; c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext("2d")!; g.setTransform(dpr, 0, 0, dpr, 0, 0); const dk = rollDark(true);
    g.fillStyle = dk ? "#12151c" : "#fbfbfd"; g.fillRect(0, 0, W, H); g.fillStyle = dk ? "#1a1d25" : "#f4f5f7"; g.fillRect(0, 0, ROLL_KEY_W, H);
    g.fillStyle = track?.color ?? "#5b5bf6";
    for (const n of notes) { const px = x(n.tick); if (px < ROLL_KEY_W - 2 || px > W) continue; const v = edit?.get(n.id) ?? n.velocity; const h = (v / 127) * (H - 10);
      g.fillRect(px, H - h, 2, h); g.beginPath(); g.arc(px + 1, H - h, 2.5, 0, 7); g.fill(); }
  }, [notes, view, W, H, edit, track?.color]);
  const at = (e: React.PointerEvent) => { const r = cv.current!.getBoundingClientRect(); return { px: e.clientX - r.left, v: Math.max(1, Math.min(127, Math.round(((H - (e.clientY - r.top)) / Math.max(1, H - 10)) * 127))) }; };
  const apply = (e: React.PointerEvent, m: Map<string, number>) => { const { px, v } = at(e); for (const n of notes) if (Math.abs(x(n.tick) - px) <= 4) m.set(n.id, v); setEdit(new Map(m)); };
  return <div className="ds-vel" ref={ref} data-testid="velocity-lane">
    <span className="ds-small ds-vlabel">Velocity</span>
    <canvas ref={cv} style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }} aria-label="Velocity lane: drag the stems to change note velocity"
      onPointerDown={(e) => { if (!track) return; (e.target as Element).setPointerCapture(e.pointerId); apply(e, new Map()); }}
      onPointerMove={(e) => { if (edit) apply(e, edit); }}
      onPointerUp={() => { const m = edit; setEdit(null); if (m?.size) workstation.userEdit([{ op: "updateNotes", updates: [...m].map(([id, velocity]) => ({ id, velocity })) }], { label: "velocity" }); }} />
  </div>;
}
