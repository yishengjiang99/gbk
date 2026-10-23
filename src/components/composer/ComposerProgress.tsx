import type { ToolStep } from "../../agent/useAgentSession.ts";
const ICON: Record<ToolStep["status"], string> = { pending: "◌", running: "◐", done: "✓", failed: "✗" };
/** Per-tool step checklist for one assistant turn. */
export function ComposerProgress({ steps }: { steps: ToolStep[] }) {
  if (!steps.length) return null;
  return (
    <ul className="cmp-steps" data-testid="composer-steps">
      {steps.map((s) => (
        <li key={s.callId} className={`cmp-step ${s.status}`} data-tool={s.tool} data-status={s.status} title={s.tool}>
          <span className="cmp-ico">{ICON[s.status]}</span> {s.task}
          {s.summary && <span className="ws-dim"> — {s.summary}</span>}
          {s.progress && s.status === "running" && <span className="ws-dim"> ({s.progress})</span>}
        </li>
      ))}
    </ul>
  );
}
