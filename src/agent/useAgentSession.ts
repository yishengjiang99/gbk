// React state for the Composer panel. Music state is NOT copied here: the workstation controller stays the single
// source of truth; this hook only tracks the conversation, tool activity, usage and artifacts.
import { friendlyError } from "./friendly-error.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { workstation } from "../workstation/instance.ts";
import { BridgeClient, apiBase, type ConnState } from "./bridge-client.ts";
import type { ArtifactRef, HistoryItem, ServerMessage, UsageInfo } from "./protocol.ts";

export interface ToolStep { callId: string; tool: string; task: string; status: "pending" | "running" | "done" | "failed"; summary?: string; error?: string; progress?: string }
export interface ChatItem { id: string; role: "user" | "assistant" | "error"; text: string; artifacts?: ArtifactRef[]; steps?: ToolStep[]; runId?: string; retryText?: string }
export interface AuthState { checked: boolean; authenticated: boolean; user?: string; name?: string; csrf?: string; enabled?: boolean; error?: string; providers?: ("github" | "google")[]; codeLogin?: boolean; reviewerLogin?: boolean; limits?: { newAccount: boolean; dailyTokens: number; dailyRenders: number } | null }

async function api(path: string, init: RequestInit & { csrf?: string } = {}) {
  const headers: Record<string, string> = { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.csrf ? { "x-gbk-csrf": init.csrf } : {}) };
  const r = await fetch(`${apiBase()}${path}`, { ...init, headers, credentials: "same-origin" });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

export function useAgentSession() {
  const [auth, setAuth] = useState<AuthState>({ checked: false, authenticated: false });
  const [conn, setConn] = useState<{ state: ConnState; detail?: string }>({ state: "idle" });
  const [items, setItems] = useState<ChatItem[]>([]);
  const [run, setRun] = useState<{ runId: string; task: string; step: number; maxSteps: number } | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [info, setInfo] = useState<{ model: string; models: string[]; provider: string; llmConfigured: boolean; rejectedTools: string[] } | null>(null);
  const [model, setModel] = useState<string>("");
  const client = useRef<BridgeClient | null>(null);
  // #162: while a remix session is active, sends carry remixOf so the server binds the run to the fork.
  const remixRef = useRef<{ slug: string; title: string } | null>(null);
  const setRemixOf = useCallback((v: { slug: string; title: string } | null) => { remixRef.current = v; }, []);

  const refreshAuth = useCallback(async () => {
    // A 5xx / unreachable server (e.g. mid-deploy) is not a logout: keep the last known sign-in state.
    try { const { status, body } = await api("/session"); if (status >= 500) { setAuth((a) => ({ ...a, checked: true, error: "server error" })); return; } setAuth({ checked: true, authenticated: !!body.authenticated, user: body.user, name: body.name ?? body.user, csrf: body.csrf, enabled: body.enabled !== false, providers: Array.isArray(body.providers) ? body.providers : [], codeLogin: !!body.loginAvailable, reviewerLogin: !!body.reviewerLogin, limits: body.limits ?? null, error: status >= 500 ? "server error" : undefined }); }
    catch { setAuth((a) => ({ ...a, checked: true, error: "Composer server unreachable" })); }
  }, []);
  useEffect(() => { void refreshAuth(); }, [refreshAuth]);

  const patchLastAssistant = (runId: string, fn: (it: ChatItem) => ChatItem) => setItems((xs) => {
    const i = xs.map((x) => x.runId === runId && x.role === "assistant").lastIndexOf(true);
    if (i < 0) return [...xs, fn({ id: `a_${runId}`, role: "assistant", text: "", steps: [], runId })];
    const copy = xs.slice(); copy[i] = fn(copy[i]); return copy;
  });

  const onEvent = useCallback((m: ServerMessage) => {
    switch (m.type) {
      case "session_ready":
        setInfo({ model: m.model, models: m.models, provider: m.provider, llmConfigured: m.llmConfigured, rejectedTools: m.rejectedTools });
        setModel((x) => x || m.model);
        setItems((xs) => xs.length ? xs : m.history.map((h: HistoryItem, i) => ({ id: `h${i}`, role: h.role, text: h.text, artifacts: h.artifacts })));
        break;
      case "run_started": setRun({ runId: m.runId, task: "Thinking", step: 0, maxSteps: 0 }); patchLastAssistant(m.runId, (x) => x); break;
      case "assistant_delta": patchLastAssistant(m.runId, (x) => ({ ...x, text: x.text + m.text })); break;
      case "assistant_message": patchLastAssistant(m.runId, (x) => ({ ...x, text: m.text })); break;
      case "tool_intent": patchLastAssistant(m.runId, (x) => ({ ...x, steps: [...(x.steps ?? []), { callId: m.callId, tool: m.tool, task: m.task, status: "pending" }] })); setRun((r) => r && { ...r, task: m.task }); break;
      case "tool_started": patchLastAssistant(m.runId, (x) => ({ ...x, steps: (x.steps ?? []).map((s) => s.callId === m.callId ? { ...s, status: "running" } : s) })); break;
      case "tool_progress": patchLastAssistant(m.runId, (x) => ({ ...x, steps: (x.steps ?? []).map((s) => s.callId === m.callId ? { ...s, progress: m.detail } : s) })); break;
      case "tool_completed": patchLastAssistant(m.runId, (x) => ({ ...x, steps: (x.steps ?? []).map((s) => s.callId === m.callId ? { ...s, status: m.ok ? "done" : "failed", summary: m.summary, error: m.error ? friendlyError(m.error.code, m.error.message) : undefined } : s), artifacts: m.artifact ? [...(x.artifacts ?? []), m.artifact] : x.artifacts })); break;
      case "progress": setRun((r) => r && { ...r, step: m.step, maxSteps: m.maxSteps, task: m.task }); break;
      case "usage": setUsage(m.usage); break;
      case "run_completed": setRun(null); patchLastAssistant(m.runId, (x) => ({ ...x, text: m.text || x.text, artifacts: m.artifacts.length ? dedupe([...(x.artifacts ?? []), ...m.artifacts]) : x.artifacts })); window.dispatchEvent(new CustomEvent("gbk:run-completed", { detail: { runId: m.runId, steps: m.steps } })); break;
      case "run_failed": setRun(null); setItems((xs) => [...xs, { id: `e_${m.runId}_${Date.now()}`, role: "error", text: friendlyError(m.code, m.message), runId: m.runId, retryText: m.retryable ? lastUser(xs) : undefined }]); window.dispatchEvent(new CustomEvent("gbk:run-failed", { detail: { runId: m.runId, code: m.code, message: m.message } })); break;
      case "error": setItems((xs) => [...xs, { id: `e_${Date.now()}`, role: "error", text: friendlyError(m.code, m.message) }]); break;
      case "session_reconnected": if (!m.resumed && m.runId) setRun(null); break;
    }
  }, []);

  useEffect(() => {
    if (!auth.authenticated) return;
    const c = new BridgeClient(workstation, onEvent, (state, detail) => { setConn({ state, detail }); if (state === "unauthorized") void refreshAuth(); });
    client.current = c; c.connect();
    (globalThis as { __gbkComposer?: unknown }).__gbkComposer = { client: c }; // test/diagnostic handle (read-only use)
    return () => { c.close(); client.current = null; };
  }, [auth.authenticated, onEvent, refreshAuth]);

  const send = useCallback((text: string) => {
    const t = text.trim(); if (!t || !client.current) return false;
    const id = `u_${Date.now()}`;
    if (!client.current.send({ type: "user_message", clientMessageId: id, text: t, ...(model ? { model } : {}) })) return false;
    setItems((xs) => [...xs, { id, role: "user", text: t }]);
    return true;
  }, [model]);
  const stop = useCallback(() => { const r = run?.runId ?? client.current?.activeRunId; if (r) client.current?.send({ type: "cancel_run", runId: r }); client.current?.cancelLocal(); }, [run]);
  const reset = useCallback(() => { remixRef.current = null; client.current?.send({ type: "reset_conversation" }); setItems([]); }, []);
  const login = useCallback(async (code: string) => {
    const { status, body } = await api("/login", { method: "POST", body: JSON.stringify({ code }), csrf: auth.csrf });
    if (status !== 200) { setAuth((a) => ({ ...a, error: body.message ?? "login failed" })); return false; }
    await refreshAuth(); return true;
  }, [auth.csrf, refreshAuth]);
  const logout = useCallback(async () => { await api("/logout", { method: "POST", body: "{}", csrf: auth.csrf }); client.current?.close(); await refreshAuth(); }, [auth.csrf, refreshAuth]);
  const reconnect = useCallback(() => { client.current?.close(); const c = client.current; if (c) { c.maxReconnects = 8; c.connect(); } }, []);

  return { auth, conn, items, run, usage, info, model, setModel, send, stop, reset, setRemixOf, login, logout, reconnect, refreshAuth };
}

function dedupe(a: ArtifactRef[]) { const s = new Set<string>(); return a.filter((x) => !s.has(x.artifactId) && !!s.add(x.artifactId)); }
function lastUser(xs: ChatItem[]) { return [...xs].reverse().find((x) => x.role === "user")?.text; }
