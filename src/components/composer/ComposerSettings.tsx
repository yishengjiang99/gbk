import { useRef, useState } from "react";
import type { UsageInfo } from "../../agent/protocol.ts";
import { exportLocalData, importLocalData } from "../../agent/migration.ts";

export function ComposerSettings({ info, model, setModel, usage, user, onLogout, onReset }: { info: { model: string; models: string[]; provider: string; llmConfigured: boolean } | null; model: string; setModel: (m: string) => void; usage: UsageInfo | null; user?: string; onLogout: () => void; onReset: () => void }) {
  const [msg, setMsg] = useState(""); const file = useRef<HTMLInputElement>(null);
  const doExport = async () => { const b = await exportLocalData(true); const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `gbk-export-${location.host}-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setMsg(`exported ${(b.size / 1048576).toFixed(1)} MB`); };
  const doImport = async (f: File) => { try { const r = await importLocalData(f); setMsg(`imported ${r.projects} projects, ${r.artifacts} artifacts${r.skipped ? `, skipped ${r.skipped}` : ""}`); } catch (e) { setMsg((e as Error).message); } };
  return (
    <details className="cmp-settings" data-testid="composer-settings">
      <summary>Settings{info ? ` · ${info.provider} · ${model}` : ""}{usage ? ` · today ${usage.dayTokens.toLocaleString()} tok / $${usage.dayCostUsd.toFixed(3)}` : ""}</summary>
      {info && <label>Model <select value={model} onChange={(e) => setModel(e.target.value)} data-testid="composer-model">{info.models.map((m) => <option key={m}>{m}</option>)}</select></label>}
      {info && !info.llmConfigured && <div className="cmp-error">LLM not configured on the server (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL).</div>}
      {usage && <div className="ws-dim">last call {usage.promptTokens}+{usage.completionTokens} tokens (~${usage.costUsd.toFixed(4)})</div>}
      <div className="ws-row"><button onClick={onReset}>New conversation</button>{user && <button onClick={onLogout}>Log out {user}</button>}</div>
      <div className="ws-dim">Projects and renders live in this browser for this site only. Moving from another GBK address? Export there, import here (nothing moves automatically).</div>
      <div className="ws-row"><button onClick={() => void doExport()}>Export local data</button><button onClick={() => file.current?.click()}>Import…</button>
        <input ref={file} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && void doImport(e.target.files[0])} /></div>
      {msg && <div className="ws-dim">{msg}</div>}
    </details>
  );
}
