import { useEffect, useRef } from "react";
import type { ChatItem } from "../../agent/useAgentSession.ts";
import { ComposerProgress } from "./ComposerProgress.tsx";
import { ComposerArtifacts } from "./ComposerArtifacts.tsx";

export function ComposerMessages({ items, onRetry, onResume }: { items: ChatItem[]; onRetry: (t: string) => void; onResume?: (runId: string) => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "end" }); }, [items]);
  return (
    <div className="cmp-messages" data-testid="composer-messages" aria-live="polite">
      {items.map((m) => (
        <div key={m.id} className={`cmp-msg ${m.role}`} data-role={m.role}>
          {m.role === "user" && <div className="cmp-bubble">{m.text}</div>}
          {m.role === "assistant" && <>
            <ComposerProgress steps={m.steps ?? []} />
            {m.text && <div className="cmp-bubble" data-testid="assistant-text">{m.text}</div>}
            <ComposerArtifacts artifacts={m.artifacts ?? []} />
          </>}
          {m.role === "error" && <div className="cmp-error" role="alert">⚠ {m.text} {m.resumeRunId && onResume ? <button data-testid="run-resume" onClick={() => onResume(m.resumeRunId!)}>Resume</button> : m.retryText && <button onClick={() => onRetry(m.retryText!)}>Retry</button>}</div>}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}
