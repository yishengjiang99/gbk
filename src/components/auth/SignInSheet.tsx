// The only sign-in UI on the web: a bottom sheet (modal on desktop) opened by a gated action via needSignIn().
// Lists whichever methods the server has configured (/api/session): Apple, Google, GitHub, SMS, invite code, reviewer.
import { useEffect, useRef, useState } from "react";
import type { NeedSignIn } from "./gate.ts";

interface Sess { csrf?: string; providers?: string[]; apple?: boolean; sms?: boolean; loginAvailable?: boolean; reviewerLogin?: boolean }
const ret = () => encodeURIComponent(location.pathname + location.search);
const post = async (path: string, csrf: string | undefined, body: unknown) => { const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...(csrf ? { "x-gbk-csrf": csrf } : {}) }, body: JSON.stringify(body) }); return { ok: r.ok, body: (await r.json().catch(() => ({}))) as { message?: string } }; };
declare global { interface Window { turnstile?: { render: (el: HTMLElement, o: { sitekey: string; callback: (t: string) => void }) => void } } }

export function SignInSheet() {
  const [req, setReq] = useState<NeedSignIn | null>(null); const [s, setS] = useState<Sess | null>(null);
  const [code, setCode] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState(""); const [otp, setOtp] = useState(""); const [sent, setSent] = useState(false); const [tsKey, setTsKey] = useState<string | null>(null); const [tsTok, setTsTok] = useState("");
  const tsEl = useRef<HTMLDivElement>(null);
  useEffect(() => { const f = (e: Event) => { setReq((e as CustomEvent<NeedSignIn>).detail); setErr(""); }; window.addEventListener("gbk:need-signin", f); return () => window.removeEventListener("gbk:need-signin", f); }, []);
  useEffect(() => { if (!req || s) return; void fetch("/api/session", { credentials: "same-origin" }).then((r) => r.json()).then((b: Sess) => { setS(b); if (b.sms) void fetch("/api/auth/sms/config").then((r) => r.json()).then((c: { turnstileSiteKey?: string }) => setTsKey(c.turnstileSiteKey ?? null)); }).catch(() => setS({})); }, [req, s]);
  useEffect(() => { if (!tsKey || !tsEl.current || sent) return; const el = tsEl.current; const go = () => window.turnstile?.render(el, { sitekey: tsKey, callback: setTsTok });
    if (window.turnstile) go(); else { const sc = document.createElement("script"); sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js"; sc.async = true; sc.onload = go; document.head.appendChild(sc); } }, [tsKey, sent]);
  useEffect(() => { if (!req) return; const k = (e: KeyboardEvent) => { if (e.key === "Escape") setReq(null); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [req]);
  if (!req) return null;
  const done = () => location.reload(); // the pending action is replayed after the reload
  const run = async (f: () => Promise<void>) => { setBusy(true); setErr(""); try { await f(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const providers = s?.providers ?? []; const none = s && !providers.length && !s.apple && !s.sms && !s.loginAvailable && !s.reviewerLogin;
  return (
    <>
      <div className="si-scrim" onClick={() => setReq(null)} />
      <div className="si-sheet" role="dialog" aria-modal="true" aria-labelledby="si-title" data-testid="signin-sheet">
        <header><b id="si-title">Sign in</b><button className="si-x" aria-label="Close" data-testid="signin-close" onClick={() => setReq(null)}>✕</button></header>
        <p className="si-why" data-testid="signin-why">{req.why}</p>
        {!s && <p className="si-dim">…</p>}
        <div className="si-list">
          {s?.apple && <a className="si-btn si-apple" data-testid="signin-apple" href={`/api/auth/apple/web?return=${ret()}`}> Continue with Apple</a>}
          {providers.includes("google") && <a className="si-btn" data-testid="signin-google" href={`/api/auth/google?return=${ret()}`}>Continue with Google</a>}
          {providers.includes("github") && <a className="si-btn" data-testid="signin-github" href={`/api/auth/github?return=${ret()}`}>Continue with GitHub</a>}
        </div>
        {s?.sms && (!sent ? (
          <form className="si-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await post("/api/auth/sms/start", s.csrf, { phone, turnstileToken: tsTok }); if (!r.ok) throw new Error(r.body.message ?? "could not send the code"); setSent(true); }); }}>
            <input type="tel" inputMode="tel" autoComplete="tel" placeholder="+1 555 123 4567" aria-label="Phone number" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="signin-phone" />
            <div ref={tsEl} /><button className="si-btn" disabled={busy || !phone.trim()}>Text me a code</button>
          </form>) : (
          <form className="si-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await post("/api/auth/sms/verify", s.csrf, { phone, code: otp }); if (!r.ok) throw new Error(r.body.message ?? "that code didn't work"); done(); }); }}>
            <input inputMode="numeric" autoComplete="one-time-code" placeholder="Code" aria-label="SMS code" value={otp} onChange={(e) => setOtp(e.target.value)} data-testid="signin-otp" />
            <button className="si-btn" disabled={busy || !otp.trim()}>Verify</button>
          </form>))}
        {s?.loginAvailable && (
          <details className="si-code" open={!providers.length && !s.apple && !s.sms}><summary>Have an invite code?</summary>
            <form className="si-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await post("/api/login", s.csrf, { code }); if (!r.ok) throw new Error(r.body.message ?? "login failed"); done(); }); }}>
              <input type="password" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Access code" aria-label="Access code" autoComplete="current-password" data-testid="signin-code" />
              <button className="si-btn" disabled={busy || !code} data-testid="signin-code-submit">Sign in</button>
            </form>
          </details>)}
        {s?.reviewerLogin && <a className="si-dim" data-testid="signin-reviewer" href={`/signin/reviewer?return=${ret()}`}>Reviewer sign-in</a>}
        {none && <p className="si-dim">Sign-in is not available right now.</p>}
        {err && <p className="si-err" role="alert">{err}</p>}
        <p className="si-dim">Guests can browse, play and read without an account.</p>
      </div>
    </>
  );
}
