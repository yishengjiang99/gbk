import { useEffect, useMemo, useState } from "react";
import type { Proposal, WorkstationState } from "../../workstation/controller.ts";
import { diffNotes, diffSummary } from "../../workstation/diff.ts";
import { workstation } from "./useWorkstation.ts";
import { agentToolsMode, getModelContext, registerWebMcpTools, unregisterWebMcpTools } from "../../webmcp/adapter.ts";
import { buildAllTools } from "../../webmcp/registry.ts";

const LS = "gbk.agentTools";

export function useAgentToolsToggle() {
  // Always available: the real WebMCP API when the browser has it, otherwise the in-page shim (window.gbkTools).
  const mode = typeof document !== "undefined" ? agentToolsMode() : "shim";
  const available = typeof document !== "undefined";
  // Shim mode is page-local (no flags, no cross-origin exposure), so it defaults on unless the user turned it off.
  const [on, setOn] = useState(() => { try { const v = localStorage.getItem(LS); return v === null ? mode === "shim" : v === "1"; } catch { return mode === "shim"; } });
  useEffect(() => {
    try { localStorage.setItem(LS, on ? "1" : "0"); } catch { /* private mode */ }
    if (!available) return;
    if (!on) { unregisterWebMcpTools(); workstation.setAgentToolsEnabled(false); return; }
    let cancelled = false; let reg: { unregister(): void } | null = null;
    void registerWebMcpTools(workstation, buildAllTools(workstation)).then((r) => { reg = r; if (cancelled) r?.unregister(); });
    return () => { cancelled = true; reg?.unregister(); };
  }, [on, available]);
  return { available, mode, on, setOn };
}

export function AgentPanel({ state, focusProposal, setFocus }: { state: WorkstationState; focusProposal: Proposal | null; setFocus: (id: string | null) => void }) {
  const [approval, setApproval] = useState<{ p: Proposal; resolve: (ok: boolean) => void } | null>(null);
  useEffect(() => {
    workstation.approvalHandler = (p) => new Promise<boolean>((resolve) => { setFocus(p.id); setApproval({ p, resolve }); dispatchEvent(new CustomEvent("gbk-approval-request")); });
    return () => { workstation.approvalHandler = null; };
  }, [setFocus]);
  const pending = state.proposals.filter((p) => p.status === "pending");
  const last = state.activity[state.activity.length - 1];
  const lastAgent = [...state.activity].reverse().find((a) => a.source === "agent");
  const diff = useMemo(() => (focusProposal ? diffNotes(focusProposal.original, focusProposal.candidate) : null), [focusProposal]);
  const ccDelta = focusProposal ? Math.abs(focusProposal.candidate.ccs.length - focusProposal.original.ccs.length) + focusProposal.ops.filter((o) => o.op === "setCC").reduce((s, o) => s + (o.op === "setCC" ? o.points.length : 0), 0) : 0;
  const accept = async (p: Proposal) => {
    if (approval && approval.p.id === p.id) { approval.resolve(true); setApproval(null); return; }
    try { await workstation.commitProposal(p.id, { source: "user" }); } catch (e) { alert((e as Error).message); }
  };
  const reject = (p: Proposal) => {
    if (approval && approval.p.id === p.id) { approval.resolve(false); setApproval(null); }
    workstation.discardProposal(p.id, "user");
  };
  return (
    <aside className="ws-agent" aria-label="Agent activity" data-testid="agent-panel">
      <h3>Agent activity</h3>
      <div className="ws-row"><span className={`ws-pill ${state.agentToolsEnabled ? "on" : "off"}`} data-testid="webmcp-status">{getModelContext() ? "WebMCP" : "Agent tools (shim: window.gbkTools)"} {state.agentToolsEnabled ? "on" : "off"}</span><a className="ws-link" href="/chatgpt" target="_blank" rel="noopener" data-testid="chatgpt-link">Use GBK from ChatGPT or other AI apps</a></div>
      <div className="ws-kv"><b>Last tool</b><span data-testid="last-tool">{lastAgent ? `${lastAgent.action} ${lastAgent.ok ? "✓" : "✗"} ${lastAgent.detail ?? ""}` : "–"}</span></div>
      <div className="ws-kv"><b>Last action</b><span>{last ? `${last.source}: ${last.action}` : "–"}</span></div>
      <div className="ws-kv"><b>Selection</b><span>{state.project.selection.endTick > state.project.selection.startTick ? `ticks ${state.project.selection.startTick}–${state.project.selection.endTick}, ${state.project.selection.noteIds.length} notes` : "none"}</span></div>
      {state.session && (
        <div className="ws-session" data-testid="agent-session" role="status">
          <b>Autonomous session</b> on agent project <i>{state.project.id === state.session.projectId ? state.project.name : state.session.projectId}</i>: the agent's edits to this new project apply without per-change approval (still undoable). Your other projects still need Accept.
          <div className="ws-row">
            <button onClick={() => workstation.endSession()} data-testid="end-session">End session</button>
            <button onClick={() => { if (confirm("Undo all of the agent's work on this project?")) workstation.discardAutonomousWork(); }}>Discard agent work</button>
          </div>
        </div>
      )}
      <div className="ws-kv"><b>Revision</b><span data-testid="revision">{state.project.revision}</span></div>
      {state.previewing && <div className="ws-kv"><b>Previewing</b><span>{state.previewing}</span></div>}
      <div className="ws-row">
        <button disabled={!state.canUndo} onClick={() => workstation.undo()}>Undo</button>
        <button disabled={!state.canRedo} onClick={() => workstation.redo()}>Redo</button>
      </div>
      <h4>Proposals ({pending.length} pending)</h4>
      {approval && <div className="ws-approval" role="alertdialog" aria-label="Agent requests approval">Agent asks to commit <b>{approval.p.id}</b>. Review the overlay, then Accept or Reject.</div>}
      <ul className="ws-proposals">
        {state.proposals.slice(-8).reverse().map((p) => (
          <li key={p.id} className={`${p.status} ${focusProposal?.id === p.id ? "focus" : ""}`} data-testid={`proposal-${p.id}`}>
            <button className="ws-link" onClick={() => setFocus(p.id)}>{p.id}</button> <span className="ws-status">{p.status}</span>
            <div className="ws-dim">{p.summary}</div>
            {focusProposal?.id === p.id && diff && <div className="ws-dim">{diffSummary(diff, ccDelta)}</div>}
            {p.validation.warnings.map((w, i) => <div key={i} className="ws-warn">⚠ {w}</div>)}
            {p.status === "pending" && (
              <div className="ws-row">
                <button onClick={() => void workstation.previewProposal(p.id, "A").catch((e) => alert(e.message))}>A</button>
                <button onClick={() => void workstation.previewProposal(p.id, "B").catch((e) => alert(e.message))}>B</button>
                <button className="ws-accept" onClick={() => void accept(p)}>Accept</button>
                <button className="ws-reject" onClick={() => reject(p)}>Reject</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <h4>Log</h4>
      <ol className="ws-log">{state.activity.slice(-12).reverse().map((a, i) => <li key={i} className={a.ok ? "" : "ws-warn"}>{a.source}: {a.action}{a.detail ? ` — ${a.detail.slice(0, 120)}` : ""}</li>)}</ol>
    </aside>
  );
}
