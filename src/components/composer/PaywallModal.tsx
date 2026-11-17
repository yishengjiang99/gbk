// Web Studio paywall modal (plan approved 2026-11-16: "Approve the paywall plan, drop the landing paywall",
// "Export is Pro only"). No landing presentation. Three triggers, each logged with its reason:
//  - export: hard block. An export/download asks the server (POST /api/paywall/check); a 402 lands here via
//    requestPaywall("export") and nothing is downloaded.
//  - ai_budget / render_limit: hard, when the free daily AI budget or render limit is hit (GET /api/me.paywall,
//    or a run failing with a *_BUDGET_EXHAUSTED code).
//  - third_song: soft popup, once, when a free user starts their 3rd composition (agent/paywall.ts).
// The iOS app's WebView never shows this modal: export / third_song navigate to /pricing?reason=…, which the app
// intercepts to open its native paywall. The ChatGPT widget never sells. Events (paywall_view / paywall_dismiss /
// plan_select, with reason) go through POST /api/me/engagement, or POST /api/billing/events when signed out.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_PLAN, PAYWALL_PLANS, fetchPaywall, inChatGptWidget, isBudgetError, isHardReason, markThirdSongLocally, paywallSuppressed,
  pricingHref, publishPromptGate, reportPaywall, reportExport, resetLabel, type PaywallReason,
} from "../../agent/paywall.ts";
import { inNativeApp } from "../../agent/native-guest.ts";
import "./paywall.css";

interface Showing { kind: "soft" | "hard"; reason: PaywallReason }

const COPY: Record<PaywallReason, { title: string; body: string }> = {
  export: { title: "Export is a Pro feature", body: "Composing, playback, saving and sharing to Social stay free. Exporting a song as audio (WAV) or MIDI needs GBK Pro. Try it free for 7 days." },
  ai_budget: { title: "You've hit today's AI limit", body: "The free daily AI budget is used up, so the Composer can't start another run right now. Pro multiplies the daily budget by 10." },
  render_limit: { title: "You've hit today's render limit", body: "Free server renders are capped for today, so that render can't start right now. Pro gets 120 renders an hour, up to 10 minutes each." },
  third_song: { title: "Starting song #3. Nice!", body: "Your songs stay free to compose, play, save and share. Pro adds audio and MIDI export, a 10× daily AI budget and longer renders." },
};

export function PaywallHost() {
  const [showing, setShowing] = useState<Showing | null>(null);
  const [plan, setPlan] = useState(DEFAULT_PLAN);
  const showingRef = useRef<Showing | null>(null);
  const busy = useRef(false);
  const dismissedHard = useRef(new Set<PaywallReason>());

  const open = useCallback((s: Showing) => {
    if (showingRef.current) return;
    if (s.reason === "third_song") markThirdSongLocally(); // shown once, ever, in this browser
    if (paywallSuppressed()) {
      // iOS app: hand export / 3rd-song to the native paywall (its WebView intercepts /pricing). ChatGPT: never sell.
      if (inNativeApp() && (s.reason === "export" || s.reason === "third_song")) { void reportPaywall("paywall_view", s.reason); location.href = pricingHref(DEFAULT_PLAN, s.reason); }
      else if (inChatGptWidget() && s.reason === "export") window.alert("Exporting songs is a GBK Pro feature.");
      return;
    }
    showingRef.current = s; setShowing(s); setPlan(DEFAULT_PLAN);
    publishPromptGate.notePaywallShown();
    void reportPaywall("paywall_view", s.reason);
  }, []);

  /** Ask the server (source of truth) whether a finished/failed run hit a hard daily limit. */
  const decide = useCallback(async (budgetFailure: boolean) => {
    // The publish prompt for this same trigger waits on the gate until this decision resolves.
    publishPromptGate.beginDecision();
    try {
      if (busy.current || showingRef.current || paywallSuppressed()) return;
      busy.current = true;
      try {
        const st = await fetchPaywall();
        if (st?.pro) return;
        if (budgetFailure) {
          // A run just failed on the AI budget: that action is blocked right now, so the failure itself is the signal.
          if (!dismissedHard.current.has("ai_budget")) open({ kind: "hard", reason: "ai_budget" });
          return;
        }
        if (!st) return;
        const { eligible, reason } = st.paywall;
        if (!reason || !isHardReason(reason) || !eligible || dismissedHard.current.has(reason)) return;
        open({ kind: "hard", reason });
      } finally { busy.current = false; }
    } finally { publishPromptGate.endDecision(); }
  }, [open]);

  useEffect(() => {
    const onRunCompleted = () => { void decide(false); };
    const onRunFailed = (e: Event) => { void decide(isBudgetError((e as CustomEvent<{ code?: string }>).detail?.code)); };
    const onExported = () => { void reportExport(); };
    const onRequest = (e: Event) => {
      const reason = (e as CustomEvent<{ reason?: PaywallReason }>).detail?.reason;
      if (reason === "export" || reason === "third_song" || reason === "ai_budget" || reason === "render_limit") open({ kind: reason === "third_song" ? "soft" : "hard", reason });
    };
    window.addEventListener("gbk:run-completed", onRunCompleted);
    window.addEventListener("gbk:run-failed", onRunFailed);
    window.addEventListener("gbk:exported", onExported);
    window.addEventListener("gbk:paywall", onRequest);
    return () => {
      window.removeEventListener("gbk:run-completed", onRunCompleted);
      window.removeEventListener("gbk:run-failed", onRunFailed);
      window.removeEventListener("gbk:exported", onExported);
      window.removeEventListener("gbk:paywall", onRequest);
    };
  }, [decide, open]);

  const close = useCallback((dismiss: boolean) => {
    const s = showingRef.current;
    showingRef.current = null; setShowing(null);
    if (!s) return;
    if (s.kind === "hard" && s.reason !== "export") dismissedHard.current.add(s.reason);
    if (dismiss) void reportPaywall("paywall_dismiss", s.reason);
    // Last: release any publish prompt this presentation was holding back.
    publishPromptGate.notePaywallClosed();
  }, []);

  // Soft popup only: Escape, the ✕ and a backdrop tap dismiss it. Hard ones close only through their button.
  useEffect(() => {
    if (!showing || showing.kind !== "soft") return;
    const f = (e: KeyboardEvent) => { if (e.key === "Escape") close(true); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [showing, close]);

  if (!showing) return null;
  const hard = showing.kind === "hard";
  const copy = COPY[showing.reason];
  const selected = PAYWALL_PLANS.find((p) => p.id === plan) ?? PAYWALL_PLANS[0];
  const go = async () => {
    // plan_select first; give the report a brief chance to leave before the full-page navigation.
    await Promise.race([reportPaywall("plan_select", showing.reason, plan), new Promise((r) => setTimeout(r, 700))]);
    location.href = pricingHref(plan, showing.reason);
  };
  const laterLabel = showing.reason === "export" ? "Not now" : hard ? "Continue free" : "Maybe later";
  return (
    <div className="pw-backdrop" data-testid="paywall-modal" data-kind={showing.kind} data-reason={showing.reason}
      onClick={hard ? undefined : (e) => { if (e.target === e.currentTarget) close(true); }}>
      <div className="pw-card" role="dialog" aria-modal="true" aria-labelledby="pw-title">
        {!hard && <button className="pw-x" data-testid="paywall-dismiss" aria-label="Dismiss" onClick={() => close(true)}>✕</button>}
        <h3 id="pw-title">{copy.title}</h3>
        <p className="pw-body">{copy.body}</p>
        {(showing.reason === "ai_budget" || showing.reason === "render_limit") && <p className="pw-reset" data-testid="paywall-reset">Your free limit resets at {resetLabel()}.</p>}
        <table className="pw-cmp"><tbody>
          <tr><th></th><th>Free</th><th>Pro</th></tr>
          <tr><td>Compose, play, save, share</td><td>Unlimited</td><td>Unlimited</td></tr>
          <tr><td>Export audio &amp; MIDI</td><td>No</td><td>Yes</td></tr>
          <tr><td>AI Composer</td><td>Daily budget</td><td>10× daily budget</td></tr>
          <tr><td>Server renders</td><td>Daily cap</td><td>120/hour, up to 600 s</td></tr>
        </tbody></table>
        <div className="pw-plans" role="radiogroup" aria-label="Choose a plan">
          {PAYWALL_PLANS.map((p) => (
            <label key={p.id} className={`pw-plan${plan === p.id ? " sel" : ""}`} data-testid={`paywall-plan-${p.id}`}>
              <input type="radio" name="pw-plan" value={p.id} checked={plan === p.id} onChange={() => setPlan(p.id)} />
              <span className="pw-plan-name">{p.name}{p.id === "pro_yearly" ? " · 7 days free" : ""}</span>
              <span className="pw-plan-price">{p.price}{p.per ? <small>{p.per}</small> : ""}</span>
              <span className="pw-plan-note">{p.note}</span>
            </label>
          ))}
        </div>
        <div className="pw-actions">
          <button className="pw-ghost" data-testid={hard ? "paywall-continue" : "paywall-later"} onClick={() => close(true)}>{laterLabel}</button>
          <button className="pw-primary" data-testid="paywall-cta" onClick={() => void go()}>{selected.trial ? "Start 7-day free trial" : "Get lifetime Pro"}</button>
        </div>
        <p className="pw-fine">{selected.trial ? "Free for 7 days, then billed unless you cancel. " : ""}Buying happens on the pricing page; Pro applies to the email you check out with.</p>
      </div>
    </div>
  );
}
