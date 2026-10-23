// One conversation per user: model messages (system prompt excluded) + UI history + project binding.
import type { ChatMessage } from "./model-client.ts";
import type { ArtifactRef, HistoryItem } from "../../../src/agent/protocol.ts";

export interface Conversation {
  user: string; id: string; createdAt: number; updatedAt: number;
  messages: ChatMessage[]; history: HistoryItem[];
  /** Project this conversation composed / edits (set by gbk_create_project or the first run). */
  projectId: string | null; lastRevision: number | null;
  artifacts: ArtifactRef[]; recentEdits: string[];
}
export function newConversation(user: string): Conversation {
  const t = Date.now();
  return { user, id: `conv_${t.toString(36)}`, createdAt: t, updatedAt: t, messages: [], history: [], projectId: null, lastRevision: null, artifacts: [], recentEdits: [] };
}
