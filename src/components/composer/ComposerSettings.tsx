import { useRef, useState } from "react";
import type { UsageInfo } from "../../agent/protocol.ts";
import { exportLocalData, importLocalData } from "../../agent/migration.ts";
import { MIDI_ACCEPT, isMidiFile } from "../../workstation/midi-import.ts";
import { openMidiFile } from "../workstation/MidiImportChooser.tsx";

export function ComposerSettings({ info, model, setModel, usage, user, pro, onLogout, onReset, open }: { info: { model: string; models: string[]; provider: string; llmConfigured: boolean } | null; model: string; setModel: (m: string) => void; usage: UsageInfo | null; user?: string; pro?: boolean; onLogout: () => void; onReset: () => void; open?: boolean }) {
  const [msg, setMsg] = useState(""); const file = useRef<HTMLInputElement>(null);
  const doExport = async () => { const b = await exportLocalData(true); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `gbk-export-${location.host}-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setMsg(`exported ${(b.size / 1048576).toFixed(1)} MB`); };
  const doImport = async (f: File) => { if (isMidiFile(f)) { openMidiFile(f); return; } try { const r = await importLocalData(f); setMsg(`imported ${r.projects} projects, ${r.artifacts} artifacts${r.skipped ? `, skipped ${r.skipped}` : ""}`); } catch (e) { setMsg((e as Error).message); } };
  return (
    <details className="cmp-settings" data-testid="composer-settings" open={open}>
      <summary>Settings{pro && <span className="cmp-pro" data-testid="settings-pro">Pro</span>}{info ? ` · ${info.provider} · ${model}` : ""}{usage ? ` · today ${usage.dayTokens.toLocaleString()} tok / $${usage.dayCostUsd.toFixed(3)}` : ""}</summary>
      {info && <label>Model <select value={model} onChange={(e) => setModel(e.target.value)} data-testid="composer-model">{info.models.map((m) => <option key={m}>{m}</option>)}</select></label>}
      {info && !info.llmConfigured && <div className="cmp-error">LLM not configured on the server (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL).</div>}
      {usage && <div className="ws-dim">last call {usage.promptTokens}+{usage.completionTokens} tokens (~${usage.costUsd.toFixed(4)})</div>}
      <div className="ws-row"><button onClick={onReset}>New conversation</button>{user && <button onClick={onLogout}>Log out {user}</button>}</div>
      {user && <ProStatus pro={!!pro} />}
      <div className="ws-dim">Projects and renders live in this browser for this site only. Moving from another GBK address? Export there, import here (nothing moves automatically).</div>
      <div className="ws-row"><button onClick={() => void doExport()}>Export local data</button><button onClick={() => file.current?.click()} data-testid="import-file" title="GBK export (.json) or a MIDI file (.mid)">Import JSON / MIDI…</button>
        <input ref={file} type="file" accept={MIDI_ACCEPT} hidden data-testid="import-input" onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); e.target.value = ""; }} /></div>
      {msg && <div className="ws-dim">{msg}</div>}
    </details>
  );
}

/** Billing has no self-serve portal route on this site yet, so "manage" goes to /plans (plan details, how to cancel). */
export const PRO_MANAGE_HREF = "/plans";

/** Pro users see "Pro · manage" (and never the paywall, see PaywallHost); free users see nothing extra here. */
export function ProStatus({ pro }: { pro: boolean }) {
  return pro ? <div className="ws-row" data-testid="pro-status"><a href={PRO_MANAGE_HREF} data-testid="pro-manage">Pro · manage</a></div> : null;
}
