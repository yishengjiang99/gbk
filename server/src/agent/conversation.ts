// One conversation per user: model messages (system prompt excluded) + UI history + project binding.
import type { ChatMessage } from "./model-client.ts";
import type { ArtifactRef, HistoryItem } from "../../../src/agent/protocol.ts";

/** #163 #3: the run's intent, set by the UI entry point when it knows, else derived by the runtime.
 * "new" may create a project; "edit" is a follow-up on the open project; "remix" is an edit of a fork. */
export type AgentMode = "new" | "edit" | "remix";

/** #163 #7: structured working memory that survives context compaction. Updated deterministically from
 * tool results by the runtime (never by the model), and emitted as data in the per-turn context line and
 * in compaction summaries, so key / sections / track roles / decisions are not lost at ~32k tokens. */
export interface WorkingMemory {
  key?: string; tempoBpm?: number;
  sections: { name: string; startBar: number; bars: number }[];
  tracks: { id: string; name: string; isPercussion: boolean }[];
  /** Short factual notes: decisions, rejections, and the latest mutation summaries (bounded). */
  decisions: string[];
  pendingProposals: string[];
}

export const emptyWorkingMemory = (): WorkingMemory => ({ sections: [], tracks: [], decisions: [], pendingProposals: [] });

export interface Conversation {
  user: string; id: string; createdAt: number; updatedAt: number;
  messages: ChatMessage[]; history: HistoryItem[];
  /** Project this conversation composed / edits (set by gbk_create_project or the first run). */
  projectId: string | null; lastRevision: number | null;
  artifacts: ArtifactRef[]; recentEdits: string[];
  /** #162: set when this conversation is a remix of a shared song; the open project is the user's fork
   * of it. Null for ordinary conversations (and absent in conversations persisted before this field). */
  remixOf: { slug: string; title: string; projectId: string } | null;
  /** #163 #7 (absent in conversations persisted before this field; readers must default it). */
  workingMemory?: WorkingMemory;
  /** Mode of the most recent run (#163 #3), for traces/diagnostics. */
  lastMode?: AgentMode;
}
export function newConversation(user: string): Conversation {
  const t = Date.now();
  return { user, id: `conv_${t.toString(36)}`, createdAt: t, updatedAt: t, messages: [], history: [], projectId: null, lastRevision: null, artifacts: [], recentEdits: [], remixOf: null, workingMemory: emptyWorkingMemory() };
}
/** Working memory with the persisted-shape default applied. */
export function workingMemoryOf(conv: Conversation): WorkingMemory {
  conv.workingMemory ??= emptyWorkingMemory();
  conv.workingMemory.sections ??= []; conv.workingMemory.tracks ??= []; conv.workingMemory.decisions ??= []; conv.workingMemory.pendingProposals ??= [];
  return conv.workingMemory;
}
