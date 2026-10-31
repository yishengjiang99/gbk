// Context management: token estimates, compact tool results, and compaction of old turns (deterministic summary,
// no extra model call) so the request stays under AGENT_MAX_CONTEXT_TOKENS while keeping the user's intent.
import type { ChatMessage } from "./model-client.ts";
import type { WorkingMemory } from "./conversation.ts";

/** #163 #7: the structured working memory as bounded summary lines (data, not prose). */
export function workingMemoryLines(wm: WorkingMemory | undefined): string[] {
  if (!wm) return [];
  const lines: string[] = [];
  if (wm.key) lines.push(`- key: ${wm.key}`);
  if (wm.tempoBpm) lines.push(`- tempo: ${wm.tempoBpm} BPM`);
  if (wm.sections.length) lines.push(`- sections: ${wm.sections.map((s) => `${s.name}@${s.startBar}+${s.bars}`).join(", ").slice(0, 400)}`);
  if (wm.tracks.length) lines.push(`- tracks: ${wm.tracks.map((t) => `${t.id}=${t.name}${t.isPercussion ? " (percussion)" : ""}`).join(", ").slice(0, 600)}`);
  for (const d of wm.decisions.slice(-8)) lines.push(`- decision: ${d.slice(0, 160)}`);
  if (wm.pendingProposals.length) lines.push(`- pending proposals: ${wm.pendingProposals.join(", ")}`);
  return lines;
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 3.6);
export const messageTokens = (m: ChatMessage) => estimateTokens(JSON.stringify(m)) + 4;

/** Serialize a tool result for the model: bounded, explicit when shortened, never media bytes. */
export function compactToolResult(result: unknown, maxChars: number): string {
  const strip = (v: unknown, depth = 0): unknown => {
    if (typeof v === "string") return v.length > 2000 ? `${v.slice(0, 2000)}…[${v.length - 2000} more chars omitted]` : v;
    if (Array.isArray(v)) return v.length > 60 && depth > 0 ? [...v.slice(0, 60).map((x) => strip(x, depth + 1)), `…[${v.length - 60} more items omitted; use pagination]`] : v.map((x) => strip(x, depth + 1));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !/^(base64|data64|bytes64|objectUrl)$/.test(k)).map(([k, x]) => [k, strip(x, depth + 1)]));
    return v;
  };
  let s = JSON.stringify(strip(result));
  if (s.length > maxChars) s = JSON.stringify({ note: `result shortened from ${s.length} chars to fit context; request a narrower range or use pagination`, head: s.slice(0, maxChars - 200) });
  return s;
}

/** Keep system + the newest turns; fold older turns into one summary message. Tool call/result pairs stay intact.
 * The working memory (#163 #7) rides in the summary so decisions survive compaction even though tool
 * results themselves are dropped. */
export function compactMessages(msgs: ChatMessage[], maxTokens: number, wm?: WorkingMemory): { messages: ChatMessage[]; compacted: boolean } {
  const total = msgs.reduce((s, m) => s + messageTokens(m), 0);
  if (total <= maxTokens) return { messages: msgs, compacted: false };
  const [sys, ...rest] = msgs;
  // turn boundaries = user messages
  const starts = rest.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
  let keepFrom = starts.length ? starts[starts.length - 1] : 0;
  for (let k = starts.length - 1; k >= 0; k--) {
    const tail = rest.slice(starts[k]).reduce((s, m) => s + messageTokens(m), 0);
    if (tail + messageTokens(sys) + 1000 > maxTokens) break;
    keepFrom = starts[k];
  }
  const old = rest.slice(0, keepFrom);
  let kept = rest.slice(keepFrom);
  const lines: string[] = [];
  for (const m of old) {
    if (m.role === "user") lines.push(`- user asked: ${m.content.slice(0, 160)}`);
    else if (m.role === "assistant" && m.content) lines.push(`- you replied: ${m.content.slice(0, 160)}`);
    else if (m.role === "assistant" && m.tool_calls) lines.push(`- you called: ${m.tool_calls.map((t) => t.function.name).join(", ")}`);
  }
  // Inside the current turn: shrink old tool results (oldest first) until it fits.
  const fits = () => messageTokens(sys) + 600 + kept.reduce((s, m) => s + messageTokens(m), 0) <= maxTokens;
  for (let i = 0; i < kept.length && !fits(); i++) {
    const m = kept[i];
    if (m.role === "tool" && m.content.length > 400) kept = kept.map((x, j) => j === i ? { ...m, content: JSON.stringify({ note: "older tool result elided to save context; call the read tool again if needed", head: m.content.slice(0, 300) }) } : x);
  }
  const wmLines = workingMemoryLines(wm);
  const summary: ChatMessage = { role: "user", content: `[Conversation summary of earlier turns, written by the server - context only]\n${(lines.slice(-30).join("\n") || "- (earlier tool activity)").slice(-2400)}${wmLines.length ? `\n[Working memory - data]\n${wmLines.join("\n")}` : ""}` };
  const ack: ChatMessage = { role: "assistant", content: "Understood; continuing from the current project state." };
  return { messages: old.length ? [sys, summary, ack, ...kept] : [sys, ...kept], compacted: true };
}
