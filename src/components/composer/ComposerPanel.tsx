import { songAutosaver } from "../../agent/autosave.ts";
// AI Composer panel: prompt -> server agent -> real gbk_* tools in THIS page via the authenticated bridge.
import { useEffect, useRef, useState } from "react";
import { useAgentSession } from "../../agent/useAgentSession.ts";
import { ComposerMessages } from "./ComposerMessages.tsx";
import { ComposerSettings } from "./ComposerSettings.tsx";
import { SharePanel } from "./SharePanel.tsx";
import type { Project } from "../../workstation/model.ts";

export const STARTER_PROMPTS: { label: string; text: string }[] = [
  { label: "Baroque fugue", text: "Compose a four-voice fugue in D minor with a dramatic subject, expressive strings, and a powerful final stretto." },
  { label: "Jazz trio", text: "Write 32 bars of a relaxed jazz trio arrangement with walking bass, piano chords, and a melodic solo." },
  { label: "Ambient", text: "Create a slowly evolving ambient piece with sustained strings, gentle modulation and warm reverb." },
  { label: "Edit", text: "Make the cello darker, lower its volume slightly, and add an expression swell in the final eight measures." },
];
const STATUS: Record<string, string> = { idle: "Offline", connecting: "Connecting…", connected: "Connected", reconnecting: "Reconnecting…", offline: "Disconnected", unauthorized: "Signed out" };

export function ComposerPanel({ project, readOnly }: { project: Project; readOnly: string | null }) {
  const s = useAgentSession();
  // Private auto-save while logged in; when a run that produced a saved song finishes, offer Publish (never automatic).
  useEffect(() => { if (s.auth.authenticated) songAutosaver.start(); else songAutosaver.stop(); }, [s.auth.authenticated]);
  const [publishReq, setPublishReq] = useState(0); const prevRun = useRef<string | null>(null);
  useEffect(() => {
    const was = prevRun.current; prevRun.current = s.run?.runId ?? null;
    if (!was || s.run) return;
    const last = s.items[s.items.length - 1];
    if (last?.role === "error") return;
    void songAutosaver.flush().then((song) => { if (song && !song.public) setPublishReq((x) => x + 1); });
  }, [s.run, s.items]);
  const [text, setText] = useState(() => { const d = sessionStorage.getItem("gbk.composerDraft") ?? ""; sessionStorage.removeItem("gbk.composerDraft"); return d; }); const [code, setCode] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const f = () => input.current?.focus(); window.addEventListener("gbk:focus-composer", f); return () => window.removeEventListener("gbk:focus-composer", f); }, []);
  useEffect(() => { if (s.conn.state === "connected" && sessionStorage.getItem("gbk.focusComposer")) { sessionStorage.removeItem("gbk.focusComposer"); input.current?.focus(); } }, [s.conn.state]);
  const submit = (t = text) => { if (s.send(t)) setText(""); };
  const busy = !!s.run;
  return (
    <aside className="cmp" aria-label="AI Composer" data-testid="composer-panel">
      <div className="cmp-head">
        <h3>AI Composer</h3>
        <span className={`cmp-conn ${s.conn.state}`} data-testid="composer-conn" data-state={s.conn.state}>{STATUS[s.conn.state]} ●</span>
      </div>
      {!s.auth.checked ? <div className="ws-dim">…</div> : !s.auth.authenticated ? (
        <form className="cmp-login" data-testid="composer-login" onSubmit={(e) => { e.preventDefault(); void s.login(code); }}>
          <div className="ws-dim">The AI Composer is invite-only for now. Enter your access code. (Shared songs below play without one.)</div>
          <input type="password" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Access code" aria-label="Access code" autoComplete="current-password" />
          <button type="submit">Sign in</button>
          {s.auth.error && <div className="cmp-error">{s.auth.error}</div>}
        </form>
      ) : (<>
        {s.conn.state !== "connected" && s.conn.state !== "connecting" && <div className="cmp-error">{STATUS[s.conn.state]} {s.conn.detail ?? ""} <button onClick={s.reconnect}>Reconnect</button></div>}
        {s.info?.rejectedTools.length ? <div className="cmp-error">Server refused {s.info.rejectedTools.length} tool definitions from this page (version mismatch? reload).</div> : null}
        <ComposerMessages items={s.items} onRetry={(t) => submit(t)} />
        {s.run && <div className="cmp-run" data-testid="composer-run" role="status">
          <span className="cmp-spinner" /> {s.run.task}{s.run.maxSteps ? ` · step ${s.run.step}/${s.run.maxSteps}` : ""}
          <button onClick={s.stop} data-testid="composer-stop">Stop</button>
        </div>}
        {!s.items.length && <div className="cmp-starters" data-testid="starter-prompts">{STARTER_PROMPTS.map((p) => <button key={p.label} disabled={busy || s.conn.state !== "connected"} title={p.text} onClick={() => submit(p.text)}>{p.label}</button>)}</div>}
        <form className="cmp-input" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <textarea ref={input} data-testid="composer-input" value={text} rows={3} maxLength={12000} placeholder={readOnly ? "Fork this song to edit it with the AI…" : project.tracks.length ? "Type a change… (Enter to send, Shift+Enter for a new line)" : "Describe the music to compose…"}
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
          <button type="submit" data-testid="composer-send" disabled={busy || !text.trim() || s.conn.state !== "connected"}>Send</button>
        </form>
        <ComposerSettings info={s.info} model={s.model} setModel={s.setModel} usage={s.usage} user={s.auth.user} onLogout={() => void s.logout()} onReset={s.reset} />
      </>)}
      <SharePanel project={project} readOnly={readOnly} authenticated={s.auth.authenticated} publishRequest={publishReq} />
    </aside>
  );
}
