// Web Studio paywall modal (#116). Driven by /api/me.paywall (#115): soft (dismissable) at the 2nd composition
// and at the first export after it; hard (blocks, shows the reset time) when the AI or render limit is hit.
// Never rendered inside the iOS app's WebView (it opens the native paywall instead) or in the ChatGPT widget.
// Events (paywall_view / paywall_dismiss / plan_select) go through POST /api/me/engagement — see agent/paywall.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_PLAN, PAYWALL_PLANS, fetchPaywall, isBudgetError, isHardReason, paywallSuppressed,
  pricingHref, reportPaywall, reportExport, resetLabel, type PaywallReason,
} from "../../agent/paywall.ts";
import "./paywall.css";

interface Showing { kind: "soft" | "hard"; reason: PaywallReason }

const SOFT_COPY: Record<string, { title: string; body: string }> = {
  second_composition: { title: "You've composed 2 songs with GBK", body: "Free is perfect for trying things out. Pro gives the Composer a 10× daily AI budget and longer server renders, so bigger pieces finish in one go." },
  export_after_2: { title: "You're exporting your songs", body: "Nice — the music is leaving the Studio. Pro gives the Composer a 10× daily AI budget and longer server renders for the next ones." },
};
const HARD_COPY: Record<string, { title: string; body: string }> = {
  ai_limit: { title: "You've hit today's AI limit", body: "The free daily AI budget is used up, so the Composer can't start another run right now. Pro multiplies the daily budget by 10." },
  render_limit: { title: "You've hit today's render limit", body: "Free server renders are capped for today, so that render can't start right now. Pro gets 120 renders an hour, up to 10 minutes each." },
};

export function PaywallHost() {
  const [showing, setShowing] = useState<Showing | null>(null);
  const [plan, setPlan] = useState(DEFAULT_PLAN);
  const showingRef = useRef<Showing | null>(null);
  const busy = useRef(false);
  const shownSoft = useRef(new Set<PaywallReason>());
  const dismissedHard = useRef(new Set<PaywallReason>());

  const open = useCallback((s: Showing) => {
    if (paywallSuppressed() || showingRef.current) return;
    showingRef.current = s; setShowing(s); setPlan(DEFAULT_PLAN);
    void reportPaywall("paywall_view", s.reason);
  }, []);

  /** Ask the server (source of truth) whether a trigger should surface the modal right now. */
  const decide = useCallback(async (hardHint: boolean) => {
    if (busy.current || showingRef.current || paywallSuppressed()) return;
    busy.current = true;
    try {
      const st = await fetchPaywall();
      if (st?.pro) return;
      if (hardHint) {
        // A run just failed on the AI budget: that action is blocked right now, so the failure itself is the
        // signal. The server's soft reason can be null in this state (a dismiss cooldown suppresses it), yet
        // the hard modal is exactly what the user needs; a hard reason already dismissed this session stays so.
        if (!dismissedHard.current.has("ai_limit")) open({ kind: "hard", reason: "ai_limit" });
        return;
      }
      if (!st) return;
      const { eligible, reason } = st.paywall;
      if (!reason) return;
      if (isHardReason(reason)) {
        if (!eligible || dismissedHard.current.has(reason)) return;
        open({ kind: "hard", reason });
      } else if (eligible && !shownSoft.current.has(reason)) {
        shownSoft.current.add(reason);
        open({ kind: "soft", reason });
      }
    } finally { busy.current = false; }
  }, [open ]);

  useEffect(() => {
    if (paywallSuppressed()) return;
    const onRunCompleted = () => { void decide(false); };
    const onRunFailed = (e: Event) => {
      const code = (e as CustomEvent<{ code?: string }>).detail?.code;
      void decide(isBudgetError(code));
    };
    const onExported = () => { void reportExport().then(() => decide(false)); };
    window.addEventListener("gbk:run-completed", onRunCompleted);
    window.addEventListener("gbk:run-failed", onRunFailed);
    window.addEventListener("gbk:exported", onExported);
    return () => {
      window.removeEventListener("gbk:run-completed", onRunCompleted);
      window.removeEventListener("gbk:run-failed", onRunFailed);
      window.removeEventListener("gbk:exported", onExported);
    };
  }, [decide]);

  const close = useCallback((dismiss: boolean) => {
    const s = showingRef.current;
    showingRef.current = null; setShowing(null);
    if (!s) return;
    if (s.kind === "hard") dismissedHard.current.add(s.reason);
    if (dismiss) void reportPaywall("paywall_dismiss", s.reason);
  }, []);

  // Soft modal only: Escape dismisses (starts the server-side 24 h cooldown via paywall_dismiss).
  useEffect(() => {
    if (!showing || showing.kind !== "soft") return;
    const f = (e: KeyboardEvent) => { if (e.key === "Escape") close(true); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [showing, close]);

  if (!showing) return null;
  const hard = showing.kind === "hard";
  const copy = hard ? HARD_COPY[showing.reason] : SOFT_COPY[showing.reason];
  const selected = PAYWALL_PLANS.find((p) => p.id === plan) ?? PAYWALL_PLANS[0];
  const go = async () => {
    // plan_select first; give the report a brief chance to leave before the full-page navigation.
    await Promise.race([reportPaywall("plan_select", showing.reason, plan), new Promise((r) => setTimeout(r, 700))]);
    location.href = pricingHref(plan);
  };
  return (
    <div className="pw-backdrop" data-testid="paywall-modal" data-kind={showing.kind} data-reason={showing.reason}
      onClick={hard ? undefined : (e) => { if (e.target === e.currentTarget) close(true); }}>
      <div className="pw-card" role="dialog" aria-modal="true" aria-label="GBK Composer Pro">
        {!hard && <button className="pw-x" data-testid="paywall-dismiss" aria-label="Dismiss" onClick={() => close(true)}>✕</button>}
        <h3>{copy?.title ?? "Go further with Pro"}</h3>
        <p className="pw-body">{copy?.body}</p>
        {hard && <p className="pw-reset" data-testid="paywall-reset">Your free limit resets at {resetLabel()}.</p>}
        <table className="pw-cmp"><tbody>
          <tr><th></th><th>Free</th><th>Pro</th></tr>
          <tr><td>AI Composer</td><td>Daily budget</td><td>10× daily budget</td></tr>
          <tr><td>Server renders</td><td>Hourly cap</td><td>120/hour, up to 600 s</td></tr>
          <tr><td>Composing, editing, MIDI/WAV downloads</td><td>Included</td><td>Included</td></tr>
        </tbody></table>
        <div className="pw-plans" role="radiogroup" aria-label="Choose a plan">
          {PAYWALL_PLANS.map((p) => (
            <label key={p.id} className={`pw-plan${plan === p.id ? " sel" : ""}`} data-testid={`paywall-plan-${p.id}`}>
              <input type="radio" name="pw-plan" value={p.id} checked={plan === p.id} onChange={() => setPlan(p.id)} />
              <span className="pw-plan-name">{p.name}{p.id === "pro_yearly" ? " · Best value" : ""}</span>
              <span className="pw-plan-price">{p.price}{p.per ? <small>{p.per}</small> : ""}</span>
              <span className="pw-plan-note">{p.note}</span>
            </label>
          ))}
        </div>
        <div className="pw-actions">
          {hard
            ? <button className="pw-ghost" data-testid="paywall-continue" onClick={() => close(true)}>Continue free</button>
            : <button className="pw-ghost" data-testid="paywall-later" onClick={() => close(true)}>Maybe later</button>}
          <button className="pw-primary" data-testid="paywall-cta" onClick={() => void go()}>{selected.trial ? "Start 7-day free trial" : "Get lifetime Pro"}</button>
        </div>
        <p className="pw-fine">{selected.trial ? "Free for 7 days, then billed unless you cancel. " : ""}Buying happens on the pricing page; Pro applies to the email you check out with.</p>
      </div>
    </div>
  );
}
