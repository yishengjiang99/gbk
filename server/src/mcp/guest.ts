// Account-free ("guest") MCP projects. Each guest composition gets a unique synthetic owner and two
// capabilities derived from it: an edit capability (returned once, at creation) and a read capability
// (safe for private Studio links, carried only in a URL fragment). A composition ID alone grants nothing.
// HMACs are domain-separated from OAuth/artifact credentials and survive restarts with the same
// SESSION_SECRET; rotating that secret invalidates every guest capability.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.ts";
import type { CompositionRow, McpStore } from "./store.ts";
import type { Principal, Scope } from "./auth.ts";
import { McpError } from "./errors.ts";

export const GUEST_PREFIX = "guest:";
export const isGuest = (owner: string) => owner.startsWith(GUEST_PREFIX);
/** Scopes per capability. Read can inspect and download; it can never edit, render or publish. */
export const GUEST_EDIT_SCOPES: Scope[] = ["gbk:compositions.read", "gbk:compositions.write", "gbk:renders.create", "gbk:artifacts.read", "gbk:shares.publish"];
export const GUEST_READ_SCOPES: Scope[] = ["gbk:compositions.read", "gbk:artifacts.read"];

/** A fresh guest owner. With an idempotency key the owner is stable for retries within one MCP session only. */
export function guestOwner(cfg: Config, session: string, key?: string): string {
  return GUEST_PREFIX + createHmac("sha256", cfg.security.sessionSecret).update(`guest-create:${session}:${key ?? randomUUID()}`).digest("hex").slice(0, 40);
}
export function guestCapability(cfg: Config, row: Pick<CompositionRow, "id" | "owner">, mode: "read" | "edit"): string {
  const sig = createHmac("sha256", cfg.security.sessionSecret).update(`guest-project:${row.id}:${row.owner}:${mode}`).digest("base64url");
  return `${row.id}.${mode}.${sig}`;
}
const INVALID = () => new McpError("NOT_FOUND", "project not found or invalid project accessToken");
export function resolveGuestCapability(cfg: Config, store: McpStore, token: string): Principal & { compositionId: string; mode: "read" | "edit" } {
  if (!cfg.mcp.guestEnabled) throw new McpError("NOT_FOUND", "guest projects are disabled on this server");
  const [id, mode, sig, extra] = token.split(".");
  const row = store.getCompositionAny(id ?? "");
  if (!row || !isGuest(row.owner) || !sig || extra !== undefined || (mode !== "read" && mode !== "edit")) throw INVALID();
  const expected = Buffer.from(guestCapability(cfg, row, mode));
  const supplied = Buffer.from(token);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw INVALID();
  return { user: row.owner, via: "guest", compositionId: row.id, mode, scopes: mode === "edit" ? [...GUEST_EDIT_SCOPES] : [...GUEST_READ_SCOPES] };
}
