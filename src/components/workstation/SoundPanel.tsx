// Sound / Voice panel: effective SF2 voice of the selected track (envelope graph, filter, LFOs, sends) and the
// global effects. Manual edits go through the same controller ops (setVoicePatch / setEffects) as the agent tools,
// so they are undoable and persisted; a focused sound proposal is drawn as a dashed "B" overlay with a diff list.
import { useEffect, useState } from "react";
import type { Project } from "../../workstation/model.ts";
import type { Proposal } from "../../workstation/controller.ts";
import { workstation } from "./useWorkstation.ts";
import { voiceReport, humanEditToOverride } from "../../workstation/sound.ts";
import { EFFECTS_RANGES, type EffectsParams } from "../../sf2/voice-overrides.ts";
import { reportError } from "../../telemetry/error-reporter.ts";

type Report = ReturnType<typeof voiceReport>;
type Gens = Report["zones"][number]["generators"];

const SLIDERS: { param: string; label: string; min: number; max: number; step: number; log?: boolean; unit: string }[] = [
  { param: "volEnvAttack", label: "Attack", min: 0.001, max: 10, step: 0.001, log: true, unit: "s" },
  { param: "volEnvHold", label: "Hold", min: 0.001, max: 5, step: 0.001, log: true, unit: "s" },
  { param: "volEnvDecay", label: "Decay", min: 0.001, max: 20, step: 0.001, log: true, unit: "s" },
  { param: "volEnvSustain", label: "Sustain atten.", min: 0, max: 96, step: 0.5, unit: "dB" },
  { param: "volEnvRelease", label: "Release", min: 0.001, max: 20, step: 0.001, log: true, unit: "s" },
  { param: "filterCutoff", label: "Cutoff", min: 20, max: 19900, step: 1, log: true, unit: "Hz" },
  { param: "filterQ", label: "Resonance", min: 0, max: 96, step: 0.5, unit: "dB" },
  { param: "modEnvToFilterFc", label: "ModEnv→cutoff", min: -12000, max: 12000, step: 50, unit: "ct" },
  { param: "vibLfoFreq", label: "Vibrato rate", min: 0.1, max: 20, step: 0.01, log: true, unit: "Hz" },
  { param: "vibLfoToPitch", label: "Vibrato depth", min: 0, max: 200, step: 1, unit: "ct" },
  { param: "modLfoFreq", label: "Mod LFO rate", min: 0.1, max: 20, step: 0.01, log: true, unit: "Hz" },
  { param: "modLfoToVolume", label: "Tremolo", min: 0, max: 24, step: 0.1, unit: "dB" },
  { param: "reverbSend", label: "Reverb send", min: 0, max: 100, step: 0.5, unit: "%" },
  { param: "chorusSend", label: "Chorus send", min: 0, max: 100, step: 0.5, unit: "%" },
];
const FX: { k: keyof typeof EFFECTS_RANGES; label: string }[] = [
  { k: "roomSize", label: "Room size" }, { k: "damping", label: "Damping" }, { k: "reverbLevel", label: "Reverb level" },
  { k: "chorusLevel", label: "Chorus level" }, { k: "chorusDepthMs", label: "Chorus depth ms" }, { k: "chorusRateHz", label: "Chorus rate Hz" }, { k: "chorusDelayMs", label: "Chorus delay ms" },
];

function report(p: Project, trackId: string): Report {
  return voiceReport(p, trackId, workstation.host.trackRegions?.(p, trackId) ?? null, 60, 100);
}
const toPos = (s: (typeof SLIDERS)[number], v: number) => (s.log ? Math.log(Math.max(s.min, v) / s.min) / Math.log(s.max / s.min) : (v - s.min) / (s.max - s.min));
const fromPos = (s: (typeof SLIDERS)[number], x: number) => (s.log ? s.min * Math.pow(s.max / s.min, x) : s.min + x * (s.max - s.min));
const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));

/** ADSR polyline (time axis log-compressed so 1 ms .. 20 s all fit). */
function envPath(g: Gens, w: number, h: number): string {
  const tx = (s: number) => Math.log10(1 + s * 20) * 40;
  const d = g.volEnvDelay.value < 0.002 ? 0 : g.volEnvDelay.value, a = g.volEnvAttack.value, ho = g.volEnvHold.value < 0.002 ? 0 : g.volEnvHold.value;
  const susLin = Math.max(0, 1 - g.volEnvSustain.value / 96);
  const dec = g.volEnvDecay.value * (g.volEnvSustain.value / 100), rel = g.volEnvRelease.value;
  const pts: [number, number][] = [[0, 0]]; let t = 0;
  t += d; pts.push([tx(t), 0]); t += a; pts.push([tx(t), 1]); t += ho; pts.push([tx(t), 1]); t += dec; pts.push([tx(t), susLin]);
  const sx = tx(t) + 30; pts.push([sx, susLin]); pts.push([sx + tx(rel), 0]);
  const maxX = Math.max(...pts.map((q) => q[0]), 1);
  return pts.map(([x, y], i) => `${i ? "L" : "M"}${((x / maxX) * (w - 4) + 2).toFixed(1)},${(h - 2 - y * (h - 4)).toFixed(1)}`).join(" ");
}

export function SoundPanel({ project, trackId, proposal }: { project: Project; trackId: string | undefined; proposal: Proposal | null }) {
  const [drag, setDrag] = useState<Record<string, number>>({});
  // Same SoundFont + mapping as the renderer: load it on demand, then re-render with real zones.
  const [, setSfReady] = useState(0);
  useEffect(() => { let live = true; void workstation.host.ensureSoundFont?.().then(() => { if (live) setSfReady((x) => x + 1); }).catch((e) => reportError(e, { where: "ensureSoundFont" })); return () => { live = false; }; }, []);
  const soundProposal = proposal && proposal.ops.some((o) => (o.op === "setVoicePatch" && o.trackId === trackId) || o.op === "setEffects") ? proposal : null;
  const rep = trackId ? report(project, trackId) : null; // zones may arrive after the player loads: no memo
  const repB = trackId && soundProposal ? report(soundProposal.candidate, trackId) : null;
  if (!trackId || !rep) return <section className="ws-sound" data-testid="sound-panel"><h4>Sound</h4><p className="ws-dim">Select a track.</p></section>;
  const g = rep.zones[0]?.generators, gB = repB?.zones[0]?.generators;
  const fx = rep.effects, fxB = repB?.effects;
  const commitVoice = (param: string, value: number) => {
    try { workstation.userEdit([{ op: "setVoicePatch", trackId, overrides: [humanEditToOverride({ param, mode: "set", value })], mode: "merge" }], { label: `sound: ${param}` }); }
    catch (e) { alert((e as Error).message); }
    setDrag((d) => { const n = { ...d }; delete n[param]; return n; });
  };
  const commitFx = (k: keyof EffectsParams, value: number | boolean) => {
    try { workstation.userEdit([{ op: "setEffects", params: { [k]: value } }], { label: `effects: ${k}` }); } catch (e) { alert((e as Error).message); }
    setDrag((d) => { const n = { ...d }; delete n[`fx.${k}`]; return n; });
  };
  const diffs = g && gB ? Object.entries(gB).filter(([k, v]) => v.native !== g[k as keyof Gens].native).map(([k, v]) => `${k}: ${fmt(g[k as keyof Gens].value)} → ${fmt(v.value)} ${v.unit}`) : [];
  const fxDiffs = fxB ? (Object.keys(fxB) as (keyof EffectsParams)[]).filter((k) => fxB[k] !== fx[k]).map((k) => `${k}: ${fx[k]} → ${fxB[k]}`) : [];
  return (
    <section className="ws-sound" data-testid="sound-panel" aria-label="Sound and voice settings">
      <h4>Sound · {rep.preset?.name ?? "(zones unavailable)"} <span className="ws-dim">key 60</span></h4>
      {g ? (
        <svg width="100%" viewBox="0 0 260 70" className="ws-adsr" data-testid="adsr-graph" role="img" aria-label="Volume envelope">
          <path d={envPath(g, 260, 70)} fill="none" stroke="#7cb7ff" strokeWidth="2" />
          {gB && <path d={envPath(gB, 260, 70)} fill="none" stroke="#7cffb2" strokeWidth="2" strokeDasharray="4 3" data-testid="adsr-graph-b" />}
        </svg>
      ) : <p className="ws-dim">Load a SoundFont and play once to inspect zones; overrides still apply.</p>}
      {(diffs.length > 0 || fxDiffs.length > 0) && (
        <div className="ws-sound-diff" data-testid="sound-diff"><b>Proposal B</b>{[...diffs, ...fxDiffs].map((d) => <div key={d}>{d}</div>)}</div>
      )}
      {g && SLIDERS.map((s) => {
        const e = g[s.param as keyof Gens]; const cur = drag[s.param] ?? e.value;
        return (
          <label key={s.param} className={`ws-knob ws-sound-row ${e.overridden ? "ovr" : ""}`} title={e.overridden ? `overridden (zone ${fmt(e.zone)})` : "SoundFont value"}>
            <span>{s.label}</span>
            <input type="range" min={0} max={1000} value={Math.round(toPos(s, cur) * 1000)} data-testid={`sound-${s.param}`} aria-label={s.label}
              onChange={(ev) => setDrag((d) => ({ ...d, [s.param]: fromPos(s, +ev.target.value / 1000) }))}
              onPointerUp={() => drag[s.param] !== undefined && commitVoice(s.param, drag[s.param])}
              onKeyUp={() => drag[s.param] !== undefined && commitVoice(s.param, drag[s.param])} />
            <span className="ws-dim">{fmt(cur)} {s.unit}</span>
          </label>
        );
      })}
      {rep.zones[0] && <div className="ws-dim" data-testid="effective-sends">send: reverb {rep.zones[0].effectiveSends.reverb.effectivePercent}% · chorus {rep.zones[0].effectiveSends.chorus.effectivePercent}% (zone + CC91/93 + override)</div>}
      {rep.overrides.length > 0 && <button onClick={() => workstation.userEdit([{ op: "setVoicePatch", trackId, overrides: [], mode: "replace" }], { label: "sound: reset track" })}>Reset to SoundFont</button>}
      <h4>Effects <label className="ws-dim"><input type="checkbox" checked={fx.enabled} data-testid="fx-enabled" onChange={(e) => commitFx("enabled", e.target.checked)} /> on</label></h4>
      {FX.map(({ k, label }) => {
        const [lo, hi] = EFFECTS_RANGES[k]; const cur = drag[`fx.${k}`] ?? (fx[k] as number);
        return (
          <label key={k} className="ws-knob ws-sound-row"><span>{label}</span>
            <input type="range" min={lo} max={hi} step={(hi - lo) / 200} value={cur} aria-label={label} data-testid={`fx-${k}`}
              onChange={(ev) => setDrag((d) => ({ ...d, [`fx.${k}`]: +ev.target.value }))}
              onPointerUp={() => drag[`fx.${k}`] !== undefined && commitFx(k, drag[`fx.${k}`])}
              onKeyUp={() => drag[`fx.${k}`] !== undefined && commitFx(k, drag[`fx.${k}`])} />
            <span className="ws-dim">{fmt(cur)}</span>
          </label>
        );
      })}
    </section>
  );
}
