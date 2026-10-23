// Conversation persistence: one JSON file per user under COMPOSER_DATA_DIR (atomic write). No secrets stored.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { newConversation, type Conversation } from "../agent/conversation.ts";

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
    const f = this.file(c.user); writeFileSync(`${f}.tmp`, JSON.stringify(c)); renameSync(`${f}.tmp`, f);
  }
  reset(user: string): Conversation {
    const c = newConversation(user); this.cache.set(user, c);
    if (this.dir && existsSync(this.file(user))) rmSync(this.file(user));
    return c;
  }
}
