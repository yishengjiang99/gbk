// Conversation persistence: one JSON file per user under COMPOSER_DATA_DIR (atomic write). No secrets stored.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { newConversation, type Conversation } from "../agent/conversation.ts";
import { compactMessages } from "../agent/context.ts";

/** #163 #13: stored conversations are capped. The full uncompacted message list used to grow until the
 * user reset; now the persisted form is the compacted one (plus working memory, which rides inside the
 * compaction summary and as its own field), and history is bounded too. The in-memory conversation is
 * untouched - only what lands on disk is trimmed. */
export const MAX_STORED_MESSAGES = 240;
export const MAX_STORED_HISTORY = 100;
const STORAGE_TOKEN_BUDGET = 32_000;

export function storedForm(c: Conversation): Conversation {
  let messages = c.messages;
  if (messages.length > MAX_STORED_MESSAGES) {
    messages = compactMessages(messages, STORAGE_TOKEN_BUDGET, c.workingMemory).messages;
    // Still too long: drop whole turns from the front (never split a tool call/result pair).
    while (messages.length > MAX_STORED_MESSAGES) {
      const next = messages.findIndex((m, i) => i > 0 && m.role === "user");
      if (next < 0) break;
      messages = messages.slice(next);
    }
  }
  return { ...c, messages, history: c.history.slice(-MAX_STORED_HISTORY) };
}

export class ConversationStore {
  private cache = new Map<string, Conversation>();
  constructor(private dir: string | null) { if (dir) mkdirSync(join(dir, "conversations"), { recursive: true }); }
  private file(user: string) { return join(this.dir!, "conversations", `${user.replace(/[^\w.-]/g, "_")}.json`); }
  get(user: string): Conversation {
    const c = this.cache.get(user); if (c) return c;
    let conv: Conversation | null = null;
    if (this.dir && existsSync(this.file(user))) { try { conv = JSON.parse(readFileSync(this.file(user), "utf8")); } catch { conv = null; } }
    conv ??= newConversation(user);
    this.cache.set(user, conv); return conv;
  }
  save(c: Conversation) {
    c.updatedAt = Date.now(); this.cache.set(c.user, c);
    if (!this.dir) return;
    const f = this.file(c.user); writeFileSync(`${f}.tmp`, JSON.stringify(storedForm(c))); renameSync(`${f}.tmp`, f);
  }
  reset(user: string): Conversation {
    const c = newConversation(user); this.cache.set(user, c);
    if (this.dir && existsSync(this.file(user))) rmSync(this.file(user));
    return c;
  }
}
