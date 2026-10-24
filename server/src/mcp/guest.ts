// Project capabilities authorize one guest composition, independently of MCP sessions.
// HMACs are domain-separated from OAuth/artifact credentials. Edit secrets are issued only
// in creation responses; read capabilities may appear in private Studio links.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.ts";
import type { CompositionRow, McpStore } from "./store.ts";
import { ALL_SCOPES, type Principal } from "./auth.ts";
import { McpError } from "./errors.ts";

export const isGuest = (owner: string) => owner.startsWith("guest:");
export function guestOwner(cfg: Config, session: string, key?: string): string {
  return `guest:${createHmac("sha256", cfg.security.sessionSecret).update(`guest-create:${session}:${key ?? randomUUID()}`).digest("hex")}`;
}
export function guestCapability(cfg: Config, row: CompositionRow, mode: "read" | "edit"): string {
  const sig = createHmac("sha256", cfg.security.sessionSecret).update(`guest-project:${row.id}:${row.owner}:${mode}`).digest("base64url");
  return `${row.id}.${mode}.${sig}`;
}
export function resolveGuestCapability(cfg: Config, store: McpStore, token: string): Principal & { compositionId: string } {
  const [id, mode, sig, extra] = token.split(".");
  const row = store.getCompositionAny(id ?? "");
  if (!row || !isGuest(row.owner) || !sig || extra !== undefined || (mode !== "read" && mode !== "edit"))
    throw new McpError("NOT_FOUND", "project not found or invalid project accessToken");
  const expected = Buffer.from(guestCapability(cfg, row, mode));
  const supplied = Buffer.from(token);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
    throw new McpError("NOT_FOUND", "project not found or invalid project accessToken");
  return { user: row.owner, via: "guest", compositionId: row.id,
    scopes: mode === "edit" ? [...ALL_SCOPES] : ["gbk:compositions.read", "gbk:artifacts.read"] };
}
