// Composer errors in plain language: no internal codes or ids reach the chat (bridge/runtime codes stay in logs).
const PLAIN: Record<string, string> = {
  BROWSER_DISCONNECTED: "This page reloaded or closed, so the run stopped. Finished changes are saved; send your message again to continue.",
  RUN_PAUSED_TOO_LONG: "The app was in the background too long, so the run stopped. Finished changes are saved; tap Resume to continue.",
  RESUME_DENIED: "That run can't be resumed anymore. Send your message again.",
  PROJECT_CHANGED: "A different song was opened while this was running, so that step was skipped.",
  STALE_REVISION: "The song changed while this step was running, so it was skipped.",
  TOOL_TIMEOUT: "That step took too long and was stopped.",
  OPERATION_CANCELLED: "Stopped.",
  MAX_STEPS: "Stopped after the maximum number of steps; everything finished so far is kept.",
  MAX_TOOL_CALLS: "Stopped after too many steps in one run; everything finished so far is kept.",
  PROVIDER_RATE_LIMITED: "The AI service is busy right now. Try again in a moment.",
  PROVIDER_ERROR: "The AI service had a problem. Try again in a moment.",
  QUOTA_EXCEEDED: "You've reached today's Composer limit.",
  RATE_LIMITED: "Too many requests. Try again in a moment.",
  NO_TOOLS: "The studio isn't ready yet. Reload the page and try again.",
  LLM_NOT_CONFIGURED: "The Composer isn't available on this server right now.",
  USER_APPROVAL_REQUIRED: "Waiting for your approval.",
};
const ID = /\b(prj|shr|run|call|art|usr|sess)_[a-z0-9]{6,}\b/gi;
export function friendlyError(code: string | undefined, message: string | undefined): string {
  if (code && PLAIN[code]) return PLAIN[code];
  if (code && /BUDGET_EXHAUSTED$/.test(code)) return /You've hit today's AI limit/.test(message ?? "") ? message!.trim() : "You've hit today's AI limit. It resets at 5 PM PT.";
  const m = (message ?? "").replace(/^\(?[A-Z][A-Z0-9_]{3,}\)?:?\s*/, "").replace(/\s*\((expected|was|now)[^)]*\)/gi, "").replace(ID, "this song").trim();
  if (!m) return "Something went wrong. Try again.";
  return m[0].toUpperCase() + m.slice(1);
}
